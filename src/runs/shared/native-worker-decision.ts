import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../../agents/agents.ts";
import { stableJsonDigest } from "../../shared/launch-contract.ts";
import { resolveEffectiveThinking, splitKnownThinkingSuffix, THINKING_LEVELS, type ModelInfo } from "../../shared/model-info.ts";
import { assertThinkingWithinCeiling, type ThinkingLevel } from "../../shared/thinking-ceiling.ts";
import {
	getWorkerDecisionAuthoritySnapshot, prepareWorkerDecision, WorkerDecisionAuthorityError,
	type AppliedWorkerDecision, type WorkerDecisionAuthoritySnapshot, type WorkerDecisionBaseline,
	type WorkerDecisionHost, type WorkerDecisionPair, type WorkerDecisionPolicyContext,
} from "../../shared/worker-decision-authority.ts";
import { checkModelScope, type ResolvedModelScope } from "./model-scope.ts";

export interface NativeWorkerConstraints {
	availableModels: ModelInfo[];
	modelScopes: ResolvedModelScope[];
	thinkingCeiling?: ThinkingLevel;
	/** Exact admission inputs, hashed with model support and scope for live revision fencing. */
	admission: unknown;
}
export interface NativeWorkerDecisionInput {
	sessionId: string;
	routing: WorkerDecisionAuthoritySnapshot;
	logicalLaunchId: string;
	agent: AgentConfig;
	task: string;
	context: "fresh" | "fork";
	originalModel?: string;
	originalThinking?: string | false;
	originalProvenance: "explicit-launch" | "host-effective";
	timeoutMs?: number;
	signal: AbortSignal;
	getConstraints(): NativeWorkerConstraints;
	/** Trusted executor admission only: no child creation, classification or pair substitution. */
	admit(pair: WorkerDecisionPair, constraints: NativeWorkerConstraints): void;
	/** Only an explicit trusted contract is fixed; a configured agent.model is not a lock. */
	modelContract?: WorkerDecisionPolicyContext["modelContract"];
}
export interface NativeWorkerDecision {
	readonly receipt: AppliedWorkerDecision;
	readonly deadlineAt: number;
	/** Each legitimate runtime attempt revalidates the commitment without another assessment. */
	revalidate(): Promise<void>;
	assertCurrent(): void;
}

/** Origin-process preparation only. Deferred runner/nested transport is not implemented here. */
export async function prepareNativeWorkerDecision(input: NativeWorkerDecisionInput): Promise<NativeWorkerDecision> {
	const routing = input.routing;
	if (routing.kind !== "active") throw new WorkerDecisionAuthorityError(routing.kind === "disposed" ? "session-disposed" : "owner-missing");
	const timeoutMs = input.timeoutMs;
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WorkerDecisionAuthorityError("invalid-deadline");
	// Anchor the actual resolved host duration once, before any owner work. Never borrow owner lifetime.
	const deadlineAt = Date.now() + timeoutMs;
	const revisions = () => ({ definitionRevision: stableJsonDigest(input.agent), constraintRevision: stableJsonDigest(input.getConstraints()) });
	const initial = input.getConstraints();
	const expected = revisions();
	const modelContract = input.modelContract ?? { kind: "selectable", models: initial.availableModels.filter((model) => model.api !== "pi-virtual").map((model) => model.fullId).filter((model) => !initial.modelScopes.some((scope) => checkModelScope(model, scope, "explicit")?.severity === "error")) };
	const baseline = (model: string | undefined, thinking: string | false | undefined, provenance: "explicit-launch" | "host-effective"): WorkerDecisionBaseline => {
		if (!model) return { kind: "unresolved", reason: "model-unresolved" };
		const effective = resolveEffectiveThinking(model, thinking);
		const physicalModel = splitKnownThinkingSuffix(model).baseModel;
		if (!effective || !support(physicalModel, input.getConstraints()).some((level) => level === effective)) return { kind: "unresolved", reason: "thinking-unresolved" };
		return { kind: "verified", model: physicalModel, thinking: effective as ThinkingLevel, provenance, ...expected };
	};
	const support = (model: string, constraints: NativeWorkerConstraints): ThinkingLevel[] => {
		const found = constraints.availableModels.find((entry) => entry.fullId === model && entry.api !== "pi-virtual");
		if (!found) return [];
		if (found.reasoning === false) return ["off"];
		// Unknown SDK/generic levels are not authoritative target evidence.
		return THINKING_LEVELS.filter((level) => found.thinkingLevelMap?.[level] !== undefined && found.thinkingLevelMap[level] !== null);
	};
	const validatePair = (pair: WorkerDecisionPair): Awaited<ReturnType<WorkerDecisionHost["validate"]>> => {
		const constraints = input.getConstraints();
		if (modelContract.kind === "fixed" ? pair.model !== modelContract.model : !modelContract.models.includes(pair.model)) return { kind: "blocked", reason: "scope-denied" };
		if (constraints.modelScopes.some((scope) => checkModelScope(pair.model, scope, "explicit")?.severity === "error")) return { kind: "blocked", reason: "scope-denied" };
		if (!constraints.availableModels.some((model) => model.fullId === pair.model && model.api !== "pi-virtual")) return { kind: "blocked", reason: "target-unavailable" };
		if (!support(pair.model, constraints).includes(pair.thinking)) return { kind: "blocked", reason: "unsupported-thinking" };
		try { assertThinkingWithinCeiling({ model: `${pair.model}:${pair.thinking}`, ceiling: constraints.thinkingCeiling }); }
		catch { return { kind: "blocked", reason: "ceiling-denied" }; }
		try { input.admit(pair, constraints); }
		catch { return { kind: "blocked", reason: "scope-denied" }; }
		return { kind: "valid" };
	};
	const host: WorkerDecisionHost = {
		getCurrentRevisions: revisions,
		async validate(pair) { return validatePair(pair); },
		async resolveTarget(model) {
			const constraints = input.getConstraints();
			const levels = support(model, constraints);
			if (!levels.length) return { kind: "unresolved", reason: "target-unavailable" };
			const admitted = validatePair({ model, thinking: levels[0]! });
			if (admitted.kind === "blocked") return { kind: "unresolved", reason: admitted.reason === "ceiling-denied" ? "ceiling-denied" : admitted.reason === "target-unavailable" ? "target-unavailable" : "scope-denied" };
			const sameOriginal = input.originalModel && splitKnownThinkingSuffix(input.originalModel).baseModel === model;
			return { kind: "resolved", model, supportedThinking: levels, baseline: baseline(sameOriginal ? input.originalModel : model, input.originalThinking, sameOriginal ? input.originalProvenance : "host-effective"), ...expected };
		},
	};
	const request = {
		sessionId: input.sessionId,
		control: { logicalLaunchId: input.logicalLaunchId, runtimeAttemptId: randomUUID(), ownerGeneration: routing.generation, context: input.context, launchDeadline: deadlineAt },
		facts: { task: input.task, ...(input.agent.description ? { role: { description: input.agent.description, provenance: "resolved-agent" as const } } : {}) },
		policyContext: { ...expected, modelContract, original: baseline(input.originalModel, input.originalThinking, input.originalProvenance) },
		classifierTimeoutMs: routing.assessmentTimeoutMs, signal: input.signal, host,
	};
	const guard = () => {
		const current = getWorkerDecisionAuthoritySnapshot(input.sessionId);
		if (current.kind !== "active" || current.generation !== routing.generation) throw new WorkerDecisionAuthorityError(current.kind === "disposed" ? "session-disposed" : "stale-owner");
		if (input.signal.aborted) throw new WorkerDecisionAuthorityError("cancelled");
		if (Date.now() >= Math.min(deadlineAt, routing.lifetimeDeadline)) throw new WorkerDecisionAuthorityError("deadline-exceeded");
	};
	const assertCurrent = () => {
		guard();
		const live = revisions();
		if (live.definitionRevision !== expected.definitionRevision || live.constraintRevision !== expected.constraintRevision) throw new WorkerDecisionAuthorityError("stale-revisions");
		guard();
	};
	const prepare = async () => {
		const result = await prepareWorkerDecision({ ...request, control: { ...request.control, runtimeAttemptId: randomUUID() } });
		if (result.kind !== "committed") throw new WorkerDecisionAuthorityError(result.kind === "blocked" ? result.reason : "owner-missing");
		assertCurrent();
		return result.receipt;
	};
	const receipt = await prepare();
	return { receipt, deadlineAt, assertCurrent, async revalidate() { await prepare(); } };
}

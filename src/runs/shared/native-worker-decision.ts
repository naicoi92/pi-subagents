import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../../agents/agents.ts";
import { stableJsonDigest } from "../../shared/launch-contract.ts";
import { resolveEffectiveThinking, splitKnownThinkingSuffix, THINKING_LEVELS, type ModelInfo } from "../../shared/model-info.ts";
import { assertThinkingWithinCeiling, type ThinkingLevel } from "../../shared/thinking-ceiling.ts";
import {
	getWorkerDecisionAuthoritySnapshot, prepareWorkerDecision, WorkerDecisionAuthorityError,
	type AppliedWorkerDecision, type WorkerDecisionAuthoritySnapshot, type WorkerDecisionBaseline,
	type WorkerDecisionHost, type WorkerDecisionPair, type WorkerDecisionPolicyContext, type WorkerToolMetadata, type WorkerToolIdentity, type WorkerAgentMetadata,
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
	callerTools?: readonly string[];
	availableTools?: readonly WorkerToolMetadata[];
	toolsIncomplete?: boolean;
	toolSelection?: "supported" | "unsupported";
	context: "fresh" | "fork";
	originalModel?: string;
	originalThinking?: string | false;
	originalProvenance: "explicit-launch" | "host-effective";
	comparison: WorkerDecisionPolicyContext["comparison"];
	timeoutMs?: number;
	signal: AbortSignal;
	getConstraints(): NativeWorkerConstraints;
	/** Trusted executor admission only: no child creation, classification or pair substitution. */
	admit(pair: WorkerDecisionPair, constraints: NativeWorkerConstraints, selectedTools?: readonly WorkerToolIdentity[]): void;
	/** Only an explicit trusted contract is fixed; a configured agent.model is not a lock. */
	modelContract?: WorkerDecisionPolicyContext["modelContract"];
}
export interface NativeWorkerDecision {
	readonly receipt: AppliedWorkerDecision;
	readonly deadlineAt: number;
	/** Each legitimate runtime attempt revalidates the commitment without another assessment. */
	revalidate(): Promise<void>;
	assertCurrent(): void;
	/** Reload live admission synchronously, then fence authority after all external checks. */
	assertAdmissible(): void;
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
	const validatePair = (pair: WorkerDecisionPair, selectedTools?: readonly WorkerToolIdentity[]): Awaited<ReturnType<WorkerDecisionHost["validate"]>> => {
		const constraints = input.getConstraints();
		if (modelContract.kind === "fixed" ? pair.model !== modelContract.model : !modelContract.models.includes(pair.model)) return { kind: "blocked", reason: "scope-denied" };
		if (constraints.modelScopes.some((scope) => checkModelScope(pair.model, scope, "explicit")?.severity === "error")) return { kind: "blocked", reason: "scope-denied" };
		if (!constraints.availableModels.some((model) => model.fullId === pair.model && model.api !== "pi-virtual")) return { kind: "blocked", reason: "target-unavailable" };
		if (!support(pair.model, constraints).includes(pair.thinking)) return { kind: "blocked", reason: "unsupported-thinking" };
		try { assertThinkingWithinCeiling({ model: `${pair.model}:${pair.thinking}`, ceiling: constraints.thinkingCeiling }); }
		catch { return { kind: "blocked", reason: "ceiling-denied" }; }
		try { input.admit(pair, constraints, selectedTools); }
		catch { return { kind: "blocked", reason: "scope-denied" }; }
		return { kind: "valid" };
	};
	const host: WorkerDecisionHost = {
		getCurrentRevisions: revisions,
		async validate(pair, _request, context) { return validatePair(pair, context.selectedTools); },
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
		facts: { task: input.task, ...(input.toolSelection !== undefined ? { toolSelection: input.toolSelection } : {}), ...(input.toolsIncomplete !== undefined ? { toolsIncomplete: input.toolsIncomplete } : {}), ...(input.availableTools !== undefined ? { tools: input.availableTools } : {}), ...(input.callerTools !== undefined ? { callerTools: input.callerTools } : {}), role: { name: input.agent.name, description: input.agent.description, provenance: "resolved-agent" as const }, agent: projectAgentMetadata(input.agent) },
		policyContext: { ...expected, modelContract, comparison: input.comparison, original: baseline(input.originalModel, input.originalThinking, input.originalProvenance) },
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
	return {
		receipt, deadlineAt, assertCurrent,
		assertAdmissible() {
			assertCurrent();
			const validation = validatePair(receipt, receipt.selectedTools);
			// Admission loads external policy; its callbacks cannot invalidate authority then launch.
			assertCurrent();
			if (validation.kind === "blocked") throw new WorkerDecisionAuthorityError(validation.reason);
		},
		async revalidate() { await prepare(); },
	};
}

/** Declared agent metadata for assessment. Bounded by the authority snapshot; the system prompt is reduced to its length. */
export function projectAgentMetadata(agent: AgentConfig): WorkerAgentMetadata {
 return {
  name: agent.name, source: agent.source, tools: agent.tools, excludeTools: agent.excludeTools, skills: agent.skills,
  mutationTools: agent.mutationTools, allowedAgents: agent.allowedAgents, allowNestedSubagents: agent.allowNestedSubagents,
  defaultContext: agent.defaultContext, model: agent.model, thinking: agent.thinking, interactive: agent.interactive,
  systemPromptMode: agent.systemPromptMode, systemPromptChars: typeof agent.systemPrompt === "string" ? agent.systemPrompt.length : undefined,
 };
}

/** Tools the child session can never be granted: hidden/model-only exposure, or registered inline rather than from a file. */
function isGrantableHostTool(tool: { exposure?: string; sourceInfo?: { path?: string } }): boolean {
 if (tool.exposure === "hidden" || tool.exposure === "model-only") return false;
 const sourcePath = tool.sourceInfo?.path;
 return sourcePath === undefined || !sourcePath.startsWith("<");
}

/**
 * Omit structurally invalid host records (missing/empty/NUL fields). Size and count never exclude a tool.
 * Tools the child can never be granted are left out too, so the inventory matches what a child can actually receive.
 */
export function projectHostToolMetadata(tools: readonly { name: string; description: string; exposure?: string; namespace?: { name: string }; sourceInfo?: { path?: string } }[] | undefined): { availableTools?: WorkerToolMetadata[]; toolsIncomplete?: boolean } {
 if (tools === undefined) return {};
 const availableTools: WorkerToolMetadata[] = [];
 let incomplete = false;
 for (const tool of tools) {
  if (tool && !isGrantableHostTool(tool)) continue;
  const fields = [tool?.name, tool?.description, tool?.namespace?.name, tool?.sourceInfo?.path];
  if (fields.some((value, index) => value === undefined ? index < 2 : typeof value !== "string" || !value || value.includes("\0"))) { incomplete = true; continue; }
  availableTools.push({ name: tool.name, description: tool.description, ...(tool.namespace?.name !== undefined ? { namespace: tool.namespace.name } : {}), ...(tool.sourceInfo?.path !== undefined ? { sourcePath: tool.sourceInfo.path } : {}) });
 }
 return { availableTools, toolsIncomplete: incomplete };
}

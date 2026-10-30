import { isBoundedCallerTools } from "./caller-tools.ts";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "./model-info.ts";

export type WorkerDecisionReason = "assessed" | "verified-original-retained" | "verified-target-retained";
export type WorkerDecisionBlockReason =
	| "owner-conflict" | "owner-missing" | "stale-owner" | "session-disposed"
	| "cancelled" | "deadline-exceeded" | "invalid-deadline" | "invalid-request"
	| "invalid-decision" | "assessment-unavailable" | "baseline-unresolved"
	| "scope-denied" | "ceiling-denied" | "target-unavailable" | "unsupported-thinking"
	| "stale-revisions" | "identity-conflict" | "consumed-indeterminate" | "capacity-exceeded";

export class WorkerDecisionAuthorityError extends Error {
	readonly reason: WorkerDecisionBlockReason;
	constructor(reason: WorkerDecisionBlockReason) {
		super(`Worker decision authority blocked: ${reason}.`);
		this.name = "WorkerDecisionAuthorityError";
		this.reason = reason;
	}
}

export interface WorkerDecisionPair { readonly model: string; readonly thinking: ThinkingLevel }
export interface WorkerDecisionRevisions { readonly definitionRevision: string; readonly constraintRevision: string }
export type WorkerDecisionBaseline =
	| (WorkerDecisionPair & WorkerDecisionRevisions & { readonly kind: "verified"; readonly provenance: "host-effective" | "explicit-launch" })
	| { readonly kind: "unresolved"; readonly reason: "model-unresolved" | "thinking-unresolved" | "provenance-unresolved" };

export interface WorkerToolIdentity { readonly name: string; readonly namespace?: string; readonly sourcePath?: string }
export interface WorkerToolMetadata extends WorkerToolIdentity { readonly description: string }

/** Only this explicit factual projection is suitable for assessment; policyContext is private to the owner. */
export interface WorkerDecisionFacts {
	readonly task: string;
	readonly tools?: readonly WorkerToolMetadata[];
	readonly toolsIncomplete?: boolean;
	readonly toolSelection?: "supported" | "unsupported";
	readonly callerTools?: readonly string[];
	readonly role?: {
		/** Exact resolved definition name; only valid with resolved-agent provenance. */
		readonly name?: string;
		readonly description: string;
		readonly provenance: "resolved-agent" | "authored-task";
	};
	readonly capabilities?: readonly { readonly description: string; readonly provenance: "host" | "resolved-agent" }[];
}
/** Model identity for policy comparison only, never an execution-retention pair. */
export type WorkerDecisionComparison =
	| { readonly kind: "resolved"; readonly model: string; readonly provenance: "explicit-caller" | "parent" }
	| { readonly kind: "unresolved"; readonly reason: "model-unresolved" };
export interface WorkerDecisionPolicyContext extends WorkerDecisionRevisions {
	readonly modelContract: { readonly kind: "fixed"; readonly model: string } | { readonly kind: "selectable"; readonly models: readonly string[] };
	/** Explicit caller model, otherwise captured parent model; independent of agent defaults and thinking overrides. */
	readonly comparison: WorkerDecisionComparison;
	readonly original: WorkerDecisionBaseline;
}
export interface WorkerDecisionControl {
	readonly logicalLaunchId: string;
	/** Correlation only; changing attempts never grants another assessment. */
	readonly runtimeAttemptId: string;
	readonly ownerGeneration?: string;
	readonly context: "fresh" | "fork";
	readonly launchDeadline?: number;
}
export interface WorkerDecisionRequest {
	readonly control: WorkerDecisionControl;
	readonly facts: WorkerDecisionFacts;
	readonly policyContext: WorkerDecisionPolicyContext;
}
export type WorkerDecision =
	| (WorkerDecisionPair & { readonly kind: "apply"; readonly requestedThinking?: ThinkingLevel; readonly reason: WorkerDecisionReason; readonly selectedTools?: readonly WorkerToolIdentity[]; readonly toolWarnings?: readonly string[] })
	| { readonly kind: "reject"; readonly reason: "cancelled" | "assessment-unavailable" | "baseline-unresolved" | "scope-denied" | "ceiling-denied" | "target-unavailable" };
export type WorkerDecisionTarget =
	| (WorkerDecisionRevisions & { readonly kind: "resolved"; readonly model: string; readonly supportedThinking: readonly ThinkingLevel[]; readonly baseline: WorkerDecisionBaseline })
	| { readonly kind: "unresolved"; readonly reason: "target-unavailable" | "baseline-unresolved" | "scope-denied" | "ceiling-denied" };
export interface WorkerDecisionContext {
	readonly signal: AbortSignal;
	/** Classifier cutoff does not expire authority or authorize executor fallback. */
	readonly assessmentCutoff: number;
	readonly hardDeadline: number;
	readonly assessmentAvailable: boolean;
	resolveTarget(model: string): Promise<WorkerDecisionTarget>;
}
export interface AppliedWorkerDecision extends WorkerDecisionPair, WorkerDecisionRevisions {
	readonly logicalLaunchId: string;
	readonly ownerGeneration: string;
	readonly requestedThinking?: ThinkingLevel;
	readonly reason: WorkerDecisionReason;
	readonly selectedTools?: readonly WorkerToolIdentity[];
	readonly toolWarnings?: readonly string[];
	readonly callerTools?: readonly string[];
	readonly digest: string;
}
export const SUBAGENT_WORKER_DECISION_ACCEPTED_EVENT = "subagent:worker-decision-accepted";
/** Receipt-to-leaf binding only, not proof of child execution. No task or request payload. */
export interface SubagentWorkerDecisionAcceptedEvent {
	readonly version: 1;
	readonly sessionId: string;
	/** Originating public tool call, shared by workflow siblings; not recursive internal execution ID. */
	readonly toolCallId: string;
	/** Actual leaf run ID, never the workflow aggregate. */
	readonly runId: string;
	readonly logicalLaunchId: string;
	readonly receipt: AppliedWorkerDecision;
	readonly parentWorkflowRunId?: string;
	readonly workflowKey?: string;
}
export interface WorkerDecisionAuthority {
	decide(request: WorkerDecisionRequest, context: WorkerDecisionContext): Promise<WorkerDecision>;
	/** Logical commitment only, never proof of spawn or provider execution. Invoked at most once. */
	onApplied?(receipt: AppliedWorkerDecision): void;
}
export interface RegisterWorkerDecisionAuthorityInput {
	sessionId: string;
	lifetimeDeadline: number;
	/** Owner's authoritative assessment budget; zero allows only unavailable-assessment handling. */
	assessmentTimeoutMs: number;
	authority: WorkerDecisionAuthority;
}
export interface WorkerDecisionAuthorityRegistration { readonly generation: string; dispose(): void }
export type WorkerDecisionAuthoritySnapshot =
	| { readonly kind: "never-owned" }
	| { readonly kind: "active"; readonly generation: string; readonly lifetimeDeadline: number; readonly assessmentTimeoutMs: number }
	| { readonly kind: "missing" }
	| { readonly kind: "disposed" };

/** Host callbacks must be side-effect-free: no child/session creation or inference. */
export interface WorkerDecisionHost {
	getCurrentRevisions(): WorkerDecisionRevisions;
	resolveTarget(model: string, request: WorkerDecisionRequest, context: { signal: AbortSignal; hardDeadline: number }): Promise<WorkerDecisionTarget>;
	/** Authoritatively check exact physical ID, support, scope, ceilings, availability and launch admission. Never substitute a pair. */
	validate(pair: WorkerDecisionPair, request: WorkerDecisionRequest, context: { signal: AbortSignal; hardDeadline: number; selectedTools?: readonly WorkerToolIdentity[] }): Promise<{ kind: "valid" } | { kind: "blocked"; reason: "scope-denied" | "ceiling-denied" | "target-unavailable" | "unsupported-thinking" | "stale-revisions" }>;
}
export interface WorkerDecisionClock {
	now(): number;
	/** Schedule at absolute deadline; return cancellation. Deterministic fixtures need not sleep. */
	schedule(deadline: number, callback: () => void): () => void;
}
export interface PrepareWorkerDecisionInput extends WorkerDecisionRequest {
	sessionId: string;
	/** Per-request tightening cap; cannot extend the registered owner's assessmentTimeoutMs. */
	classifierTimeoutMs: number;
	signal?: AbortSignal;
	host: WorkerDecisionHost;
	clock?: WorkerDecisionClock;
}
export type PreparedWorkerDecision =
	| { readonly kind: "unowned" }
	| { readonly kind: "blocked"; readonly reason: WorkerDecisionBlockReason }
	| { readonly kind: "committed"; readonly receipt: AppliedWorkerDecision; readonly notification?: "failed" };
export type WorkerDecisionState =
	| { readonly kind: "unconsumed" }
	| { readonly kind: "consumed"; readonly state: "pending" | "indeterminate" | "blocked" }
	| { readonly kind: "committed"; readonly receipt: AppliedWorkerDecision };

interface Owner { generation: string; lifetimeDeadline: number; assessmentTimeoutMs: number; authority: WorkerDecisionAuthority; controller: AbortController }
interface Entry {
	binding: string;
	state: "pending" | "indeterminate" | "blocked" | "committed";
	promise: Promise<PreparedWorkerDecision>;
	receipt?: AppliedWorkerDecision;
}
interface Session { owner?: Owner; disposed: boolean; ledger: Map<string, Entry> }
interface Registry { version: 1; sessions: Map<string, Session> }
/** Process-lifetime admission bounds. Consumed identities are never evicted to reopen assessment. */
export const WORKER_DECISION_AUTHORITY_LIMITS = Object.freeze({
	retainedSessions: 256,
	entriesPerSession: 256,
	totalEntries: 4096,
	idBytes: 256,
});
const RESOLUTION_RESERVE_MS = 500;
const REASONS: readonly WorkerDecisionReason[] = ["assessed", "verified-original-retained", "verified-target-retained"];
const OWNER_REJECTIONS = ["cancelled", "assessment-unavailable", "baseline-unresolved", "scope-denied", "ceiling-denied", "target-unavailable"] as const;
const defaultClock: WorkerDecisionClock = {
	now: Date.now,
	schedule(deadline, callback) {
		// Node timers overflow beyond 2^31-1 ms; re-arm without expiring authority early.
		let timer: ReturnType<typeof setTimeout>;
		const arm = () => { const remaining = deadline - Date.now(); if (remaining <= 0) callback(); else timer = setTimeout(arm, Math.min(remaining, 2147483647)); };
		arm();
		return () => clearTimeout(timer);
	},
};

function registry(): Registry {
	const key = Symbol.for("pi-subagents.worker-decision-authority.v1");
	const root = globalThis as Record<PropertyKey, unknown>;
	if (root[key] === undefined) root[key] = { version: 1, sessions: new Map() } satisfies Registry;
	const value = root[key];
	if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("sessions" in value) || !(value.sessions instanceof Map)) throw new Error("Malformed or unsupported worker decision authority registry.");
	return value as Registry;
}
function fail(reason: WorkerDecisionBlockReason): never { throw new WorkerDecisionAuthorityError(reason); }
function assertId(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value || value.trim() !== value || value.includes("\0") || Buffer.byteLength(value, "utf8") > WORKER_DECISION_AUTHORITY_LIMITS.idBytes) fail("invalid-request");
}
function createSession(sessions: Map<string, Session>, sessionId: string, disposed: boolean): Session {
	if (sessions.size >= WORKER_DECISION_AUTHORITY_LIMITS.retainedSessions) fail("capacity-exceeded");
	const session: Session = { disposed, ledger: new Map() };
	sessions.set(sessionId, session);
	return session;
}
function hasEntryCapacity(sessions: Map<string, Session>, session: Session): boolean {
	if (session.ledger.size >= WORKER_DECISION_AUTHORITY_LIMITS.entriesPerSession) return false;
	let total = 0;
	for (const retained of sessions.values()) total += retained.ledger.size;
	return total < WORKER_DECISION_AUTHORITY_LIMITS.totalEntries;
}
function isThinking(value: unknown): value is ThinkingLevel { return THINKING_LEVELS.some((level) => value === level); }
function isPhysicalModel(value: unknown): value is string {
	return typeof value === "string" && /^[^\s/\0]+\/[^\s\0]+$/.test(value) && !THINKING_LEVELS.some((level) => value.endsWith(`:${level}`));
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function text(value: unknown): string {
	if (typeof value !== "string") fail("invalid-request");
	return value;
}
function revision(value: unknown): string {
	const result = text(value);
	if (!result || result.includes("\0")) fail("invalid-request");
	return result;
}
function snapshotPolicyContext(policy: WorkerDecisionPolicyContext): WorkerDecisionPolicyContext {
	const definitionRevision = revision(policy.definitionRevision);
	const constraintRevision = revision(policy.constraintRevision);
	const contract = policy.modelContract;
	let modelContract: WorkerDecisionPolicyContext["modelContract"];
	if (contract.kind === "fixed") {
		if (!isPhysicalModel(contract.model)) fail("invalid-request");
		modelContract = { kind: "fixed", model: contract.model };
	} else if (contract.kind === "selectable" && Array.isArray(contract.models) && contract.models.every(isPhysicalModel)) {
		modelContract = { kind: "selectable", models: contract.models.map((model) => model) };
	} else fail("invalid-request");
	const comparisonInput = policy.comparison;
	let comparison: WorkerDecisionComparison;
	if (comparisonInput.kind === "resolved" && isPhysicalModel(comparisonInput.model) && ["explicit-caller", "parent"].includes(comparisonInput.provenance)) {
		comparison = { kind: "resolved", model: comparisonInput.model, provenance: comparisonInput.provenance };
	} else if (comparisonInput.kind === "unresolved" && comparisonInput.reason === "model-unresolved") {
		comparison = { kind: "unresolved", reason: "model-unresolved" };
	} else fail("invalid-request");
	const baseline = policy.original;
	let original: WorkerDecisionBaseline;
	if (baseline.kind === "verified") {
		if (!isPhysicalModel(baseline.model) || !isThinking(baseline.thinking) || !["host-effective", "explicit-launch"].includes(baseline.provenance)) fail("invalid-request");
		original = { kind: "verified", model: baseline.model, thinking: baseline.thinking, provenance: baseline.provenance, definitionRevision: revision(baseline.definitionRevision), constraintRevision: revision(baseline.constraintRevision) };
	} else if (baseline.kind === "unresolved" && ["model-unresolved", "thinking-unresolved", "provenance-unresolved"].includes(baseline.reason)) {
		original = { kind: "unresolved", reason: baseline.reason };
	} else fail("invalid-request");
	return { definitionRevision, constraintRevision, modelContract, comparison, original };
}
export function isBoundedWorkerToolWarnings(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === "string" && !!item && !item.includes("\0") && Buffer.byteLength(item) <= 512);
}
/**
 * Persisted selected-tool grants (runner config, recovery descriptor). Same bounds as the live
 * decision snapshot, plus an absolute `sourcePath`: a grant without a file-backed source can never
 * be honoured, so it is rejected at the persistence boundary instead of at child launch.
 */
export function isBoundedWorkerSelectedTools(value: unknown): value is WorkerToolIdentity[] {
	if (!Array.isArray(value) || value.length > 256) return false;
	let bytes = 0;
	const bounded = (item: unknown): item is string => {
		if (typeof item !== "string" || !item || item.includes("\0") || Buffer.byteLength(item) > 1024) return false;
		bytes += Buffer.byteLength(item);
		return true;
	};
	return value.every((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const { name, namespace, sourcePath } = entry as Record<string, unknown>;
		return bounded(name)
			&& (namespace === undefined || bounded(namespace))
			&& bounded(sourcePath) && isAbsolute(sourcePath);
	}) && bytes <= 65536;
}
function snapshotToolWarnings(value: unknown): readonly string[] {
	if (!isBoundedWorkerToolWarnings(value)) fail("invalid-decision");
	return Object.freeze([...value]);
}
function snapshotToolList(value: unknown, metadata: boolean, reason: "invalid-request" | "invalid-decision"): WorkerToolMetadata[] {
 if (!Array.isArray(value)) fail(reason);
 const field = (v: unknown, required: boolean): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !v || v.includes("\0")) fail(reason);
  return v;
 };
 return value.map((entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(reason);
  const name = field(entry.name, true)!;
  const namespace = field(entry.namespace, false);
  const sourcePath = field(entry.sourcePath, false);
  const description = metadata ? field(entry.description, true)! : "";
  return { name, ...(namespace !== undefined ? { namespace } : {}), ...(sourcePath !== undefined ? { sourcePath } : {}), ...(metadata ? { description } : {}) } as WorkerToolMetadata;
 });
}
function snapshotCallerTools(value: unknown): string[] {
 if (!isBoundedCallerTools(value)) fail("invalid-request");
 return [...value];
}
function snapshotRequest(input: PrepareWorkerDecisionInput): WorkerDecisionRequest {
	const { control, facts, policyContext } = input;
	if (!["fresh", "fork"].includes(control.context)) fail("invalid-request");
	// Named-field projection fixes record order and excludes undeclared config/policy extras.
	if (facts.toolsIncomplete !== undefined && typeof facts.toolsIncomplete !== "boolean") fail("invalid-request");
	if (facts.toolSelection !== undefined && facts.toolSelection !== "supported" && facts.toolSelection !== "unsupported") fail("invalid-request");
	const projected: WorkerDecisionFacts = {
		task: text(facts.task),
		...(facts.toolsIncomplete !== undefined ? { toolsIncomplete: facts.toolsIncomplete } : {}),
		...(facts.toolSelection !== undefined ? { toolSelection: facts.toolSelection } : {}),
		...(facts.tools !== undefined ? { tools: snapshotToolList(facts.tools, true, "invalid-request") } : {}),
		...(facts.callerTools !== undefined ? { callerTools: snapshotCallerTools(facts.callerTools) } : {}),
		...(facts.role !== undefined ? { role: { ...(facts.role.name !== undefined ? { name: text(facts.role.name) } : {}), description: text(facts.role.description), provenance: facts.role.provenance } } : {}),
		...(facts.capabilities !== undefined ? { capabilities: facts.capabilities.map(({ description, provenance }) => ({ description: text(description), provenance })) } : {}),
	};
	if (projected.role && !["resolved-agent", "authored-task"].includes(projected.role.provenance)) fail("invalid-request");
	if (projected.role?.name !== undefined && (!projected.role.name || projected.role.name.includes("\0") || projected.role.provenance !== "resolved-agent")) fail("invalid-request");
	if (projected.capabilities?.some((capability) => !["host", "resolved-agent"].includes(capability.provenance))) fail("invalid-request");
	return freeze({ control: { logicalLaunchId: control.logicalLaunchId, runtimeAttemptId: control.runtimeAttemptId, ownerGeneration: control.ownerGeneration, context: control.context, launchDeadline: control.launchDeadline }, facts: projected, policyContext: snapshotPolicyContext(policyContext) });
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
	return value;
}

/** Register one originating-session owner. Disposing aborts callbacks but retains consumed logical identities. */
export function registerWorkerDecisionAuthority(input: RegisterWorkerDecisionAuthorityInput): WorkerDecisionAuthorityRegistration {
	assertId(input.sessionId);
	if (!Number.isFinite(input.lifetimeDeadline)) throw new Error("Worker decision authority requires a finite lifetimeDeadline.");
	if (!Number.isFinite(input.assessmentTimeoutMs) || input.assessmentTimeoutMs < 0) throw new Error("Worker decision authority requires a finite nonnegative assessmentTimeoutMs.");
	if (!input.authority || typeof input.authority.decide !== "function") throw new Error("Worker decision authority requires a decide callback.");
	const sessions = registry().sessions;
	let session = sessions.get(input.sessionId);
	if (session?.disposed) throw new WorkerDecisionAuthorityError("session-disposed");
	if (session?.owner) throw new WorkerDecisionAuthorityError("owner-conflict");
	if (!session) session = createSession(sessions, input.sessionId, false);
	const owner: Owner = { generation: randomUUID(), lifetimeDeadline: input.lifetimeDeadline, assessmentTimeoutMs: input.assessmentTimeoutMs, authority: { decide: input.authority.decide.bind(input.authority), onApplied: input.authority.onApplied?.bind(input.authority) }, controller: new AbortController() };
	session.owner = owner;
	return Object.freeze({ generation: owner.generation, dispose() { if (session.owner === owner) { session.owner = undefined; owner.controller.abort(); } } });
}

/** Fencing metadata only. A read miss never allocates retained session state. */
export function getWorkerDecisionAuthoritySnapshot(sessionId: string): WorkerDecisionAuthoritySnapshot {
	assertId(sessionId);
	const session = registry().sessions.get(sessionId);
	if (!session) return Object.freeze({ kind: "never-owned" });
	if (session.disposed) return Object.freeze({ kind: "disposed" });
	const owner = session.owner;
	if (!owner) return Object.freeze({ kind: "missing" });
	return Object.freeze({ kind: "active", generation: owner.generation, lifetimeDeadline: owner.lifetimeDeadline, assessmentTimeoutMs: owner.assessmentTimeoutMs });
}

/** Nonterminal invalidation: abort only the captured generation, retaining all consumed identities. */
export function invalidateWorkerDecisionAuthority(sessionId: string, generation: string): boolean {
	assertId(sessionId);
	assertId(generation);
	const session = registry().sessions.get(sessionId);
	const owner = session?.owner;
	if (!session || session.disposed || !owner || owner.generation !== generation) return false;
	session.owner = undefined;
	owner.controller.abort();
	return true;
}

/** Mark session terminal; retain tombstones so disposal cannot reset assessment consumption. */
export function disposeWorkerDecisionSession(sessionId: string): void {
	assertId(sessionId);
	const sessions = registry().sessions;
	let session = sessions.get(sessionId);
	if (!session) session = createSession(sessions, sessionId, true);
	session.disposed = true;
	session.owner?.controller.abort();
	session.owner = undefined;
}

/** In-memory evidence only: restoring a consumed claim without a decision must block, never reclassify. */
export function getWorkerDecisionState(sessionId: string, logicalLaunchId: string): WorkerDecisionState {
	assertId(sessionId);
	assertId(logicalLaunchId);
	const entry = registry().sessions.get(sessionId)?.ledger.get(logicalLaunchId);
	if (!entry) return { kind: "unconsumed" };
	return entry.receipt ? { kind: "committed", receipt: entry.receipt } : { kind: "consumed", state: entry.state as "pending" | "indeterminate" | "blocked" };
}

/** Claim before callback; duplicates join/reuse. No classifier, fallback selection or native launch occurs here. */
export async function prepareWorkerDecision(input: PrepareWorkerDecisionInput): Promise<PreparedWorkerDecision> {
	try {
		assertId(input.sessionId);
		assertId(input.control.logicalLaunchId);
		assertId(input.control.runtimeAttemptId);
		if (input.control.ownerGeneration !== undefined) assertId(input.control.ownerGeneration);
	} catch { return { kind: "blocked", reason: "invalid-request" }; }
	const session = registry().sessions.get(input.sessionId);
	if (!session) return input.control.ownerGeneration ? { kind: "blocked", reason: "owner-missing" } : { kind: "unowned" };
	if (session.disposed) return { kind: "blocked", reason: "session-disposed" };
	const owner = session.owner;
	if (!owner) return { kind: "blocked", reason: "owner-missing" };
	if (input.control.ownerGeneration !== owner.generation) return { kind: "blocked", reason: "stale-owner" };
	const clock = input.clock ?? defaultClock;
	const admittedAt = clock.now();
	const deadlines = [owner.lifetimeDeadline, input.control.launchDeadline].filter((value): value is number => value !== undefined && Number.isFinite(value));
	const hardDeadline = Math.min(...deadlines);
	if (!Number.isFinite(hardDeadline) || (input.control.launchDeadline !== undefined && !Number.isFinite(input.control.launchDeadline)) || !Number.isFinite(input.classifierTimeoutMs) || input.classifierTimeoutMs < 0) return { kind: "blocked", reason: "invalid-deadline" };
	let existing = session.ledger.get(input.control.logicalLaunchId);
	if (!existing && !hasEntryCapacity(registry().sessions, session)) return { kind: "blocked", reason: "capacity-exceeded" };
	let request: WorkerDecisionRequest;
	try { request = snapshotRequest(input); } catch { return { kind: "blocked", reason: "invalid-request" }; }
	const binding = digest({ facts: request.facts, policyContext: request.policyContext, context: request.control.context });
	existing = session.ledger.get(request.control.logicalLaunchId);
	if (existing && existing.binding !== binding) return { kind: "blocked", reason: "identity-conflict" };
	if (existing?.state === "indeterminate") return { kind: "blocked", reason: "consumed-indeterminate" };
	if (input.signal?.aborted) return { kind: "blocked", reason: "cancelled" };
	if (clock.now() >= hardDeadline) return { kind: "blocked", reason: "deadline-exceeded" };
	if (existing && !existing.receipt) return joinPending(existing.promise, input.signal, clock, hardDeadline);
	const entry: Entry = existing ?? { binding, state: "pending", promise: Promise.resolve({ kind: "blocked", reason: "consumed-indeterminate" }) };
	// This synchronous claim survives owner/revision changes; only the first claimant invokes decide.
	if (!existing) {
		if (!hasEntryCapacity(registry().sessions, session)) return { kind: "blocked", reason: "capacity-exceeded" };
		session.ledger.set(request.control.logicalLaunchId, entry);
	}
	const promise = runPreparation(input, request, session, owner, entry, clock, admittedAt, hardDeadline, existing?.receipt);
	if (!existing) entry.promise = promise;
	return promise;
}

async function runPreparation(input: PrepareWorkerDecisionInput, request: WorkerDecisionRequest, session: Session, owner: Owner, entry: Entry, clock: WorkerDecisionClock, admittedAt: number, hardDeadline: number, retained?: AppliedWorkerDecision): Promise<PreparedWorkerDecision> {
	const controller = new AbortController();
	const guard = () => {
		if (session.disposed) fail("session-disposed");
		if (session.owner !== owner || owner.controller.signal.aborted) fail("stale-owner");
		if (input.signal?.aborted || controller.signal.aborted) fail("cancelled");
		if (clock.now() >= hardDeadline) fail("deadline-exceeded");
	};
	const check = () => {
		guard();
		const revisions = input.host.getCurrentRevisions();
		if (revisions.definitionRevision !== request.policyContext.definitionRevision || revisions.constraintRevision !== request.policyContext.constraintRevision) fail("stale-revisions");
		guard();
	};
	let cancelTimer = () => {};
	let onOwnerAbort = () => {};
	let onCancel = () => {};
	try {
		check();
		const interrupted = new Promise<never>((_, reject) => {
			const stop = (reason: WorkerDecisionBlockReason) => {
				// Commitment wins over observer-triggered disposal; it cannot be rolled back.
				if (entry.receipt && !retained) return;
				controller.abort();
				reject(new WorkerDecisionAuthorityError(reason));
			};
			onOwnerAbort = () => stop(session.disposed ? "session-disposed" : "stale-owner");
			onCancel = () => stop("cancelled");
			owner.controller.signal.addEventListener("abort", onOwnerAbort, { once: true });
			input.signal?.addEventListener("abort", onCancel, { once: true });
			cancelTimer = clock.schedule(hardDeadline, () => stop("deadline-exceeded"));
		});
		const assessmentCutoff = Math.min(admittedAt + Math.min(owner.assessmentTimeoutMs, input.classifierTimeoutMs), hardDeadline - RESOLUTION_RESERVE_MS);
		const context: WorkerDecisionContext = Object.freeze({
			signal: controller.signal, assessmentCutoff, hardDeadline, assessmentAvailable: clock.now() < assessmentCutoff,
			async resolveTarget(model: string): Promise<WorkerDecisionTarget> {
				check();
				if (!isPhysicalModel(model)) fail("invalid-decision");
				const target = await Promise.race([input.host.resolveTarget(model, request, { signal: controller.signal, hardDeadline }), interrupted]);
				check();
				if (target.kind === "resolved" && (target.model !== model || target.definitionRevision !== request.policyContext.definitionRevision || target.constraintRevision !== request.policyContext.constraintRevision)) fail("stale-revisions");
				const snapshot = freeze(structuredClone(target));
				guard();
				return snapshot;
			},
		});
		const work = async (): Promise<PreparedWorkerDecision> => {
			// Yield until claim.promise is installed, including for reentrant callbacks.
			await Promise.resolve();
			check();
			const rawReply: unknown = retained ?? await owner.authority.decide(request, context);
			check();
			if (!rawReply || typeof rawReply !== "object" || Array.isArray(rawReply)) fail("invalid-decision");
			const reply = structuredClone(rawReply) as WorkerDecision | AppliedWorkerDecision;
			if (!retained && "kind" in reply && reply.kind === "reject") {
				if (!OWNER_REJECTIONS.some((reason) => reason === reply.reason)) fail("invalid-decision");
				fail(reply.reason);
			}
			if (!retained && (!("kind" in reply) || reply.kind !== "apply")) fail("invalid-decision");
			if (!("model" in reply) || !("thinking" in reply) || !isPhysicalModel(reply.model) || !isThinking(reply.thinking) || !REASONS.some((reason) => reason === reply.reason) || ("requestedThinking" in reply && reply.requestedThinking !== undefined && !isThinking(reply.requestedThinking))) fail("invalid-decision");
			const selectedTools = "selectedTools" in reply && reply.selectedTools !== undefined ? freeze(snapshotToolList(reply.selectedTools, false, "invalid-decision")) : undefined;
			const toolWarnings = "toolWarnings" in reply && reply.toolWarnings !== undefined ? snapshotToolWarnings(reply.toolWarnings) : undefined;
			if (selectedTools && selectedTools.some((tool) => !request.facts.tools?.some((candidate) => candidate.name === tool.name && candidate.namespace === tool.namespace && candidate.sourcePath === tool.sourcePath))) fail("invalid-decision");
			const selected = Object.freeze({ model: reply.model, thinking: reply.thinking });
			guard();
			const validated = await input.host.validate(selected, request, { signal: controller.signal, hardDeadline, ...(selectedTools !== undefined ? { selectedTools } : {}) });
			check();
			if (validated.kind !== "valid") fail(validated.reason);
			if (retained) { guard(); return { kind: "committed", receipt: retained }; }
			const content = { ...selected, ...(selectedTools !== undefined ? { selectedTools } : {}), ...(toolWarnings !== undefined ? { toolWarnings } : {}), ...(request.facts.callerTools !== undefined ? { callerTools: request.facts.callerTools } : {}), logicalLaunchId: request.control.logicalLaunchId, ownerGeneration: owner.generation, definitionRevision: request.policyContext.definitionRevision, constraintRevision: request.policyContext.constraintRevision, reason: reply.reason as WorkerDecisionReason, ...("requestedThinking" in reply && reply.requestedThinking ? { requestedThinking: reply.requestedThinking as ThinkingLevel } : {}) };
			const receipt: AppliedWorkerDecision = freeze({ ...content, digest: digest(content) });
			// No host callback, serialization or hashing between final authority fence and ledger mutation.
			guard();
			entry.receipt = receipt;
			entry.state = "committed";
			try { owner.authority.onApplied?.(receipt); } catch { return { kind: "committed", receipt, notification: "failed" }; }
			return { kind: "committed", receipt };
		};
		return await Promise.race([work(), interrupted]);
	} catch (error) {
		const reason = error instanceof WorkerDecisionAuthorityError ? error.reason : "consumed-indeterminate";
		if (!retained) entry.state = reason === "consumed-indeterminate" ? "indeterminate" : "blocked";
		return { kind: "blocked", reason };
	} finally {
		cancelTimer();
		owner.controller.signal.removeEventListener("abort", onOwnerAbort);
		input.signal?.removeEventListener("abort", onCancel);
		controller.abort();
	}
}

async function joinPending(pending: Promise<PreparedWorkerDecision>, signal: AbortSignal | undefined, clock: WorkerDecisionClock, hardDeadline: number): Promise<PreparedWorkerDecision> {
	let cancelTimer = () => {};
	let onCancel = () => {};
	try {
		return await Promise.race([pending, new Promise<PreparedWorkerDecision>((resolve) => {
			onCancel = () => resolve({ kind: "blocked", reason: "cancelled" });
			signal?.addEventListener("abort", onCancel, { once: true });
			cancelTimer = clock.schedule(hardDeadline, () => resolve({ kind: "blocked", reason: "deadline-exceeded" }));
		})]);
	} finally { cancelTimer(); signal?.removeEventListener("abort", onCancel); }
}

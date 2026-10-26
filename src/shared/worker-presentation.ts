import type { SubagentWorkerDecisionAcceptedEvent } from "./worker-decision-authority.ts";

export interface WorkerPresentationRegistration {
	/** Call only after accepting responsibility for this exact leaf's summary and details. */
	acknowledge(accepted: SubagentWorkerDecisionAcceptedEvent): boolean;
	dispose(): void;
}
interface Owner { sessionId: string; leaves: Set<string> }
interface Registry {
	owners: Map<string, Owner>;
	issued: WeakMap<object, Owner>;
	messages: WeakMap<object, Array<{ owner: Owner; runId: string }>>;
	listeners: Set<(sessionId: string) => void>;
}
function registry(): Registry {
	const key = Symbol.for("pi-subagents.worker-presentation.v1");
	const root = globalThis as Record<PropertyKey, unknown>;
	return (root[key] ??= { owners: new Map(), issued: new WeakMap(), messages: new WeakMap(), listeners: new Set() }) as Registry;
}
function changed(sessionId: string): void {
	for (const listener of registry().listeners) {
		try { listener(sessionId); } catch { /* Presentation observers cannot affect execution. */ }
	}
}
export function registerWorkerPresentation({ sessionId }: { sessionId: string }): WorkerPresentationRegistration {
	if (typeof sessionId !== "string" || !sessionId || sessionId.trim() !== sessionId || sessionId.includes("\0") || Buffer.byteLength(sessionId, "utf8") > 256) throw new Error("Invalid worker presentation sessionId.");
	const state = registry();
	if (state.owners.has(sessionId)) throw new Error("Worker presentation already registered for session.");
	const owner: Owner = { sessionId, leaves: new Set() };
	state.owners.set(sessionId, owner);
	changed(sessionId);
	return Object.freeze({
		acknowledge(accepted: SubagentWorkerDecisionAcceptedEvent): boolean {
			if (!accepted || state.owners.get(sessionId) !== owner || state.issued.get(accepted) !== owner || accepted.sessionId !== sessionId) return false;
			if (!owner.leaves.has(accepted.runId)) { owner.leaves.add(accepted.runId); changed(sessionId); }
			return true;
		},
		dispose() { invalidateWorkerPresentation(owner); },
	});
}

/** Executor only: publish before emitting acceptance, so synchronous observers can acknowledge. */
export function issueWorkerPresentationBinding(accepted: SubagentWorkerDecisionAcceptedEvent): void {
	const owner = registry().owners.get(accepted.sessionId);
	if (owner) registry().issued.set(accepted, owner);
}
export function captureWorkerPresentation(sessionId: string): Owner | undefined { return registry().owners.get(sessionId); }
export function invalidateWorkerPresentation(owner: Owner | undefined): void {
	if (!owner || registry().owners.get(owner.sessionId) !== owner) return;
	registry().owners.delete(owner.sessionId);
	owner.leaves.clear();
	changed(owner.sessionId);
}
export function onWorkerPresentationChanged(listener: (sessionId: string) => void): () => void {
	registry().listeners.add(listener);
	return () => { registry().listeners.delete(listener); };
}
export function isWorkerPresentationDelegated(sessionId: string | null | undefined, runId: string): boolean {
	return !!sessionId && registry().owners.get(sessionId)?.leaves.has(runId) === true;
}

/** Transient binding only: restored/serialized history never acquires presentation ownership. */
export function bindWorkerPresentationMessage(message: object, runs: Array<{ sessionId: string; runId?: string }>): void {
	const bindings: Array<{ owner: Owner; runId: string }> = [];
	for (const run of runs) {
		const owner = registry().owners.get(run.sessionId);
		if (!owner || !run.runId || !owner.leaves.has(run.runId)) return;
		bindings.push({ owner, runId: run.runId });
	}
	if (bindings.length) registry().messages.set(message, bindings);
}
export function isWorkerPresentationMessageDelegated(message: object): boolean {
	return registry().messages.get(message)?.every(({ owner, runId }) => registry().owners.get(owner.sessionId) === owner && owner.leaves.has(runId)) === true;
}

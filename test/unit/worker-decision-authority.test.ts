import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import {
	disposeWorkerDecisionSession,
	getWorkerDecisionState,
	prepareWorkerDecision,
	registerWorkerDecisionAuthority,
	WorkerDecisionAuthorityError,
	type AppliedWorkerDecision,
	type PrepareWorkerDecisionInput,
	type WorkerDecision,
	type WorkerDecisionAuthority,
	type WorkerDecisionClock,
} from "../../src/api/worker-decision-authority.ts";

class Clock implements WorkerDecisionClock {
	time = 1000;
	timers = new Set<{ at: number; callback: () => void }>();
	now = () => this.time;
	schedule = (at: number, callback: () => void) => {
		const timer = { at, callback };
		this.timers.add(timer);
		return () => { this.timers.delete(timer); };
	};
	advance(at: number) {
		this.time = at;
		for (const timer of [...this.timers].sort((a, b) => a.at - b.at)) {
			if (timer.at <= at && this.timers.delete(timer)) timer.callback();
		}
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const pair = { model: "provider/target", thinking: "medium" as const };
const decision: WorkerDecision = { kind: "apply", ...pair, reason: "assessed" };
let sequence = 0;
function fixture(authority?: WorkerDecisionAuthority) {
	const clock = new Clock();
	const sessionId = `worker-authority-test-${++sequence}`;
	const applied: AppliedWorkerDecision[] = [];
	const registration = registerWorkerDecisionAuthority({
		sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 1000,
		authority: authority ?? { async decide() { return decision; }, onApplied(receipt) { applied.push(receipt); } },
	});
	const input: { -readonly [Key in keyof PrepareWorkerDecisionInput]: PrepareWorkerDecisionInput[Key] } = {
		sessionId,
		control: { logicalLaunchId: "leaf-1", runtimeAttemptId: "attempt-1", ownerGeneration: registration.generation, context: "fresh", launchDeadline: 5000 },
		facts: { task: "Implement bounded parser; preserve high/deep/medium tokens.", role: { description: "Reviews parser correctness", provenance: "resolved-agent" }, capabilities: [{ description: "Can run parser unit tests", provenance: "host" }] },
		policyContext: { definitionRevision: "definition-1", constraintRevision: "constraints-1", comparison: { kind: "resolved", model: "provider/parent", provenance: "parent" }, modelContract: { kind: "selectable", models: ["provider/target", "provider/original"] }, original: { kind: "verified", model: "provider/original", thinking: "low", provenance: "host-effective", definitionRevision: "definition-1", constraintRevision: "constraints-1" } },
		classifierTimeoutMs: 1000,
		clock,
		host: {
			getCurrentRevisions() { return { definitionRevision: "definition-1", constraintRevision: "constraints-1" }; },
			async resolveTarget(model) { return { kind: "resolved", model, supportedThinking: ["low", "medium"], baseline: { kind: "unresolved", reason: "thinking-unresolved" }, definitionRevision: "definition-1", constraintRevision: "constraints-1" }; },
			async validate() { return { kind: "valid" }; },
		},
	};
	return { clock, sessionId, registration, input, applied };
}

it("rejects an invalid tool selection capability fact", async () => {
 const f = fixture();
 f.input.facts = { ...f.input.facts, toolSelection: "invalid" as never };
 try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "invalid-request" }); }
 finally { f.registration.dispose(); }
});

it("binds tool selection capability into the logical launch identity", async () => {
 const f = fixture();
 f.input.facts = { ...f.input.facts, toolSelection: "supported" };
 try {
  assert.equal((await prepareWorkerDecision(f.input)).kind, "committed");
  f.input.facts = { ...f.input.facts, toolSelection: "unsupported" };
  assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "identity-conflict" });
 } finally { f.registration.dispose(); }
});

it("owner cancellation is a consumed blocked decision", async () => {
	let calls = 0;
	let validations = 0;
	let notifications = 0;
	const f = fixture({ async decide() { calls++; return { kind: "reject", reason: "cancelled" }; }, onApplied() { notifications++; } });
	f.input.host.validate = async () => { validations++; return { kind: "valid" }; };
	try {
		assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "cancelled" });
		assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "consumed", state: "blocked" });
		assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "cancelled" });
		assert.equal(calls, 1);
		assert.equal(validations, 0);
		assert.equal(notifications, 0);
		f.registration.dispose();
		const replacement = registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 1000, authority: { async decide() { calls++; return decision; } } });
		try {
			f.input.control = { ...f.input.control, ownerGeneration: replacement.generation };
			assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "cancelled" });
			assert.equal(calls, 1);
		} finally { replacement.dispose(); }
	} finally { f.registration.dispose(); }
});

it("C01-duplicate: one originating session rejects a second owner", () => {
	const f = fixture();
	try {
		assert.throws(() => registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 1000, authority: { async decide() { return decision; } } }), (error) => error instanceof WorkerDecisionAuthorityError && error.reason === "owner-conflict");
	} finally { f.registration.dispose(); }
});

it("C02-pair: trusted validation precedes exact logical commitment", async () => {
	const f = fixture();
	const validated = deferred<{ kind: "valid" }>();
	const entered = deferred<void>();
	f.input.host.validate = async (selected) => { assert.deepEqual(selected, pair); entered.resolve(); return validated.promise; };
	try {
		const pending = prepareWorkerDecision(f.input);
		await entered.promise;
		assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "consumed", state: "pending" });
		assert.equal(f.applied.length, 0);
		validated.resolve({ kind: "valid" });
		const result = await pending;
		assert.equal(result.kind, "committed");
		if (result.kind !== "committed") return;
		assert.equal(result.receipt.model, "provider/target");
		assert.equal(result.receipt.thinking, "medium");
		assert.equal(result.receipt.reason, "assessed");
		assert.match(result.receipt.digest, /^[a-f0-9]{64}$/);
		assert.equal(f.applied.length, 1);
		assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "committed", receipt: result.receipt });
	} finally { f.registration.dispose(); }
});

it("C07-missing: configured role high cannot fill missing effort", async () => {
	const f = fixture({ async decide() { return { kind: "apply", model: "provider/target", reason: "assessed" } as WorkerDecision; } });
	f.input.policyContext = { ...f.input.policyContext, original: { kind: "verified", model: "provider/role", thinking: "high", provenance: "explicit-launch", definitionRevision: "definition-1", constraintRevision: "constraints-1" } };
	try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "invalid-decision" }); assert.equal(f.applied.length, 0); }
	finally { f.registration.dispose(); }
});

it("C03-projection: facts exclude configured thinking while private policy retains baseline", async () => {
	const f = fixture({ async decide(request) {
		assert.deepEqual(request.facts, {
			task: "Implement bounded parser; preserve high/deep/medium tokens.",
			role: { description: "Reviews parser correctness", provenance: "resolved-agent" },
			capabilities: [{ description: "Can run parser unit tests", provenance: "host" }],
		});
		assert.equal(request.policyContext.original.kind, "verified");
		assert.equal("thinking" in request.policyContext.original && request.policyContext.original.thinking, "low");
		assert.ok(Object.isFrozen(request.facts));
		return decision;
	} });
	Object.assign(f.input.facts, { thinking: "high", routingAdvice: "Always choose high" });
	Object.assign(f.input.facts.role!, { thinking: "high", configuredModel: "provider/role" });
	try { assert.equal((await prepareWorkerDecision(f.input)).kind, "committed"); }
	finally { f.registration.dispose(); }
});

it("C04-cancel: requester abort stops pending callback without receipt", async () => {
	const entered = deferred<void>();
	let callbackSignal!: AbortSignal;
	const f = fixture({ async decide(_, context) { callbackSignal = context.signal; entered.resolve(); return new Promise(() => {}); } });
	const cancellation = new AbortController();
	f.input.signal = cancellation.signal;
	try {
		const pending = prepareWorkerDecision(f.input);
		await entered.promise;
		cancellation.abort();
		assert.deepEqual(await pending, { kind: "blocked", reason: "cancelled" });
		assert.equal(callbackSignal.aborted, true);
		assert.equal(f.applied.length, 0);
	} finally { f.registration.dispose(); }
});

it("C05-pending: duplicate delivery joins one assessment", async () => {
	let calls = 0;
	const answer = deferred<WorkerDecision>();
	const f = fixture({ async decide() { calls++; return answer.promise; } });
	try {
		const first = prepareWorkerDecision(f.input);
		const duplicate = prepareWorkerDecision(f.input);
		answer.resolve(decision);
		assert.deepEqual(await duplicate, await first);
		assert.equal(calls, 1);
	} finally { f.registration.dispose(); }
});

it("C06-cutoff: owner retains explicit original pair after classifier cutoff before hard deadline", async () => {
	const entered = deferred<void>();
	const assessment = deferred<void>();
	let calls = 0;
	const f = fixture({ async decide(request, context) {
		calls++;
		assert.equal(context.assessmentCutoff, 2000);
		assert.equal(context.hardDeadline, 3000);
		assert.equal(context.assessmentAvailable, true);
		entered.resolve();
		await assessment.promise;
		assert.equal(context.signal.aborted, false);
		assert.equal(request.policyContext.original.kind, "verified");
		return { kind: "apply", model: "provider/original", thinking: "low", reason: "verified-original-retained" };
	} });
	f.input.control = { ...f.input.control, launchDeadline: 3000 };
	try {
		const pending = prepareWorkerDecision(f.input);
		await entered.promise;
		f.clock.advance(2000);
		assessment.resolve();
		const result = await pending;
		assert.equal(result.kind, "committed");
		if (result.kind === "committed") assert.deepEqual([result.receipt.model, result.receipt.thinking, result.receipt.reason], ["provider/original", "low", "verified-original-retained"]);
		assert.equal(calls, 1);
	} finally { f.registration.dispose(); }
});

it("C07-null: null authority reply is invalid decision, not a retained pair", async () => {
	const f = fixture({ async decide() { return null as unknown as WorkerDecision; } });
	try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "invalid-decision" }); }
	finally { f.registration.dispose(); }
});

it("C04-cancel-duplicate: cancelled duplicate cannot reuse committed decision", async () => {
	const f = fixture();
	try {
		assert.equal((await prepareWorkerDecision(f.input)).kind, "committed");
		const cancellation = new AbortController();
		cancellation.abort();
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, signal: cancellation.signal }), { kind: "blocked", reason: "cancelled" });
	} finally { f.registration.dispose(); }
});

it("C04-cancel-pending-duplicate: cancelled duplicate cannot join pending authority", async () => {
	const answer = deferred<WorkerDecision>();
	const f = fixture({ async decide() { return answer.promise; } });
	try {
		const pending = prepareWorkerDecision(f.input);
		const cancellation = new AbortController();
		cancellation.abort();
		const duplicate = prepareWorkerDecision({ ...f.input, signal: cancellation.signal });
		answer.resolve(decision);
		assert.deepEqual(await duplicate, { kind: "blocked", reason: "cancelled" });
		assert.equal((await pending).kind, "committed");
	} finally { f.registration.dispose(); }
});

it("C01-dispose: old registration cannot dispose replacement owner", async () => {
	const f = fixture();
	f.registration.dispose();
	const replacement = registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 1000, authority: { async decide() { return decision; } } });
	f.registration.dispose();
	try {
		assert.notEqual(replacement.generation, f.registration.generation);
		assert.equal((await prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: replacement.generation } })).kind, "committed");
	} finally { replacement.dispose(); }
});

it("C01-missing: never-owned optional path returns explicit unowned, expected owner blocks", async () => {
	const f = fixture();
	try {
		const input = { ...f.input, sessionId: `${f.sessionId}-never-owned`, control: { ...f.input.control, ownerGeneration: undefined } };
		assert.deepEqual(await prepareWorkerDecision(input), { kind: "unowned" });
		assert.deepEqual(await prepareWorkerDecision({ ...input, control: { ...input.control, ownerGeneration: "expected-owner" } }), { kind: "blocked", reason: "owner-missing" });
		f.registration.dispose();
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: undefined } }), { kind: "blocked", reason: "owner-missing" });
	} finally { f.registration.dispose(); }
});

it("C01-session: terminal session disposal blocks registration and preparation", async () => {
	const f = fixture();
	disposeWorkerDecisionSession(f.sessionId);
	assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "session-disposed" });
	assert.throws(() => registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 1000, authority: { async decide() { return decision; } } }), (error) => error instanceof WorkerDecisionAuthorityError && error.reason === "session-disposed");
	f.registration.dispose();
});

it("C02-reject: trusted scope rejection prevents commitment", async () => {
	const f = fixture();
	f.input.host.validate = async () => ({ kind: "blocked", reason: "scope-denied" });
	try {
		assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "scope-denied" });
		assert.equal(f.applied.length, 0);
		assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "consumed", state: "blocked" });
	} finally { f.registration.dispose(); }
});

it("C02-resolve: owner target query uses trusted resolver without inference or baseline synthesis", async () => {
	let resolutions = 0;
	const f = fixture({ async decide(_, context) {
		const target = await context.resolveTarget("provider/target");
		assert.deepEqual(target, { kind: "resolved", model: "provider/target", supportedThinking: ["low", "medium"], baseline: { kind: "unresolved", reason: "thinking-unresolved" }, definitionRevision: "definition-1", constraintRevision: "constraints-1" });
		return decision;
	} });
	const resolve = f.input.host.resolveTarget;
	f.input.host.resolveTarget = async (...args) => { resolutions++; return resolve(...args); };
	try { assert.equal((await prepareWorkerDecision(f.input)).kind, "committed"); assert.equal(resolutions, 1); }
	finally { f.registration.dispose(); }
});

it("C02-revision: live revision changed during validation fences reply", async () => {
	const f = fixture();
	f.input.host.validate = async () => { f.input.host.getCurrentRevisions = () => ({ definitionRevision: "definition-1", constraintRevision: "constraints-2" }); return { kind: "valid" }; };
	try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "stale-revisions" }); assert.equal(f.applied.length, 0); }
	finally { f.registration.dispose(); }
});

it("C02-notify: notification sees committed receipt once even if observer throws", async () => {
	let calls = 0;
	const f = fixture({ async decide() { return decision; }, onApplied(receipt) {
		calls++;
		assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "committed", receipt });
		throw new Error("private observer diagnostic");
	} });
	try {
		const result = await prepareWorkerDecision(f.input);
		assert.equal(result.kind, "committed");
		assert.equal(result.kind === "committed" && result.notification, "failed");
		assert.equal((await prepareWorkerDecision(f.input)).kind, "committed");
		assert.equal(calls, 1);
		assert.equal(JSON.stringify(result).includes("private observer diagnostic"), false);
	} finally { f.registration.dispose(); }
});

it("C04-stale: old generation cannot assess under replacement", async () => {
	const f = fixture();
	f.registration.dispose();
	let calls = 0;
	const replacement = registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 1000, authority: { async decide() { calls++; return decision; } } });
	try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "stale-owner" }); assert.equal(calls, 0); }
	finally { replacement.dispose(); }
});

it("C04-owner: disposing owner aborts pending callback and discards late reply", async () => {
	const answer = deferred<WorkerDecision>();
	const entered = deferred<void>();
	let signal!: AbortSignal;
	const f = fixture({ async decide(_, context) { signal = context.signal; entered.resolve(); return answer.promise; } });
	const pending = prepareWorkerDecision(f.input);
	await entered.promise;
	f.registration.dispose();
	assert.deepEqual(await pending, { kind: "blocked", reason: "stale-owner" });
	assert.equal(signal.aborted, true);
	answer.resolve(decision);
	await Promise.resolve();
	assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "consumed", state: "blocked" });
});

it("C04-deadline: authority cannot start at hard deadline", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; return decision; } });
	f.clock.advance(5000);
	try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "deadline-exceeded" }); assert.equal(calls, 0); }
	finally { f.registration.dispose(); }
});

it("C04-pending-deadline: hung callback settles at hard deadline without reset", async () => {
	const entered = deferred<void>();
	const f = fixture({ async decide() { entered.resolve(); return new Promise(() => {}); } });
	try {
		const pending = prepareWorkerDecision(f.input);
		await entered.promise;
		f.clock.advance(5000);
		assert.deepEqual(await pending, { kind: "blocked", reason: "deadline-exceeded" });
		assert.equal(f.clock.timers.size, 0);
	} finally { f.registration.dispose(); }
});

it("C04-cancel-joining: aborting joined delivery returns cancelled without cancelling first delivery", async () => {
	const answer = deferred<WorkerDecision>();
	const f = fixture({ async decide() { return answer.promise; } });
	try {
		const pending = prepareWorkerDecision(f.input);
		const cancellation = new AbortController();
		const duplicate = prepareWorkerDecision({ ...f.input, signal: cancellation.signal });
		cancellation.abort();
		assert.deepEqual(await duplicate, { kind: "blocked", reason: "cancelled" });
		answer.resolve(decision);
		assert.equal((await pending).kind, "committed");
	} finally { f.registration.dispose(); }
});

it("C05-repeat: repeat delivery reuses exact commitment and emits one receipt", async () => {
	const f = fixture();
	try {
		const first = await prepareWorkerDecision(f.input);
		assert.deepEqual(await prepareWorkerDecision(f.input), first);
		assert.equal(f.applied.length, 1);
	} finally { f.registration.dispose(); }
});

it("C05-attempt: new runtime attempt revalidates same pair without reassessment", async () => {
	let calls = 0;
	let validations = 0;
	const f = fixture({ async decide() { calls++; return decision; } });
	f.input.host.validate = async () => { validations++; return { kind: "valid" }; };
	try {
		const first = await prepareWorkerDecision(f.input);
		const recovered = await prepareWorkerDecision({ ...f.input, control: { ...f.input.control, runtimeAttemptId: "attempt-2" } });
		assert.deepEqual(recovered, first);
		assert.equal(calls, 1);
		assert.equal(validations, 2);
	} finally { f.registration.dispose(); }
});

it("C05-binding: task or revision changes do not reset stable identity", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; return decision; } });
	try {
		await prepareWorkerDecision(f.input);
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, facts: { task: "Different independent task" } }), { kind: "blocked", reason: "identity-conflict" });
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext: { ...f.input.policyContext, constraintRevision: "constraints-2" } }), { kind: "blocked", reason: "identity-conflict" });
		assert.equal(calls, 1);
	} finally { f.registration.dispose(); }
});

it("C05-consumed: callback crash leaves honest indeterminate claim, never a retry", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; throw new Error("private task/provider diagnostic"); } });
	try {
		assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "consumed-indeterminate" });
		assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "consumed", state: "indeterminate" });
		assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "consumed-indeterminate" });
		assert.equal(calls, 1);
		assert.equal(JSON.stringify(getWorkerDecisionState(f.sessionId, "leaf-1")).includes("diagnostic"), false);
	} finally { f.registration.dispose(); }
});

it("C05-generation: owner succession preserves consumed indeterminate identity", async () => {
	const f = fixture({ async decide() { throw new Error("crash"); } });
	await prepareWorkerDecision(f.input);
	f.registration.dispose();
	let calls = 0;
	const replacement = registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 1000, authority: { async decide() { calls++; return decision; } } });
	try {
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: replacement.generation } }), { kind: "blocked", reason: "consumed-indeterminate" });
		assert.equal(calls, 0);
	} finally { replacement.dispose(); }
});

it("C06-exhausted: owner fallback arriving at hard deadline cannot commit", async () => {
	const answer = deferred<WorkerDecision>();
	const entered = deferred<void>();
	const f = fixture({ async decide() { entered.resolve(); return answer.promise; } });
	try {
		const pending = prepareWorkerDecision(f.input);
		await entered.promise;
		f.clock.advance(5000);
		answer.resolve({ kind: "apply", model: "provider/original", thinking: "low", reason: "verified-original-retained" });
		assert.deepEqual(await pending, { kind: "blocked", reason: "deadline-exceeded" });
	} finally { f.registration.dispose(); }
});

it("C06-late-validation: resolution cannot extend hard authority budget", async () => {
	const resolving = deferred<void>();
	const target = deferred<Awaited<ReturnType<PrepareWorkerDecisionInput["host"]["resolveTarget"]>>>();
	const f = fixture({ async decide(_, context) { await context.resolveTarget("provider/target"); return decision; } });
	f.input.host.resolveTarget = async () => { resolving.resolve(); return target.promise; };
	try {
		const pending = prepareWorkerDecision(f.input);
		await resolving.promise;
		f.clock.advance(5000);
		assert.deepEqual(await pending, { kind: "blocked", reason: "deadline-exceeded" });
		target.resolve({ kind: "unresolved", reason: "target-unavailable" });
	} finally { f.registration.dispose(); }
});

it("C06-no-assessment: live owner may explicitly retain pair when no classifier time remains", async () => {
	const f = fixture({ async decide(_, context) {
		assert.equal(context.assessmentAvailable, false);
		assert.equal(context.assessmentCutoff, 900);
		assert.equal(context.hardDeadline, 1400);
		return { kind: "apply", model: "provider/original", thinking: "low", reason: "verified-original-retained" };
	} });
	f.input.control = { ...f.input.control, launchDeadline: 1400 };
	try { assert.equal((await prepareWorkerDecision(f.input)).kind, "committed"); }
	finally { f.registration.dispose(); }
});

for (const [id, invalid] of [
	["C07-unknown", { kind: "apply", model: "provider/target", thinking: "ultra", reason: "assessed" }],
	["C07-model", { kind: "apply", model: "target:high", thinking: "medium", reason: "assessed" }],
	["C07-reason", { kind: "apply", model: "provider/target", thinking: "medium", reason: "private task/provider error" }],
	["C07-missing-model", { kind: "apply", thinking: "medium", reason: "assessed" }],
] as const) {
	it(`${id}: invalid reply cannot synthesize a complete decision`, async () => {
		const f = fixture({ async decide() { return invalid as unknown as WorkerDecision; } });
		try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "invalid-decision" }); }
		finally { f.registration.dispose(); }
	});
}

for (const [id, reason] of [["C02-ceiling", "ceiling-denied"], ["C02-support", "unsupported-thinking"]] as const) {
	it(`${id}: trusted final admission refusal never clamps around policy`, async () => {
		const f = fixture();
		f.input.host.validate = async () => ({ kind: "blocked", reason });
		try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason }); assert.equal(f.applied.length, 0); }
		finally { f.registration.dispose(); }
	});
}

it("C04-owner-lifetime: hard deadline uses earlier finite owner lifetime", async () => {
	const entered = deferred<void>();
	const f = fixture();
	f.registration.dispose();
	const replacement = registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: 2200, assessmentTimeoutMs: 1000, authority: { async decide(_, context) {
		assert.equal(context.hardDeadline, 2200);
		assert.equal(context.assessmentCutoff, 1700);
		entered.resolve();
		return new Promise(() => {});
	} } });
	try {
		const pending = prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: replacement.generation } });
		await entered.promise;
		f.clock.advance(2200);
		assert.deepEqual(await pending, { kind: "blocked", reason: "deadline-exceeded" });
	} finally { replacement.dispose(); }
});

it("C04-invalid-deadline: invalid launch deadline cannot reset authority budget", async () => {
	const f = fixture();
	try { assert.deepEqual(await prepareWorkerDecision({ ...f.input, control: { ...f.input.control, launchDeadline: Infinity } }), { kind: "blocked", reason: "invalid-deadline" }); }
	finally { f.registration.dispose(); }
});

it("C07-null-thinking: null thinking never becomes configured high", async () => {
	const f = fixture({ async decide() { return { kind: "apply", model: "provider/target", thinking: null, reason: "assessed" } as unknown as WorkerDecision; } });
	try { assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "invalid-decision" }); }
	finally { f.registration.dispose(); }
});

it("C02-closed-context: retained callback context cannot resolve targets after preparation ends", async () => {
	let context!: Parameters<WorkerDecisionAuthority["decide"]>[1];
	let resolutions = 0;
	const f = fixture({ async decide(_, supplied) { context = supplied; return decision; } });
	const resolve = f.input.host.resolveTarget;
	f.input.host.resolveTarget = async (...args) => { resolutions++; return resolve(...args); };
	try {
		assert.equal((await prepareWorkerDecision(f.input)).kind, "committed");
		assert.equal(context.signal.aborted, true);
		await assert.rejects(context.resolveTarget("provider/target"), (error) => error instanceof WorkerDecisionAuthorityError && error.reason === "cancelled");
		assert.equal(resolutions, 0);
	} finally { f.registration.dispose(); }
});

it("C02-notify-dispose: disposal by post-commit observer cannot erase logical commitment", async () => {
	const f = fixture({ async decide() { return decision; }, onApplied() { f.registration.dispose(); } });
	const result = await prepareWorkerDecision(f.input);
	assert.equal(result.kind, "committed");
	assert.equal(getWorkerDecisionState(f.sessionId, "leaf-1").kind, "committed");
});

it("C06-admission: classifier cutoff starts at admission, not after host validation setup", async () => {
	const f = fixture({ async decide(_, context) {
		assert.equal(context.assessmentCutoff, 2000);
		return decision;
	} });
	f.input.host.getCurrentRevisions = () => { f.clock.time = 1200; return { definitionRevision: "definition-1", constraintRevision: "constraints-1" }; };
	try { assert.equal((await prepareWorkerDecision(f.input)).kind, "committed"); }
	finally { f.registration.dispose(); }
});

for (const [id, effect, reason] of [
	["C04-final-deadline", (f: ReturnType<typeof fixture>) => { f.clock.time = 5000; }, "deadline-exceeded"],
	["C04-final-dispose", (f: ReturnType<typeof fixture>) => { f.registration.dispose(); }, "stale-owner"],
] as const) {
	it(`${id}: final revision callback cannot invalidate authority then commit`, async () => {
		const f = fixture();
		let revisions = 0;
		f.input.host.getCurrentRevisions = () => {
			if (++revisions === 4) effect(f);
			return { definitionRevision: "definition-1", constraintRevision: "constraints-1" };
		};
		try {
			assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason });
			assert.notEqual(getWorkerDecisionState(f.sessionId, "leaf-1").kind, "committed");
			assert.equal(f.applied.length, 0);
		} finally { f.registration.dispose(); }
	});
}

it("C04-reuse-final: revision callback cannot permit expired committed reuse", async () => {
	const f = fixture();
	try {
		assert.equal((await prepareWorkerDecision(f.input)).kind, "committed");
		let revisions = 0;
		f.input.host.getCurrentRevisions = () => {
			if (++revisions === 4) f.clock.time = 5000;
			return { definitionRevision: "definition-1", constraintRevision: "constraints-1" };
		};
		assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "deadline-exceeded" });
		assert.equal(f.applied.length, 1);
	} finally { f.registration.dispose(); }
});

it("C04-resolver-final: target serialization cannot outlive authority", async () => {
	let resolved = false;
	const f = fixture({ async decide(_, context) { await context.resolveTarget("provider/target"); resolved = true; return decision; } });
	f.input.host.resolveTarget = async () => ({
		kind: "resolved", model: "provider/target", supportedThinking: ["medium"], baseline: { kind: "unresolved", reason: "thinking-unresolved" },
		definitionRevision: "definition-1", constraintRevision: "constraints-1",
		get ignoredSerializationWork() { f.clock.time = 5000; return true; },
	});
	try {
		assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "deadline-exceeded" });
		assert.equal(resolved, false);
		assert.equal(getWorkerDecisionState(f.sessionId, "leaf-1").kind, "consumed");
	} finally { f.registration.dispose(); }
});

for (const [id, mode] of [
	["C05-limit-sessions", "sessions"], ["C05-limit-tombstones", "tombstones"],
	["C05-limit-session-entries", "session-entries"], ["C05-limit-total-entries", "total-entries"],
	["C05-limit-ids", "ids"],
] as const) {
	it(`${id}: retention admission stays bounded in isolated process`, () => {
		const output = execFileSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../support/worker-decision-authority-capacity.ts", import.meta.url)), mode], { encoding: "utf8", timeout: 30000 });
		assert.match(output, /Capacity boundary verified:/);
	});
}

it("C05-canonical: reordered nested policy records reuse exact commitment", async () => {
	let assessments = 0;
	let notifications = 0;
	let validations = 0;
	const f = fixture({ async decide() { assessments++; return decision; }, onApplied() { notifications++; } });
	f.input.host.validate = async () => { validations++; return { kind: "valid" }; };
	try {
		const first = await prepareWorkerDecision(f.input);
		const reordered = {
			comparison: { provenance: "parent" as const, model: "provider/parent", kind: "resolved" as const, ignored: "not policy" },
			original: { constraintRevision: "constraints-1", definitionRevision: "definition-1", provenance: "host-effective" as const, thinking: "low" as const, model: "provider/original", kind: "verified" as const, ignored: "not policy" },
			modelContract: { models: ["provider/target", "provider/original"], kind: "selectable" as const, ignored: true },
			constraintRevision: "constraints-1", definitionRevision: "definition-1", ignored: "not policy",
		};
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext: reordered }), first);
		assert.equal(assessments, 1);
		assert.equal(notifications, 1);
		assert.equal(validations, 2);
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext: { ...reordered, original: { ...reordered.original, thinking: "high" } } }), { kind: "blocked", reason: "identity-conflict" });
	} finally { f.registration.dispose(); }
});

it("C05-canonical-unresolved: fixed model and unresolved records use named fields", async () => {
	const f = fixture();
	const policyContext = { definitionRevision: "definition-1", constraintRevision: "constraints-1", comparison: { kind: "unresolved" as const, reason: "model-unresolved" as const }, modelContract: { kind: "fixed" as const, model: "provider/target" }, original: { kind: "unresolved" as const, reason: "thinking-unresolved" as const } };
	try {
		const first = await prepareWorkerDecision({ ...f.input, policyContext });
		assert.equal(first.kind, "committed");
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext: { comparison: { reason: "model-unresolved", kind: "unresolved" }, original: { reason: "thinking-unresolved", kind: "unresolved" }, modelContract: { model: "provider/target", kind: "fixed" }, constraintRevision: "constraints-1", definitionRevision: "definition-1" } }), first);
	} finally { f.registration.dispose(); }
});

it("C05-canonical-array: meaningful candidate array order remains bound", async () => {
	const f = fixture();
	try {
		await prepareWorkerDecision(f.input);
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext: { ...f.input.policyContext, modelContract: { kind: "selectable", models: ["provider/original", "provider/target"] } } }), { kind: "blocked", reason: "identity-conflict" });
	} finally { f.registration.dispose(); }
});

it("C05-canonical-invalid: malformed declared policy fields fail before assessment", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; return decision; } });
	try {
		for (const policyContext of [
			{ ...f.input.policyContext, definitionRevision: null },
			{ ...f.input.policyContext, modelContract: { kind: "unknown", models: [] } },
			{ ...f.input.policyContext, original: { kind: "verified", model: "provider/original", thinking: null } },
		]) assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext } as PrepareWorkerDecisionInput), { kind: "blocked", reason: "invalid-request" });
		assert.equal(calls, 0);
	} finally { f.registration.dispose(); }
});

it("CORE-COMPARISON: comparison snapshot is frozen, projected, and claim-bound independently of retention", async () => {
	let calls = 0;
	const f = fixture({ async decide(request) {
		calls++;
		assert.deepEqual(request.policyContext.comparison, { kind: "resolved", model: "provider/parent", provenance: "parent" });
		assert.ok(Object.isFrozen(request.policyContext.comparison));
		assert.equal("comparison" in request.facts, false);
		return decision;
	} });
	Object.assign(f.input.policyContext.comparison, { thinking: "high", ignored: true });
	try {
		assert.equal((await prepareWorkerDecision(f.input)).kind, "committed");
		for (const comparison of [
			{ kind: "resolved", model: "provider/other-parent", provenance: "parent" },
			{ kind: "resolved", model: "provider/parent", provenance: "explicit-caller" },
			{ kind: "unresolved", reason: "model-unresolved" },
		] as const) assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext: { ...f.input.policyContext, comparison } }), { kind: "blocked", reason: "identity-conflict" });
		assert.equal(calls, 1);
	} finally { f.registration.dispose(); }
});

it("CORE-COMPARISON-invalid: missing or malformed comparison fails closed before assessment or claim", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; return decision; } });
	try {
		for (const comparison of [undefined, null, {},
			{ kind: "resolved", model: "parent", provenance: "parent" },
			{ kind: "resolved", model: "provider/parent:high", provenance: "parent" },
			{ kind: "resolved", model: "provider/parent", provenance: "explicit-launch" },
			{ kind: "resolved", model: "provider/parent" },
			{ kind: "unresolved", reason: "thinking-unresolved" },
		]) assert.deepEqual(await prepareWorkerDecision({ ...f.input, policyContext: { ...f.input.policyContext, comparison } } as PrepareWorkerDecisionInput), { kind: "blocked", reason: "invalid-request" });
		assert.equal(calls, 0);
		assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "unconsumed" });
	} finally { f.registration.dispose(); }
});

it("CORE-NAME: factual name projection is canonical and changing resolved identity cannot reassess", async () => {
	let calls = 0; let applied = 0;
	const f = fixture({ async decide(request) {
		calls++;
		assert.deepEqual(request.facts.role, { name: "specialized-reviewer", description: "Reviews parser correctness", provenance: "resolved-agent" });
		assert.ok(Object.isFrozen(request.facts.role));
		return decision;
	}, onApplied() { applied++; } });
	const role = { ...f.input.facts.role!, name: "specialized-reviewer", thinking: "high", systemPrompt: "PRIVATE", steering: "PRIVATE" };
	f.input.facts = { ...f.input.facts, role };
	try {
		const first = await prepareWorkerDecision(f.input);
		assert.equal(first.kind, "committed");
		const reordered = { provenance: "resolved-agent" as const, description: role.description, name: role.name, ignored: "not identity" };
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, facts: { ...f.input.facts, role: reordered } }), first);
		assert.deepEqual(await prepareWorkerDecision({ ...f.input, facts: { ...f.input.facts, role: { ...role, name: "specialized-junior" } } }), { kind: "blocked", reason: "identity-conflict" });
		assert.equal(calls, 1); assert.equal(applied, 1);
	} finally { f.registration.dispose(); }
});

it("CORE-NAME-invalid: only nonempty resolved-agent names are accepted before assessment", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; return decision; } });
	try {
		for (const role of [
			{ name: "inferred-reviewer", description: "task", provenance: "authored-task" },
			{ name: "", description: "role", provenance: "resolved-agent" },
			{ name: "bad\0name", description: "role", provenance: "resolved-agent" },
			{ name: null, description: "role", provenance: "resolved-agent" },
			{ name: 42, description: "role", provenance: "resolved-agent" },
		]) assert.deepEqual(await prepareWorkerDecision({ ...f.input, facts: { ...f.input.facts, role } } as unknown as PrepareWorkerDecisionInput), { kind: "blocked", reason: "invalid-request" });
		assert.equal(calls, 0);
	} finally { f.registration.dispose(); }
});

it("AC2 host tool metadata and selected identities survive immutable authority commitment", async () => {
 const metadata = [{ name: "search", description: "Search repository", namespace: "plugin", sourcePath: "/plugin/index.ts" }];
 const selected = [{ name: "search", namespace: "plugin", sourcePath: "/plugin/index.ts" }];
 const f = fixture({ async decide(request) {
  assert.deepEqual(request.facts.tools, metadata);
  assert.ok(Object.isFrozen(request.facts.tools?.[0]));
  return { ...decision, selectedTools: selected };
 } });
 try {
  f.input.facts = { ...f.input.facts, tools: metadata, callerTools: ["read"] };
  const result = await prepareWorkerDecision(f.input);
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") return;
  selected[0]!.name = "changed";
  assert.deepEqual(result.receipt.selectedTools, [{ name: "search", namespace: "plugin", sourcePath: "/plugin/index.ts" }]);
  assert.ok(Object.isFrozen(result.receipt.selectedTools?.[0]));
 } finally { f.registration.dispose(); }
});

it("worker tool warnings are committed as bounded immutable receipt data", async () => {
 const warnings = ["Tool scoring unavailable."];
 const f = fixture({ async decide() { return { ...decision, toolWarnings: warnings }; } });
 try {
  const result = await prepareWorkerDecision(f.input);
  assert.equal(result.kind, "committed");
  if (result.kind !== "committed") return;
  warnings[0] = "changed";
  assert.deepEqual(result.receipt.toolWarnings, ["Tool scoring unavailable."]);
  assert.ok(Object.isFrozen(result.receipt.toolWarnings));
 } finally { f.registration.dispose(); }
});

it("worker tool warnings reject unbounded input", async () => {
 const f = fixture({ async decide() { return { ...decision, toolWarnings: ["x".repeat(513)] }; } });
 try {
  const result = await prepareWorkerDecision(f.input);
  assert.deepEqual(result, { kind: "blocked", reason: "invalid-decision" });
 } finally { f.registration.dispose(); }
});

it("AC5 authority cannot select a tool with unobserved source identity", async () => {
 const f = fixture({ async decide() { return { ...decision, selectedTools: [{ name: "search", namespace: "other" }] }; } });
 try {
  f.input.facts = { ...f.input.facts, tools: [{ name: "search", description: "Search", namespace: "plugin" }] };
  assert.deepEqual(await prepareWorkerDecision(f.input), { kind: "blocked", reason: "invalid-decision" });
 } finally { f.registration.dispose(); }
});

it("host admission receives immutable selected identities before commitment and can reject", async () => {
 let applied = 0;
 const selection = [{name: "search", sourcePath: "/plugin/index.ts"}];
 const f = fixture({async decide() { return {...decision, selectedTools: selection}; }, onApplied() { applied++; }});
 f.input.facts = {...f.input.facts, tools: [{...selection[0]!, description: "Search"}]};
 f.input.host.validate = async (_pair, _request, context) => {
  assert.deepEqual(context.selectedTools, selection);
  assert.ok(Object.isFrozen(context.selectedTools));
  assert.ok(Object.isFrozen(context.selectedTools?.[0]));
  return {kind: "blocked", reason: "scope-denied"};
 };
 try {
  assert.deepEqual(await prepareWorkerDecision(f.input), {kind: "blocked", reason: "scope-denied"});
  assert.equal(applied, 0);
  assert.deepEqual(getWorkerDecisionState(f.sessionId, "leaf-1"), {kind:"consumed", state:"blocked"});
 } finally {f.registration.dispose();}
});

it("persisted selected-tool grants require bounded, absolute, file-backed identities", async () => {
	const { isBoundedWorkerSelectedTools } = await import("../../src/shared/worker-decision-authority.ts");
	assert.equal(isBoundedWorkerSelectedTools([]), true);
	assert.equal(isBoundedWorkerSelectedTools([{ name: "a", sourcePath: "/abs/a.ts" }, { name: "b", namespace: "ns", sourcePath: "/abs/b.ts" }]), true);
	for (const bad of [
		undefined, "nope", {}, [null], [[]],
		[{ name: "a" }],
		[{ name: "a", sourcePath: "relative.ts" }],
		[{ name: "", sourcePath: "/abs/a.ts" }],
		[{ name: "a", sourcePath: "/abs/\0a.ts" }],
		[{ name: "a", namespace: "", sourcePath: "/abs/a.ts" }],
		[{ name: "a".repeat(1025), sourcePath: "/abs/a.ts" }],
		Array.from({ length: 257 }, (_, i) => ({ name: `t${i}`, sourcePath: "/abs/a.ts" })),
		Array.from({ length: 70 }, (_, i) => ({ name: `t${i}`, sourcePath: `/${"p".repeat(1000)}` })),
	]) assert.equal(isBoundedWorkerSelectedTools(bad), false, JSON.stringify(bad)?.slice(0, 80));
});

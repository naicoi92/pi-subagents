import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import * as api from "../../src/api/worker-decision-authority.ts";
import type { PrepareWorkerDecisionInput, WorkerDecision, WorkerDecisionAuthority, WorkerDecisionContext } from "../../src/api/worker-decision-authority.ts";

const decision: WorkerDecision = { kind: "apply", model: "provider/target", thinking: "medium", reason: "assessed" };
let sequence = 0;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function fixture(authority: WorkerDecisionAuthority = { async decide() { return decision; } }, assessmentTimeoutMs = 250) {
	const sessionId = `worker-routing-test-${++sequence}`;
	const registrationInput = { sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs, authority };
	const registration = api.registerWorkerDecisionAuthority(registrationInput);
	const input: { -readonly [Key in keyof PrepareWorkerDecisionInput]: PrepareWorkerDecisionInput[Key] } = {
		sessionId,
		control: { logicalLaunchId: "leaf-1", runtimeAttemptId: "attempt-1", ownerGeneration: registration.generation, context: "fresh", launchDeadline: 5000 },
		facts: { task: "Implement bounded parser" },
		policyContext: { definitionRevision: "d1", constraintRevision: "c1", modelContract: { kind: "selectable", models: ["provider/target"] }, original: { kind: "unresolved", reason: "thinking-unresolved" } },
		classifierTimeoutMs: 1000,
		clock: { now: () => 1000, schedule: () => () => {} },
		host: {
			getCurrentRevisions() { return { definitionRevision: "d1", constraintRevision: "c1" }; },
			async resolveTarget() { return { kind: "unresolved", reason: "target-unavailable" }; },
			async validate() { return { kind: "valid" }; },
		},
	};
	return { sessionId, registrationInput, registration, input };
}

it("R02-invalid: registration rejects absent, nonnumeric, negative and nonfinite assessment budgets before allocation", () => {
	const sessionId = `worker-routing-invalid-${++sequence}`;
	for (const invalid of [undefined, null, "250", -1, NaN, Infinity, -Infinity]) {
		const input = { sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: invalid as number, authority: { async decide() { return decision; } } };
		let unexpected: ReturnType<typeof api.registerWorkerDecisionAuthority> | undefined;
		try { assert.throws(() => { unexpected = api.registerWorkerDecisionAuthority(input); }, /finite nonnegative assessmentTimeoutMs/); }
		finally { unexpected?.dispose(); }
		assert.deepEqual(api.getWorkerDecisionAuthoritySnapshot(sessionId), { kind: "never-owned" });
	}
	const valid = api.registerWorkerDecisionAuthority({ sessionId, lifetimeDeadline: 10000, assessmentTimeoutMs: 0, authority: { async decide() { return decision; } } });
	valid.dispose();
});

it("R02-budget: caller may tighten but never extend registered assessment budget or hard-deadline reserve", async () => {
	for (const [ownerTimeout, callerTimeout, launchDeadline, expectedCutoff] of [
		[250, 1000, 5000, 1250],
		[250, 100, 5000, 1100],
		[250, 1000, 1600, 1100],
		[0.5, 1000, 5000, 1000.5],
	] as const) {
		let observed: WorkerDecisionContext | undefined;
		const f = fixture({ async decide(_, context) { observed = context; return decision; } }, ownerTimeout);
		f.registrationInput.assessmentTimeoutMs = 10000;
		try {
			assert.equal((await api.prepareWorkerDecision({ ...f.input, classifierTimeoutMs: callerTimeout, control: { ...f.input.control, launchDeadline } })).kind, "committed");
			assert.equal(observed?.assessmentCutoff, expectedCutoff);
			assert.equal(observed?.hardDeadline, launchDeadline);
		} finally { f.registration.dispose(); }
	}
});

it("R02-zero: zero owner budget leaves live authority for explicit verified retention", async () => {
	let observed: WorkerDecisionContext | undefined;
	const f = fixture({ async decide(request, context) {
		observed = context;
		assert.equal(request.policyContext.original.kind, "verified");
		return { ...decision, reason: "verified-original-retained" };
	} }, 0);
	f.input.policyContext = { ...f.input.policyContext, original: { kind: "verified", model: "provider/target", thinking: "medium", provenance: "explicit-launch", definitionRevision: "d1", constraintRevision: "c1" } };
	try {
		const result = await api.prepareWorkerDecision(f.input);
		assert.equal(result.kind, "committed");
		assert.equal(observed?.assessmentAvailable, false);
		assert.equal(observed?.assessmentCutoff, 1000);
		assert.equal(observed?.hardDeadline, 5000);
	} finally { f.registration.dispose(); }
});

it("R01-states: immutable routing snapshot exposes only session fencing metadata", () => {
	const never = `worker-routing-never-${++sequence}`;
	assert.deepEqual(api.getWorkerDecisionAuthoritySnapshot(never), { kind: "never-owned" });
	const f = fixture();
	const active = api.getWorkerDecisionAuthoritySnapshot(f.sessionId);
	assert.deepEqual(active, { kind: "active", generation: f.registration.generation, lifetimeDeadline: 10000, assessmentTimeoutMs: 250 });
	assert.ok(Object.isFrozen(active));
	assert.ok(Object.isFrozen(api.getWorkerDecisionAuthoritySnapshot(never)));
	f.registrationInput.assessmentTimeoutMs = 900;
	f.registrationInput.lifetimeDeadline = 20000;
	assert.deepEqual(api.getWorkerDecisionAuthoritySnapshot(f.sessionId), active);
	f.registration.dispose();
	assert.deepEqual(api.getWorkerDecisionAuthoritySnapshot(f.sessionId), { kind: "missing" });
	assert.deepEqual(active, { kind: "active", generation: f.registration.generation, lifetimeDeadline: 10000, assessmentTimeoutMs: 250 });
	api.disposeWorkerDecisionSession(f.sessionId);
	assert.deepEqual(api.getWorkerDecisionAuthoritySnapshot(f.sessionId), { kind: "disposed" });
	assert.throws(() => api.registerWorkerDecisionAuthority(f.registrationInput), (error) => error instanceof api.WorkerDecisionAuthorityError && error.reason === "session-disposed");
});

it("R03-race: captured snapshot cannot authorize replaced or terminally disposed owner", async () => {
	let calls = 0;
	let notifications = 0;
	const authority: WorkerDecisionAuthority = { async decide() { calls++; return decision; }, onApplied() { notifications++; } };
	const f = fixture(authority);
	const captured = api.getWorkerDecisionAuthoritySnapshot(f.sessionId);
	assert.equal(captured.kind, "active");
	if (captured.kind !== "active") return;
	f.registration.dispose();
	const replacement = api.registerWorkerDecisionAuthority({ ...f.registrationInput, authority });
	try {
		assert.deepEqual(await api.prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: captured.generation } }), { kind: "blocked", reason: "stale-owner" });
		api.disposeWorkerDecisionSession(f.sessionId);
		assert.deepEqual(await api.prepareWorkerDecision(f.input), { kind: "blocked", reason: "session-disposed" });
		assert.equal(calls, 0);
		assert.equal(notifications, 0);
	} finally { replacement.dispose(); }
});

it("R04-pending: matching invalidation aborts pending work and reload cannot reassess consumed identity", async () => {
	const entered = deferred<void>();
	const answer = deferred<WorkerDecision>();
	let calls = 0;
	let notifications = 0;
	let signal!: AbortSignal;
	const authority: WorkerDecisionAuthority = {
		async decide(_, context) { calls++; signal = context.signal; entered.resolve(); return answer.promise; },
		onApplied() { notifications++; },
	};
	const f = fixture(authority);
	const pending = api.prepareWorkerDecision(f.input);
	await entered.promise;
	assert.equal(api.invalidateWorkerDecisionAuthority(f.sessionId, f.registration.generation), true);
	assert.equal(signal.aborted, true);
	assert.deepEqual(await pending, { kind: "blocked", reason: "stale-owner" });
	assert.deepEqual(api.getWorkerDecisionAuthoritySnapshot(f.sessionId), { kind: "missing" });
	assert.deepEqual(api.getWorkerDecisionState(f.sessionId, "leaf-1"), { kind: "consumed", state: "blocked" });
	const replacement = api.registerWorkerDecisionAuthority(f.registrationInput);
	try {
		answer.resolve(decision);
		assert.deepEqual(await api.prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: replacement.generation, runtimeAttemptId: "attempt-2" } }), { kind: "blocked", reason: "stale-owner" });
		assert.equal(calls, 1);
		assert.equal(notifications, 0);
		assert.equal(api.getWorkerDecisionState(f.sessionId, "leaf-1").kind, "consumed");
	} finally { replacement.dispose(); }
});

it("R04-committed: nonterminal invalidation retains committed pair across new generation", async () => {
	let calls = 0;
	let notifications = 0;
	let validations = 0;
	const authority: WorkerDecisionAuthority = { async decide() { calls++; return decision; }, onApplied() { notifications++; } };
	const f = fixture(authority);
	f.input.host.validate = async () => { validations++; return { kind: "valid" }; };
	const committed = await api.prepareWorkerDecision(f.input);
	assert.equal(committed.kind, "committed");
	assert.equal(api.invalidateWorkerDecisionAuthority(f.sessionId, f.registration.generation), true);
	const replacement = api.registerWorkerDecisionAuthority(f.registrationInput);
	try {
		assert.deepEqual(await api.prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: replacement.generation, runtimeAttemptId: "attempt-2" } }), committed);
		assert.equal(calls, 1);
		assert.equal(notifications, 1);
		assert.equal(validations, 2);
		assert.deepEqual(await api.prepareWorkerDecision({ ...f.input, facts: { task: "Changed task" }, control: { ...f.input.control, ownerGeneration: replacement.generation } }), { kind: "blocked", reason: "identity-conflict" });
	} finally { replacement.dispose(); }
});

it("R04-indeterminate: nonterminal invalidation never reopens a crashed assessment", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; throw new Error("local fixture failure"); } });
	assert.deepEqual(await api.prepareWorkerDecision(f.input), { kind: "blocked", reason: "consumed-indeterminate" });
	assert.equal(api.invalidateWorkerDecisionAuthority(f.sessionId, f.registration.generation), true);
	const replacement = api.registerWorkerDecisionAuthority(f.registrationInput);
	try {
		assert.deepEqual(await api.prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: replacement.generation } }), { kind: "blocked", reason: "consumed-indeterminate" });
		assert.equal(calls, 1);
	} finally { replacement.dispose(); }
});

it("R05-stale: stale invalidator cannot abort pending replacement generation", async () => {
	const f = fixture();
	assert.equal(api.invalidateWorkerDecisionAuthority(f.sessionId, f.registration.generation), true);
	assert.equal(api.invalidateWorkerDecisionAuthority(f.sessionId, f.registration.generation), false);
	const entered = deferred<void>();
	const answer = deferred<WorkerDecision>();
	let signal!: AbortSignal;
	const replacement = api.registerWorkerDecisionAuthority({ ...f.registrationInput, authority: { async decide(_, context) { signal = context.signal; entered.resolve(); return answer.promise; } } });
	try {
		const pending = api.prepareWorkerDecision({ ...f.input, control: { ...f.input.control, ownerGeneration: replacement.generation } });
		await entered.promise;
		assert.equal(api.invalidateWorkerDecisionAuthority(f.sessionId, f.registration.generation), false);
		f.registration.dispose();
		assert.equal(signal.aborted, false);
		assert.deepEqual(api.getWorkerDecisionAuthoritySnapshot(f.sessionId), { kind: "active", generation: replacement.generation, lifetimeDeadline: 10000, assessmentTimeoutMs: 250 });
		answer.resolve(decision);
		assert.equal((await pending).kind, "committed");
	} finally { replacement.dispose(); }
});

for (const mode of ["routing-capacity", "routing-ids"] as const) {
	it(`R06-${mode === "routing-capacity" ? "capacity" : "id"}: read misses and invalidation preserve bounded admission`, () => {
		const fixturePath = fileURLToPath(new URL("../support/worker-decision-authority-capacity.ts", import.meta.url));
		assert.match(execFileSync(process.execPath, ["--experimental-strip-types", fixturePath, mode], { encoding: "utf8" }), /Capacity boundary verified/);
	});
}

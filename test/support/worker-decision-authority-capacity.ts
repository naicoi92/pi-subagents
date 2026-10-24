import assert from "node:assert/strict";
import {
	disposeWorkerDecisionSession, getWorkerDecisionState, prepareWorkerDecision,
	getWorkerDecisionAuthoritySnapshot, invalidateWorkerDecisionAuthority,
	registerWorkerDecisionAuthority, WorkerDecisionAuthorityError, WORKER_DECISION_AUTHORITY_LIMITS,
	type PrepareWorkerDecisionInput, type WorkerDecision,
} from "../../src/api/worker-decision-authority.ts";

// Run each mode in a fresh process. Literal boundaries come from the correction acceptance matrix.
assert.deepEqual(WORKER_DECISION_AUTHORITY_LIMITS, { retainedSessions: 256, entriesPerSession: 256, totalEntries: 4096, idBytes: 256 });
const selected: WorkerDecision = { kind: "apply", model: "provider/target", thinking: "medium", reason: "assessed" };
let assessments = 0;
let validations = 0;
let notifications = 0;
const authority = { async decide() { assessments++; return selected; }, onApplied() { notifications++; } };
function register(sessionId: string) { return registerWorkerDecisionAuthority({ sessionId, lifetimeDeadline: 5000, assessmentTimeoutMs: 1000, authority }); }
function input(sessionId: string, generation: string, logicalLaunchId: string): PrepareWorkerDecisionInput {
	return {
		sessionId,
		control: { logicalLaunchId, runtimeAttemptId: "attempt-1", ownerGeneration: generation, context: "fresh", launchDeadline: 5000 },
		facts: { task: "Implement bounded parser" },
		policyContext: { definitionRevision: "d1", constraintRevision: "c1", modelContract: { kind: "selectable", models: ["provider/target"] }, original: { kind: "unresolved", reason: "thinking-unresolved" } },
		classifierTimeoutMs: 1000,
		clock: { now: () => 1000, schedule: () => () => {} },
		host: {
			getCurrentRevisions() { return { definitionRevision: "d1", constraintRevision: "c1" }; },
			async resolveTarget() { return { kind: "unresolved", reason: "target-unavailable" }; },
			async validate() { validations++; return { kind: "valid" }; },
		},
	};
}
function hasReason(reason: string) { return (error: unknown) => error instanceof WorkerDecisionAuthorityError && error.reason === reason; }
const capacity = { kind: "blocked", reason: "capacity-exceeded" };

switch (process.argv[2]) {
	case "sessions": {
		const first = register("session-0");
		const firstInput = input("session-0", first.generation, "leaf");
		const committed = await prepareWorkerDecision(firstInput);
		assert.equal(committed.kind, "committed");
		for (let n = 1; n < 256; n++) register(`session-${n}`).dispose();
		assert.throws(() => register("session-over"), hasReason("capacity-exceeded"));
		assert.throws(() => disposeWorkerDecisionSession("tombstone-over"), hasReason("capacity-exceeded"));
		assert.deepEqual(await prepareWorkerDecision(firstInput), committed);
		assert.equal(assessments, 1);
		assert.equal(validations, 2);
		assert.equal(notifications, 1);
		break;
	}
	case "tombstones": {
		for (let n = 0; n < 256; n++) disposeWorkerDecisionSession(`terminal-${n}`);
		assert.throws(() => disposeWorkerDecisionSession("terminal-over"), hasReason("capacity-exceeded"));
		assert.throws(() => register("new-session"), hasReason("capacity-exceeded"));
		// Existing tombstones remain terminal at saturation; disposal cannot erase evidence or charge twice.
		disposeWorkerDecisionSession("terminal-255");
		assert.throws(() => register("terminal-255"), hasReason("session-disposed"));
		assert.equal(assessments, 0);
		break;
	}
	case "session-entries": {
		const owner = register("entries");
		for (let n = 0; n < 255; n++) assert.equal((await prepareWorkerDecision(input("entries", owner.generation, `leaf-${n}`))).kind, "committed");
		let release!: (decision: WorkerDecision) => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const pendingReply = new Promise<WorkerDecision>((resolve) => { release = resolve; });
		// Same registered callback object is snapshotted; replace owner, not its callback, to pause final slot.
		owner.dispose();
		const replacement = registerWorkerDecisionAuthority({ sessionId: "entries", lifetimeDeadline: 5000, assessmentTimeoutMs: 1000, authority: { async decide() { assessments++; entered(); return pendingReply; }, onApplied() { notifications++; } } });
		const finalInput = input("entries", replacement.generation, "leaf-255");
		const pending = prepareWorkerDecision(finalInput);
		await started;
		const duplicate = prepareWorkerDecision(finalInput);
		const over = input("entries", replacement.generation, "leaf-over");
		Object.defineProperty(over, "facts", { get() { assert.fail("Saturated admission must not project/hash new task"); } });
		assert.deepEqual(await prepareWorkerDecision(over), capacity);
		assert.equal(assessments, 256);
		release(selected);
		assert.deepEqual(await duplicate, await pending);
		assert.equal((await prepareWorkerDecision(input("entries", replacement.generation, "leaf-0"))).kind, "committed");
		assert.equal(assessments, 256);
		assert.equal(notifications, 256);
		break;
	}
	case "total-entries": {
		let finalInput!: PrepareWorkerDecisionInput;
		for (let s = 0; s < 16; s++) {
			const sessionId = `total-${s}`;
			const owner = register(sessionId);
			for (let n = 0; n < 256; n++) {
				finalInput = input(sessionId, owner.generation, `leaf-${n}`);
				assert.equal((await prepareWorkerDecision(finalInput)).kind, "committed");
			}
		}
		assert.equal(assessments, 4096);
		const fresh = register("total-over");
		const over = input("total-over", fresh.generation, "new-leaf");
		assert.deepEqual(await prepareWorkerDecision(over), capacity);
		assert.deepEqual(getWorkerDecisionState("total-over", "new-leaf"), { kind: "unconsumed" });
		assert.equal((await prepareWorkerDecision(finalInput)).kind, "committed");
		assert.equal(assessments, 4096);
		assert.equal(notifications, 4096);
		break;
	}
	case "ids": {
		const exact = "é".repeat(128); // 256 UTF-8 bytes, not 256 characters.
		const over = `${exact}x`;
		const owner = register(exact);
		const valid = input(exact, owner.generation, exact);
		assert.equal((await prepareWorkerDecision({ ...valid, control: { ...valid.control, runtimeAttemptId: exact } })).kind, "committed");
		for (const invalid of [over, "", " padded", "bad\0id", 7, null]) {
			const bad = invalid as string;
			assert.throws(() => register(bad), hasReason("invalid-request"));
			assert.throws(() => disposeWorkerDecisionSession(bad), hasReason("invalid-request"));
			assert.throws(() => getWorkerDecisionState(bad, "leaf"), hasReason("invalid-request"));
			assert.throws(() => getWorkerDecisionState(exact, bad), hasReason("invalid-request"));
			assert.deepEqual(await prepareWorkerDecision({ ...valid, sessionId: bad }), { kind: "blocked", reason: "invalid-request" });
			for (const field of ["logicalLaunchId", "runtimeAttemptId", "ownerGeneration"] as const) {
				assert.deepEqual(await prepareWorkerDecision({ ...valid, control: { ...valid.control, [field]: invalid } } as PrepareWorkerDecisionInput), { kind: "blocked", reason: "invalid-request" });
			}
		}
		assert.deepEqual(await prepareWorkerDecision({ ...valid, control: { ...valid.control, ownerGeneration: exact } }), { kind: "blocked", reason: "stale-owner" });
		assert.equal(assessments, 1);
		disposeWorkerDecisionSession(exact);
		assert.throws(() => register(exact), hasReason("session-disposed"));
		break;
	}
	case "routing-capacity": {
		for (let n = 0; n < 1024; n++) {
			assert.deepEqual(getWorkerDecisionAuthoritySnapshot(`absent-${n}`), { kind: "never-owned" });
			assert.equal(invalidateWorkerDecisionAuthority(`absent-${n}`, "expected-generation"), false);
		}
		for (let n = 0; n < 256; n++) {
			const sessionId = `routing-${n}`;
			const owner = register(sessionId);
			assert.equal(invalidateWorkerDecisionAuthority(sessionId, owner.generation), true);
		}
		assert.throws(() => register("routing-over"), hasReason("capacity-exceeded"));
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot("absent-over"), { kind: "never-owned" });
		assert.equal(invalidateWorkerDecisionAuthority("absent-over", "expected-generation"), false);
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot("routing-255"), { kind: "missing" });
		const replacement = register("routing-255");
		assert.equal(getWorkerDecisionAuthoritySnapshot("routing-255").kind, "active");
		disposeWorkerDecisionSession("routing-255");
		assert.equal(invalidateWorkerDecisionAuthority("routing-255", replacement.generation), false);
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot("routing-255"), { kind: "disposed" });
		assert.throws(() => register("routing-255"), hasReason("session-disposed"));
		break;
	}
	case "routing-ids": {
		const exact = "é".repeat(128);
		const invalidIds = [`${exact}x`, "", " padded", "bad\0id", 7, null];
		for (const invalid of invalidIds) {
			const bad = invalid as string;
			assert.throws(() => getWorkerDecisionAuthoritySnapshot(bad), hasReason("invalid-request"));
			assert.throws(() => invalidateWorkerDecisionAuthority(bad, "generation"), hasReason("invalid-request"));
			assert.throws(() => invalidateWorkerDecisionAuthority("absent", bad), hasReason("invalid-request"));
		}
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot(exact), { kind: "never-owned" });
		assert.equal(invalidateWorkerDecisionAuthority(exact, exact), false);
		const owner = register(exact);
		for (const invalid of invalidIds) assert.throws(() => invalidateWorkerDecisionAuthority(exact, invalid as string), hasReason("invalid-request"));
		assert.equal(getWorkerDecisionAuthoritySnapshot(exact).kind, "active");
		assert.equal(invalidateWorkerDecisionAuthority(exact, exact), false);
		assert.equal(invalidateWorkerDecisionAuthority(exact, owner.generation), true);
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot(exact), { kind: "missing" });
		break;
	}
	default: throw new Error("Unknown capacity fixture mode");
}
console.log(`Capacity boundary verified: ${process.argv[2]}`);

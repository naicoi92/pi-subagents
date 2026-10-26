import assert from "node:assert/strict";
import { it } from "node:test";
import { readNativeWorkerAuthorityRouting } from "../../src/shared/native-worker-authority-routing.ts";
import { prepareNativeWorkerDecision, type NativeWorkerDecisionInput } from "../../src/runs/shared/native-worker-decision.ts";
import { getWorkerDecisionAuthoritySnapshot, invalidateWorkerDecisionAuthority, registerWorkerDecisionAuthority, type WorkerDecisionAuthority, type WorkerDecisionRequest } from "../../src/api/worker-decision-authority.ts";

let seq = 0;
function fixture(authority: WorkerDecisionAuthority) {
	const sessionId = `native-preparation-${++seq}`;
	const registration = registerWorkerDecisionAuthority({ sessionId, lifetimeDeadline: Date.now() + 30000, assessmentTimeoutMs: 250, authority });
	const input: NativeWorkerDecisionInput = {
		sessionId, routing: getWorkerDecisionAuthoritySnapshot(sessionId), logicalLaunchId: "leaf-0",
		agent: { name: "fixture", source: "runtime", filePath: "runtime:fixture", description: "Parser review", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, model: "fixture/original", thinking: "high" },
		task: "Review parser", context: "fresh", originalModel: "fixture/original:high", originalThinking: "high", originalProvenance: "host-effective", comparison: { kind: "resolved", model: "fixture/original", provenance: "parent" }, timeoutMs: 5000, signal: new AbortController().signal,
		getConstraints: () => ({ availableModels: ["original", "target"].map((id) => ({ provider: "fixture", id, fullId: `fixture/${id}`, reasoning: true, thinkingLevelMap: { medium: "medium", high: "high" } })), modelScopes: [], admission: {} }),
		admit() {},
	};
	return { input, registration };
}
const selected = { kind: "apply" as const, model: "fixture/target", thinking: "medium" as const, reason: "assessed" as const };

it("N08-fixed: only explicit trusted fixed contract refuses model remap", async () => {
	const f = fixture({ async decide(request) { assert.deepEqual(request.policyContext.modelContract, { kind: "fixed", model: "fixture/original" }); return selected; } });
	f.input.modelContract = { kind: "fixed", model: "fixture/original" };
	try { await assert.rejects(prepareNativeWorkerDecision(f.input), /scope-denied/); }
	finally { f.registration.dispose(); }
});

it("N08-scope-live: explicit pair cannot retain inherited warning-only scope exemption", async () => {
	const f = fixture({ async decide() { return selected; } });
	const constraints = f.input.getConstraints(); constraints.modelScopes = [{ enforce: true, strict: false, allow: ["fixture/original"], origin: "fixture" }];
	f.input.getConstraints = () => constraints;
	try { await assert.rejects(prepareNativeWorkerDecision(f.input), /scope-denied/); }
	finally { f.registration.dispose(); }
});

it("N08-revision: live constraint tightening during assessment cannot commit", async () => {
	const f = fixture({ async decide() { constraints.thinkingCeiling = "low"; return selected; } });
	const constraints = f.input.getConstraints(); f.input.getConstraints = () => constraints;
	try { await assert.rejects(prepareNativeWorkerDecision(f.input), /stale-revisions/); }
	finally { f.registration.dispose(); }
});

it("N10-recovery: legitimate attempts reuse one logical commitment without new assessment or notification", async () => {
	let assessments = 0; let notifications = 0; let admissions = 0; let captured!: WorkerDecisionRequest;
	const f = fixture({ async decide(request) { assessments++; captured = request; return selected; }, onApplied() { notifications++; } });
	f.input.admit = () => { admissions++; };
	try {
		const prepared = await prepareNativeWorkerDecision(f.input);
		const before = captured.control.runtimeAttemptId;
		await prepared.revalidate(); await prepared.revalidate();
		assert.equal(prepared.receipt.model, "fixture/target"); assert.equal(prepared.receipt.thinking, "medium");
		assert.equal(assessments, 1); assert.equal(notifications, 1); assert.equal(admissions, 3);
		assert.ok(before); assert.equal(captured.facts.task, "Review parser");
	} finally { f.registration.dispose(); }
});

it("N11-deadline-missing: no finite launch duration blocks without borrowing owner lifetime", async () => {
	let calls = 0;
	const f = fixture({ async decide() { calls++; return selected; } });
	try {
		for (const timeoutMs of [undefined, Infinity, NaN, 0, -1]) await assert.rejects(prepareNativeWorkerDecision({ ...f.input, timeoutMs }), /invalid-deadline/);
		assert.equal(calls, 0);
	} finally { f.registration.dispose(); }
});


it("N11-deadline: host duration anchors once; owner budget and 500ms reserve stay separate", async (t) => {
	const start = Date.now();
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
	let cutoff = 0; let hardDeadline = 0;
	const f = fixture({ async decide(request, control) {
		assert.equal(request.control.launchDeadline, start + 1000);
		cutoff = control.assessmentCutoff; hardDeadline = control.hardDeadline;
		t.mock.timers.setTime(start + 100); return selected;
	} });
	f.input.timeoutMs = 1000;
	try {
		const prepared = await prepareNativeWorkerDecision(f.input);
		assert.equal(prepared.deadlineAt, start + 1000); assert.equal(hardDeadline, start + 1000);
		assert.ok(cutoff >= start + 250 && cutoff < start + 300); // Registration budget, not an executor-selected default.
		t.mock.timers.setTime(start + 200); await prepared.revalidate(); assert.equal(prepared.deadlineAt, start + 1000);
		t.mock.timers.setTime(start + 1000); assert.throws(prepared.assertCurrent, /deadline-exceeded/);
	} finally { f.registration.dispose(); }
});

it("N11-deadline-reserve: exhausted assessment may explicitly retain pair before hard deadline", async (t) => {
	const start = Date.now();
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
	const f = fixture({ async decide(_request, control) {
		assert.equal(control.assessmentAvailable, false); assert.equal(control.assessmentCutoff, start - 100); assert.equal(control.hardDeadline, start + 400);
		return selected;
	} });
	f.input.timeoutMs = 400;
	try { assert.equal((await prepareNativeWorkerDecision(f.input)).deadlineAt, start + 400); }
	finally { f.registration.dispose(); }
});

it("N11-deadline-owner: finite lifetime tightens hard authority, never substitutes host duration", async (t) => {
	const start = Date.now();
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
	let applied = 0;
	const f = fixture({ async decide(_request, control) {
		assert.equal(control.hardDeadline, start + 30000); assert.ok(control.assessmentCutoff >= start + 250 && control.assessmentCutoff < start + 300);
		t.mock.timers.tick(30000); return selected;
	}, onApplied() { applied++; } });
	f.input.timeoutMs = 60000;
	try { await assert.rejects(prepareNativeWorkerDecision(f.input), /deadline-exceeded/); assert.equal(applied, 0); }
	finally { f.registration.dispose(); }
});

it("N11-reentrant-final: revision getter invalidation cannot pass synchronous launch fence", async () => {
	const f = fixture({ async decide() { return selected; } });
	try {
		const prepared = await prepareNativeWorkerDecision(f.input);
		const constraints = f.input.getConstraints();
		f.input.getConstraints = () => { invalidateWorkerDecisionAuthority(f.input.sessionId, f.registration.generation); return constraints; };
		assert.throws(prepared.assertCurrent, /stale-owner/);
	} finally { f.registration.dispose(); }
});


for (const kind of ["nonreasoning-high", "unknown-support"] as const) it(`N07-${kind}: requested high is not verified effective effort`, async () => {
	const f = fixture({ async decide(request, control) {
		assert.deepEqual(request.policyContext.original, { kind: "unresolved", reason: "thinking-unresolved" });
		const target = await control.resolveTarget("fixture/target"); assert.equal(target.kind, "resolved");
		if (target.kind === "resolved") assert.deepEqual(target.baseline, { kind: "unresolved", reason: "thinking-unresolved" });
		return { ...selected, thinking: "medium" };
	} });
	const constraints = f.input.getConstraints();
	constraints.availableModels[0] = { provider: "fixture", id: "original", fullId: "fixture/original", reasoning: kind === "nonreasoning-high" ? false : true };
	constraints.availableModels[1]!.thinkingLevelMap = { medium: "medium" };
	f.input.getConstraints = () => constraints;
	try { assert.equal((await prepareNativeWorkerDecision(f.input)).receipt.thinking, "medium"); }
	finally { f.registration.dispose(); }
});


it("N11-long-file-owned: compatibility never hides explicit ownership or malformed non-file identity", () => {
	const file = `/${"nested/".repeat(40)}session.jsonl`;
	const manager = { getSessionFile: () => file, getSessionId: () => "different-uuid" };
	assert.deepEqual(readNativeWorkerAuthorityRouting(manager), { sessionId: file, routing: { kind: "never-owned" } });
	assert.throws(() => readNativeWorkerAuthorityRouting(manager, "captured-generation"), /invalid-request/);
	assert.throws(() => readNativeWorkerAuthorityRouting({ getSessionFile: () => null, getSessionId: () => "x".repeat(257) }), /invalid-request/);
	assert.throws(() => readNativeWorkerAuthorityRouting({ getSessionFile: () => "bad\0file", getSessionId: () => "valid-uuid" }), /invalid-request/);
	assert.throws(() => readNativeWorkerAuthorityRouting({ getSessionFile: () => `${file}\0`, getSessionId: () => "valid-uuid" }), /invalid-request/);
	assert.throws(() => readNativeWorkerAuthorityRouting({ getSessionFile: () => "missing-owner-key", getSessionId: () => "valid-uuid" }, "captured-generation"), /owner-missing/);
});

for (const source of ["project", "runtime"] as const) it(`NAT-NAME-${source}: resolved agent name is factual without description or private configuration`, async () => {
	let calls = 0;
	const f = fixture({ async decide(request) {
		calls++;
		assert.deepEqual(request.facts, { task: "Review parser", role: { name: "package/specialized-reviewer", description: "", provenance: "resolved-agent" } });
		assert.equal(request.policyContext.original.kind, "verified");
		if (request.policyContext.original.kind === "verified") assert.equal(request.policyContext.original.thinking, "high");
		return selected;
	} });
	Object.assign(f.input.agent, { source, name: "package/specialized-reviewer", localName: "caller-label", aliases: ["junior"], description: "", systemPrompt: "PRIVATE SYSTEM PROMPT", steering: "PRIVATE STEERING" });
	try {
		const prepared = await prepareNativeWorkerDecision(f.input);
		await prepared.revalidate();
		assert.equal(calls, 1);
	} finally { f.registration.dispose(); }
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { registerAgent } from "../../src/api/agents.ts";
import { getWorkerDecisionAuthoritySnapshot, registerWorkerDecisionAuthority, type WorkerDecisionAuthority, type WorkerDecisionAuthorityRegistration } from "../../src/api/worker-decision-authority.ts";
import { prepareNativeWorkerDecision, type NativeWorkerDecisionInput } from "../../src/runs/shared/native-worker-decision.ts";
import { createMockPi } from "../support/mock-pi.ts";

let seq = 0;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function context() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-lifecycle-")); roots.push(root);
	const sessionId = path.join(root, `session-${++seq}.jsonl`);
	return {
		root, sessionId, cwd: root, hasUI: false, isIdle: () => true, model: undefined,
		ui: { setWidget() {}, theme: { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } },
		sessionManager: { getSessionId: () => `uuid-${seq}`, getSessionFile: () => sessionId, getEntries: () => [] },
		modelRegistry: { getAvailable: () => ["original", "target"].map((id) => ({ provider: "fixture", id, reasoning: true, thinkingLevelMap: { medium: "medium", high: "high" } })) },
	};
}
function runtime(ctx: ReturnType<typeof context>) {
	const handlers = new Map<string, Array<(event: any, context: any) => unknown>>();
	const tools = new Map<string, { execute(...args: any[]): Promise<any> }>();
	const pi = new Proxy({
		events: createEventBus(),
		on(name: string, handler: (event: any, context: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: { name: string; execute(...args: any[]): Promise<any> }) { tools.set(tool.name, tool); },
		getThinkingLevel: () => "high",
	}, { get: (target, property) => property in target ? target[property as keyof typeof target] : () => undefined });
	registerSubagentExtension(pi as never);
	return {
		start: async (reason = "startup") => { for (const handler of handlers.get("session_start") ?? []) await handler({ reason }, ctx); },
		shutdown: async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx); },
		launch: (async: boolean) => tools.get("subagent")!.execute("lifecycle-launch", { agent: "runtime-fixture", task: "Review parser", async, options: { artifacts: false, acceptance: false, timeoutMs: 5000 } }, new AbortController().signal, undefined, ctx),
		registerAgent: () => registerAgent({ pi: pi as never, name: "runtime-fixture", definition: { description: "Parser review", systemPrompt: "Review parser correctness.", model: "fixture/original", thinking: "high", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false } }),
	};
}
function register(ctx: ReturnType<typeof context>, authority: WorkerDecisionAuthority) {
	return registerWorkerDecisionAuthority({ sessionId: ctx.sessionId, lifetimeDeadline: Date.now() + 30000, assessmentTimeoutMs: 1000, authority });
}
const selected = { kind: "apply" as const, model: "fixture/target", thinking: "medium" as const, reason: "assessed" as const };

for (const async of [false, true]) it(`N11-disposal-${async ? "async" : "foreground"}: admission-captured owner aborts on cleanup before commit/create/spawn`, async (t) => {
	const ctx = context(); const r = runtime(ctx); await r.start(); r.registerAgent();
	const mock = createMockPi(); mock.install();
	const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected native spawn"); }); syncBuiltinESMExports();
	let entered!: () => void; const pending = new Promise<void>((resolve) => { entered = resolve; });
	let ownerSignal!: AbortSignal; let applied = 0;
	const registration = register(ctx, { async decide(_request, control) { ownerSignal = control.signal; entered(); await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true })); return selected; }, onApplied() { applied++; } });
	try {
		const result = assert.rejects(r.launch(async), /stale-owner/); await pending; await r.shutdown();
		await result; assert.equal(ownerSignal.aborted, true);
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot(ctx.sessionId), { kind: "missing" });
		assert.equal(applied, 0); assert.equal(mock.sessions.length, 0); assert.equal(spawn.mock.callCount(), 0);
	} finally { registration.dispose(); await r.shutdown(); mock.uninstall(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("N11-replacement: old captured cleanup cannot kill uncaptured replacement", async () => {
	const ctx = context(); const old = register(ctx, { async decide() { return selected; } });
	const r = runtime(ctx); await r.start(); old.dispose();
	const replacement = register(ctx, { async decide() { return selected; } });
	try { await r.shutdown(); const state = getWorkerDecisionAuthoritySnapshot(ctx.sessionId); assert.equal(state.kind, "active"); if (state.kind === "active") assert.equal(state.generation, replacement.generation); }
	finally { replacement.dispose(); }
});

it("N11-reentrant: abort listener may register replacement without old cleanup invalidating it", async () => {
	const ctx = context(); let entered!: () => void; const pending = new Promise<void>((resolve) => { entered = resolve; });
	let replacement: WorkerDecisionAuthorityRegistration | undefined;
	const old = register(ctx, { async decide(_request, control) {
		control.signal.addEventListener("abort", () => { replacement = register(ctx, { async decide() { return selected; } }); }, { once: true });
		entered(); return await new Promise<never>(() => {});
	} });
	const r = runtime(ctx); await r.start(); r.registerAgent(); const mock = createMockPi(); mock.install();
	try {
		const result = assert.rejects(r.launch(false), /stale-owner/); await pending; await r.shutdown();
		await result; assert.ok(replacement);
		const state = getWorkerDecisionAuthoritySnapshot(ctx.sessionId); assert.equal(state.kind, "active"); if (state.kind === "active") assert.equal(state.generation, replacement.generation);
		await r.shutdown(); assert.equal(getWorkerDecisionAuthoritySnapshot(ctx.sessionId).kind, "active"); assert.equal(mock.sessions.length, 0);
	} finally { old.dispose(); replacement?.dispose(); await r.shutdown(); mock.uninstall(); }
});

it("N11-late-registration: unobserved no-launch registration belongs to registrant disposer", async () => {
	const ctx = context(); const r = runtime(ctx); await r.start();
	const late = register(ctx, { async decide() { throw new Error("no assessment expected"); } });
	await r.shutdown(); assert.equal(getWorkerDecisionAuthoritySnapshot(ctx.sessionId).kind, "active");
	late.dispose(); assert.deepEqual(getWorkerDecisionAuthoritySnapshot(ctx.sessionId), { kind: "missing" });
});

it("N11-reload: same-session replacement retains consumed commitment without reassessment", async () => {
	const ctx = context(); let calls = 0; let applied = 0;
	const authority: WorkerDecisionAuthority = { async decide() { calls++; return selected; }, onApplied() { applied++; } };
	const first = register(ctx, authority); const before = runtime(ctx); await before.start();
	const input: NativeWorkerDecisionInput = {
		sessionId: ctx.sessionId, routing: getWorkerDecisionAuthoritySnapshot(ctx.sessionId), logicalLaunchId: "stable-leaf",
		agent: { name: "runtime-fixture", source: "runtime", filePath: "runtime:runtime-fixture", description: "Parser review", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false },
		task: "Review parser", context: "fresh", originalModel: "fixture/original:high", originalThinking: "high", originalProvenance: "host-effective", timeoutMs: 5000, signal: new AbortController().signal,
		getConstraints: () => ({ availableModels: ctx.modelRegistry.getAvailable().map((model) => ({ ...model, fullId: `${model.provider}/${model.id}` })), modelScopes: [], admission: {} }), admit() {},
	};
	let second: WorkerDecisionAuthorityRegistration | undefined; let after: ReturnType<typeof runtime> | undefined;
	try {
		const prepared = await prepareNativeWorkerDecision(input); await before.shutdown();
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot(ctx.sessionId), { kind: "missing" });
		second = register(ctx, authority); after = runtime(ctx); await after.start("reload");
		const recovered = await prepareNativeWorkerDecision({ ...input, routing: getWorkerDecisionAuthoritySnapshot(ctx.sessionId) });
		assert.deepEqual(recovered.receipt, prepared.receipt); assert.equal(calls, 1); assert.equal(applied, 1);
	} finally { first.dispose(); second?.dispose(); await before.shutdown(); await after?.shutdown(); }
});


it("N11-replacement-runtime: replacing extension aborts only previously captured generation", async () => {
	const ctx = context(); const first = register(ctx, { async decide() { return selected; } });
	const before = runtime(ctx); await before.start(); const after = runtime(ctx);
	let second: WorkerDecisionAuthorityRegistration | undefined;
	try {
		await after.start("reload"); assert.deepEqual(getWorkerDecisionAuthoritySnapshot(ctx.sessionId), { kind: "missing" });
		second = register(ctx, { async decide() { return selected; } });
		await before.shutdown(); assert.equal(getWorkerDecisionAuthoritySnapshot(ctx.sessionId).kind, "active");
		await after.shutdown(); assert.equal(getWorkerDecisionAuthoritySnapshot(ctx.sessionId).kind, "active", "late no-launch owner was never observed by new runtime");
	} finally { first.dispose(); second?.dispose(); await before.shutdown(); await after.shutdown(); }
});


it("N11-long-file-start: overlength never-owned file identity keeps session start/shutdown usable", async () => {
	const ctx = context(); const file = path.join(ctx.root, "nested/".repeat(40), "parent.jsonl"); ctx.sessionManager.getSessionFile = () => file;
	fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "");
	assert.ok(Buffer.byteLength(file, "utf8") > 256);
	const r = runtime(ctx);
	try { await r.start(); }
	finally { await r.shutdown(); }
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { registerWorkerDecisionAuthority, invalidateWorkerDecisionAuthority, getWorkerDecisionAuthoritySnapshot, disposeWorkerDecisionSession, type WorkerDecisionAuthority, type WorkerDecision, type WorkerDecisionRequest, type AppliedWorkerDecision } from "../../src/api/worker-decision-authority.ts";
import { createMockPi } from "../support/mock-pi.ts";
import * as os from "node:os";
import { resolveLaunchBinding, stableJsonDigest } from "../../src/shared/launch-contract.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { buildEffectiveSystemPrompt } from "../../src/runs/shared/effective-system-prompt.ts";
import { childSessionFactory, setChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

let seq = 0;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(modelScope?: import("../../src/runs/shared/model-scope.ts").ModelScopeConfig) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-authority-")); roots.push(root);
	const ctx = {
		cwd: root, hasUI: false, ui: {}, model: undefined as { provider: string; id: string } | undefined,
		sessionManager: { getSessionId: () => "", getSessionFile: (): string | null => null },
		modelRegistry: { getAvailable: (): Array<{ provider: string; id: string; reasoning: boolean; thinkingLevelMap?: { low?: string; medium: string; high: string } }> => [] },
	};
	const sessionId = `native-authority-${++seq}`;
	ctx.sessionManager.getSessionId = () => sessionId;
	ctx.modelRegistry.getAvailable = () => ["original", "target"].map((id) => ({ provider: "fixture", id, reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high" } }));
	const agent: AgentConfig = { name: "runtime-worker", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, filePath: "", source: "runtime", model: "fixture/original", thinking: "high", description: "Reviews bounded parser correctness", definitionDigest: "runtime-definition-1" };
	const executor = createSubagentExecutor({
		pi: { events: { on() { return () => {}; }, emit() {} }, getSessionName() {} } as any,
		state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null } as any,
		config: { intercomBridge: { mode: "off" } }, asyncByDefault: false, tempArtifactsDir: root,
		getSubagentSessionRoot: () => path.join(root, "sessions"), expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent], modelScope }),
	});
	return { root, ctx, sessionId, agent, executor };
}

it("N01-foreground: actual executor invokes authority before scripted factory with authored facts", async () => {
	const f = fixture(); const mock = createMockPi(); mock.install();
	let calls = 0; const applied: AppliedWorkerDecision[] = [];
	const registration = registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: Date.now() + 30000, assessmentTimeoutMs: 1000, authority: {
		async decide(request) {
			calls++; assert.equal(mock.sessions.length, 0);
			assert.equal(request.facts.task, "Implement bounded parser; keep high/deep/medium tokens.");
			assert.deepEqual(request.facts.role, { name: f.agent.name, description: f.agent.description, provenance: "resolved-agent" });
			return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
		}, onApplied(receipt) { applied.push(receipt); },
	} });
	try {
		mock.onCall({ output: "done" });
		const result = await f.executor.execute("fg", { agent: f.agent.name, task: "Implement bounded parser; keep high/deep/medium tokens.", async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(calls, 1);
		assert.equal(mock.sessions[0]?.launch.model, "fixture/target:medium");
		assert.equal(result.details?.results[0]?.thinking, "medium");
		assert.equal(applied.length, 1);
	} finally { registration.dispose(); mock.uninstall(); }
});

it("NAT-COMPARISON-parent: omitted caller separates parent fast comparison from retained default deep", async () => {
	await withForeground(async (f, mock) => {
		f.ctx.model = { provider: "fixture", id: "fast" };
		f.ctx.modelRegistry.getAvailable = () => ["fast", "deep", "balanced"].map((id) => ({ provider: "fixture", id, reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high" } }));
		f.agent.model = "fixture/deep";
		const registration = owner(f, { async decide(request) {
			assert.deepEqual(request.policyContext.comparison, { kind: "resolved", model: "fixture/fast", provenance: "parent" });
			assert.equal(request.policyContext.original.kind, "verified");
			if (request.policyContext.original.kind === "verified") assert.equal(request.policyContext.original.model, "fixture/deep");
			// Supplies the identities needed by the consumer's .45 balanced-confidence policy.
			return { kind: "apply", model: "fixture/balanced", thinking: "medium", reason: "assessed" };
		} });
		try {
			const result = await launch(f);
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			assert.equal(mock.sessions[0]?.launch.model, "fixture/balanced:medium");
		} finally { registration.dispose(); }
	});
});

it("NAT-COMPARISON-caller: explicit caller model wins parent identity without thinking suffix", async () => {
	await withForeground(async (f, mock) => {
		f.ctx.model = { provider: "fixture", id: "target" };
		const registration = owner(f, { async decide(request) {
			assert.deepEqual(request.policyContext.comparison, { kind: "resolved", model: "fixture/original", provenance: "explicit-caller" });
			assert.equal(request.policyContext.original.kind, "verified");
			if (request.policyContext.original.kind === "verified") {
				assert.equal(request.policyContext.original.provenance, "explicit-launch");
				assert.equal(request.policyContext.original.thinking, "low");
			}
			return selected;
		} });
		try {
			assert.equal((await launch(f, false, undefined, { model: "fixture/original:low" })).isError, undefined);
			assert.equal(mock.sessions[0]?.launch.model, "fixture/target:medium");
		} finally { registration.dispose(); }
	});
});

it("NAT-COMPARISON-thinking: thinking-only delegation never claims explicit caller model provenance", async () => {
	await withForeground(async (f, mock) => {
		f.ctx.model = { provider: "fixture", id: "target" };
		const registration = owner(f, { async decide(request) {
			assert.deepEqual(request.policyContext.comparison, { kind: "resolved", model: "fixture/target", provenance: "parent" });
			const original = request.policyContext.original;
			assert.equal(original.kind, "verified");
			if (original.kind === "verified") { assert.equal(original.provenance, "host-effective"); assert.equal(original.model, "fixture/original"); assert.equal(original.thinking, "low"); }
			return selected;
		} });
		try {
			const result = await f.executor.executeDelegated("thinking-only", { agent: f.agent.name, task: "Review parser", async: false, artifacts: false, acceptance: false, delegatedThinkingOverride: "low" } as never, new AbortController().signal, undefined, f.ctx as never);
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			assert.equal(mock.sessions[0]?.launch.model, "fixture/target:medium");
		} finally { registration.dispose(); }
	});
});

it("NAT-COMPARISON-missing-parent: missing parent remains unresolved instead of borrowing configured worker model", async () => {
	await withForeground(async (f) => {
		const registration = owner(f, { async decide(request) {
			assert.deepEqual(request.policyContext.comparison, { kind: "unresolved", reason: "model-unresolved" });
			return { kind: "reject", reason: "baseline-unresolved" };
		} });
		try { assert.equal((await launch(f)).isError, true); }
		finally { registration.dispose(); }
	});
});

it("N02-async: actual direct async commits exact pair before descriptor and intercepted spawn", async (t) => {
	const f = fixture(); let calls = 0; let launchConfig: any; let asyncDir = "";
	const spawn = t.mock.method(childProcess, "spawn", (_command: string, args?: readonly string[], options?: childProcess.SpawnOptions) => {
		const configPath = options?.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args?.at(-1);
		launchConfig = JSON.parse(fs.readFileSync(String(configPath), "utf8")); asyncDir = launchConfig.asyncDir;
		throw new Error("intercepted fixture spawn");
	}); syncBuiltinESMExports();
	const registration = registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: Date.now() + 30000, assessmentTimeoutMs: 1000, authority: {
		async decide(request) { calls++; assert.equal(spawn.mock.callCount(), 0); assert.equal(request.facts.role?.name, f.agent.name); return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" }; },
	} });
	try {
		await f.executor.execute("async", { agent: f.agent.name, task: "Review parser", async: true, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
		assert.equal(calls, 1);
		assert.equal(spawn.mock.callCount(), 1);
		assert.equal(launchConfig.steps[0].model, "fixture/target:medium");
		assert.equal(launchConfig.steps[0].thinking, "medium");
		const descriptor = JSON.parse(fs.readFileSync(path.join(asyncDir, "recovery-descriptor.json"), "utf8"));
		assert.equal(descriptor.model, "fixture/target:medium");
		assert.equal(descriptor.thinking, "medium");
		assert.equal(descriptor.launchContractDigest, launchConfig.launchContractDigest);
		const model = "fixture/target:medium";
		const expected = resolveLaunchBinding({ agent: f.agent, task: "Review parser", model, thinking: "medium", systemPrompt: buildEffectiveSystemPrompt({ agent: f.agent, resolvedSkills: [], cwd: f.root }), skills: [], toolPlan: resolvePiLaunchToolPlan({ tools: f.agent.tools, model, cwd: f.root, agentName: f.agent.name }), outputMode: "inline" });
		assert.equal(descriptor.launchContractDigest, expected.launchContractDigest);
		assert.equal(descriptor.absoluteDeadlineAt, launchConfig.deadlineAt);
	} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); if (asyncDir) fs.rmSync(asyncDir, { recursive: true, force: true }); }
});

const selected: WorkerDecision = { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
function owner(f: ReturnType<typeof fixture>, authority: WorkerDecisionAuthority) {
	return registerWorkerDecisionAuthority({ sessionId: f.sessionId, lifetimeDeadline: Date.now() + 30000, assessmentTimeoutMs: 1000, authority });
}
function launch(f: ReturnType<typeof fixture>, async = false, signal = new AbortController().signal, extra: Record<string, unknown> = {}) {
	return f.executor.execute(`native-${++seq}`, { agent: f.agent.name, task: "Review parser", async, artifacts: false, acceptance: false, ...extra }, signal, undefined, f.ctx as any);
}
async function withForeground(check: (f: ReturnType<typeof fixture>, mock: ReturnType<typeof createMockPi>) => Promise<void>) {
	const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({ output: "done" });
	try { await check(f, mock); } finally { mock.uninstall(); }
}
for (const async of [false, true]) {
	it(`N03-${async ? "async" : "foreground"}-high: literal authority medium wins configured high`, async (t) => {
		await withForeground(async (f, mock) => {
			let config: any;
			if (async) { t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => { config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8")); throw new Error("intercepted fixture spawn"); }); syncBuiltinESMExports(); }
			const registration = owner(f, { async decide() { return selected; } });
			try {
				const result = await launch(f, async);
				if (async) { assert.equal(config.steps[0].model, "fixture/target:medium"); assert.equal(config.steps[0].thinking, "medium"); fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
				else { assert.equal(mock.sessions[0]?.launch.model, "fixture/target:medium"); assert.equal(result.details?.results[0]?.thinking, "medium"); }
			} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
		});
	});
}

for (const scenario of ["missing", "cancel", "stale", "denied", "owner-missing", "disposed"] as const) {
	it(`N04-${scenario}: invalid authority blocks both launch paths before create/spawn`, async (t) => {
		for (const async of [false, true]) await withForeground(async (f, mock) => {
			const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected spawn"); }); syncBuiltinESMExports();
			const cancel = new AbortController();
			let registration: ReturnType<typeof owner>;
			registration = owner(f, { async decide() {
				if (scenario === "cancel") cancel.abort();
				if (scenario === "stale") registration.dispose();
				return scenario === "missing" ? { kind: "apply", model: "fixture/target", reason: "assessed" } as WorkerDecision : scenario === "denied" ? { kind: "reject", reason: "scope-denied" } : selected;
			} });
			if (scenario === "owner-missing") registration.dispose();
			if (scenario === "disposed") disposeWorkerDecisionSession(f.sessionId);
			try {
				const result = await launch(f, async, cancel.signal);
				assert.equal(result.isError, true, JSON.stringify(result));
				assert.equal(mock.sessions.length, 0); assert.equal(spawn.mock.callCount(), 0);
			} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
		});
	});
}

it("N05-unowned: never-owned role high keeps original binding without authority receipt", async () => {
	await withForeground(async (f, mock) => {
		const result = await launch(f);
		assert.equal(result.isError, undefined);
		assert.equal(mock.sessions[0]?.launch.model, "fixture/original:high");
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot(f.sessionId), { kind: "never-owned" });
		assert.equal("workerDecision" in (result.details ?? {}), false);
	});
});

it("N06-runtime: exact runtime-only definition reaches authority without rediscovery", async () => {
	await withForeground(async (f) => {
		let definition = "";
		const registration = owner(f, { async decide(request) { definition = request.policyContext.definitionRevision; assert.equal(request.facts.role?.description, f.agent.description); assert.equal(request.facts.role?.name, f.agent.name); return selected; } });
		try { assert.equal((await launch(f)).isError, undefined); assert.equal(definition, stableJsonDigest(f.agent)); assert.equal(f.agent.source, "runtime"); assert.equal(fs.existsSync(f.agent.filePath), false); }
		finally { registration.dispose(); }
	});
});

for (const kind of ["explicit", "configured", "unresolved"] as const) {
	it(`N07-${kind}: baseline is source-backed or explicitly unresolved`, async () => {
		await withForeground(async (f) => {
			if (kind === "unresolved") f.agent.thinking = undefined;
			let captured!: WorkerDecisionRequest;
			const registration = owner(f, { async decide(request, context) {
				captured = request;
				assert.equal("thinking" in request.facts, false);
				const target = await context.resolveTarget("fixture/target");
				assert.equal(target.kind, "resolved");
				if (target.kind === "resolved") {
					assert.equal(target.baseline.kind, kind === "unresolved" ? "unresolved" : "verified");
					if (target.baseline.kind === "verified") { assert.equal(target.baseline.model, "fixture/target"); assert.equal(target.baseline.thinking, "high"); }
				}
				return selected;
			} });
			try {
				const result = await launch(f, false, undefined, kind === "explicit" ? { model: "fixture/original:low" } : {});
				assert.equal(result.isError, undefined, JSON.stringify(result.content));
				const baseline = captured.policyContext.original;
				assert.equal(baseline.kind, kind === "unresolved" ? "unresolved" : "verified");
				if (baseline.kind === "verified") { assert.equal(baseline.provenance, kind === "explicit" ? "explicit-launch" : "host-effective"); assert.equal(baseline.thinking, kind === "explicit" ? "low" : "high"); }
			} finally { registration.dispose(); }
		});
	});
}

for (const kind of ["scope", "ceiling", "support", "availability", "admission"] as const) {
	it(`N08-${kind}: final exact pair cannot bypass host constraints`, async () => {
		await withForeground(async (f, mock) => {
			if (kind === "ceiling") f.agent.maxThinking = "low";
			if (kind === "support") f.ctx.modelRegistry.getAvailable = () => [{ provider: "fixture", id: "original", reasoning: true }, { provider: "fixture", id: "target", reasoning: true }];
			if (kind === "admission") f.agent.toolBudget = { hard: -1 };
			const registration = owner(f, { async decide() {
				if (kind === "availability") f.ctx.modelRegistry.getAvailable = () => [];
				return kind === "scope" ? { ...selected, model: "fixture/outside" } : selected;
			} });
			try { assert.equal((await launch(f)).isError, true); assert.equal(mock.sessions.length, 0); }
			finally { registration.dispose(); }
		});
	});
}

it("N09-binding: independently projected native contract contains exact pair, not authority digest", async () => {
	await withForeground(async (f, mock) => {
		let receipt!: AppliedWorkerDecision;
		const registration = owner(f, { async decide() { return selected; }, onApplied(value) { receipt = value; } });
		try {
			const result = await launch(f);
			const model = "fixture/target:medium";
			const plan = resolvePiLaunchToolPlan({ tools: f.agent.tools, model, cwd: f.root, agentName: f.agent.name });
			const expected = resolveLaunchBinding({ agent: f.agent, task: "Review parser", model, thinking: "medium", systemPrompt: buildEffectiveSystemPrompt({ agent: f.agent, resolvedSkills: [], cwd: f.root }), skills: [], toolPlan: plan, outputMode: "inline" });
			assert.equal(mock.sessions[0]?.launch.model, model);
			assert.equal(result.details?.results[0]?.launchContractDigest, expected.launchContractDigest);
			assert.equal(receipt.model, "fixture/target"); assert.equal(receipt.thinking, "medium");
			assert.notEqual(receipt.digest, expected.launchContractDigest);
		} finally { registration.dispose(); }
	});
});


it("N10-recovery-native: compaction resume reuses exact pair and one owner callback", async () => {
	const f = fixture(); const mock = createMockPi(); mock.install();
	let calls = 0; let applied = 0;
	const registration = owner(f, { async decide() { calls++; return selected; }, onApplied() { applied++; } });
	mock.onCall({ jsonl: [
		{ type: "message_end", message: { role: "toolResult", toolName: "write", content: [{ type: "text", text: "Wrote parser" }] } },
		{ type: "message_end", message: { role: "assistant", content: [], model: "fixture/target", stopReason: "error", errorMessage: "This operation was aborted", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
		{ type: "agent_settled" }, { type: "compaction_start" },
	], omitImplicitFinalEvents: true, keepAliveAfterFinalMessageMs: 5000 });
	mock.onCall({ output: "Recovered from retained session" });
	try {
		const result = await launch(f);
		assert.equal(result.isError, undefined, JSON.stringify(result));
		assert.equal(mock.sessions.length, 2);
		assert.equal(calls, 1); assert.equal(applied, 1);
		for (const session of mock.sessions) { assert.equal(session.launch.model, "fixture/target:medium"); assert.deepEqual(session.launch.storage, mock.sessions[0]?.launch.storage); }
		assert.match(mock.sessions[1]?.task ?? "", /Continue from the current files and transcript/);
	} finally { registration.dispose(); mock.uninstall(); }
});

it("N11-deadline-async: descriptor preserves pre-assessment absolute host deadline", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const f = fixture(); let deadline = 0; let config: any;
	const spawn = t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
		config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8")); throw new Error("intercepted fixture spawn");
	}); syncBuiltinESMExports();
	const registration = owner(f, { async decide(request) { deadline = request.control.launchDeadline!; t.mock.timers.setTime(Date.now() + 100); return selected; } });
	try {
		await launch(f, true, undefined, { timeoutMs: 2000 }); assert.equal(spawn.mock.callCount(), 1);
		assert.equal(config.deadlineAt, deadline); assert.equal(deadline - Date.now(), 1900);
		const descriptor = JSON.parse(fs.readFileSync(path.join(config.asyncDir, "recovery-descriptor.json"), "utf8")); assert.equal(descriptor.absoluteDeadlineAt, deadline);
	} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
});

for (const async of [false, true]) it(`N11-deadline-expired-${async ? "async" : "foreground"}: owned hard deadline blocks before create/spawn`, async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	await withForeground(async (f, mock) => {
		const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected spawn"); }); syncBuiltinESMExports();
		let applied = 0;
		const registration = owner(f, { async decide(request) { t.mock.timers.tick(request.control.launchDeadline! - Date.now()); return selected; }, onApplied() { applied++; } });
		try { assert.equal((await launch(f, async, undefined, { timeoutMs: 2000 })).isError, true); assert.equal(mock.sessions.length, 0); assert.equal(spawn.mock.callCount(), 0); assert.equal(applied, 0); }
		finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
	});
});


it("N05-unowned-async: original high binding and preexisting deadline origin remain unchanged", async (t) => {
	const f = fixture(); let config: any;
	const spawn = t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
		config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8")); throw new Error("intercepted fixture spawn");
	}); syncBuiltinESMExports();
	try {
		await launch(f, true); assert.equal(spawn.mock.callCount(), 1);
		assert.equal(config.steps[0].model, "fixture/original:high"); assert.equal(config.steps[0].thinking, "high");
		assert.deepEqual(getWorkerDecisionAuthoritySnapshot(f.sessionId), { kind: "never-owned" });
	} finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
});

for (const kind of ["required-extension", "fast-mode", "live-ceiling"] as const) it(`N08-${kind}: owned selection keeps extension/tool admission fences`, async () => {
	await withForeground(async (f, mock) => {
		if (kind === "required-extension") {
			const helper = path.join(f.root, "policy.ts"); fs.writeFileSync(helper, "export default () => {};\n");
			f.agent.requiredExtensions = [{ id: "policy", path: helper }];
		}
		if (kind === "fast-mode") f.agent.fast = true;
		const registration = owner(f, { async decide() { if (kind === "live-ceiling") f.agent.maxThinking = "low"; return selected; } });
		try { assert.equal((await launch(f, false, undefined, kind === "required-extension" ? { capabilityCeiling: { version: 1, denyExtensions: true, sources: ["fixture"] } } : {})).isError, true); assert.equal(mock.sessions.length, 0); }
		finally { registration.dispose(); }
	});
});


it("N04-final-async: invalidation after config construction still blocks actual spawn", async (t) => {
	const f = fixture(); let config: any; const write = fs.writeFileSync;
	const registration = owner(f, { async decide() { return selected; } });
	const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected spawn"); });
	t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
		write(...args);
		const value = typeof args[1] === "string" ? args[1] : "";
		if (value.includes('"runnerProcessInstanceId"') && value.includes('"steps"')) {
			config = JSON.parse(value);
			invalidateWorkerDecisionAuthority(f.sessionId, registration.generation);
		}
	}); syncBuiltinESMExports();
	try { const result = await launch(f, true); assert.ok(config); assert.equal(result.isError, true); assert.equal(spawn.mock.callCount(), 0); }
	finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
});


it("N11-deadline-foreground: assessment time is charged before actual child timeout", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({ hangUntilAbort: true });
	const base = childSessionFactory(); let created!: () => void; const childCreated = new Promise<void>((resolve) => { created = resolve; });
	setChildSessionFactory({ async create(input) { const session = await base.create(input); created(); return session; }, dispose: () => base.dispose() });
	let deadline = 0;
	const registration = owner(f, { async decide(request) { deadline = request.control.launchDeadline!; t.mock.timers.tick(100); return selected; } });
	try {
		const result = launch(f, false, undefined, { timeoutMs: 2000 }); await childCreated;
		assert.equal(deadline - Date.now(), 1900);
		t.mock.timers.tick(1900);
		const finished = await result;
		assert.equal(finished.isError, true); assert.equal(finished.details?.results[0]?.timedOut, true); assert.equal(mock.sessions[0]?.aborted, true);
		assert.equal(Date.now(), deadline);
	} finally { registration.dispose(); mock.uninstall(); }
});


it("N05-file-owner: valid file-first identity routes owner, never distinct session UUID", async () => {
	await withForeground(async (f, mock) => {
		const file = path.join(f.root, "parent.jsonl"); f.ctx.sessionManager.getSessionFile = () => file;
		let calls = 0;
		const registration = registerWorkerDecisionAuthority({ sessionId: file, lifetimeDeadline: Date.now() + 30000, assessmentTimeoutMs: 1000, authority: { async decide() { calls++; return selected; } } });
		try { assert.equal((await launch(f)).isError, undefined); assert.equal(calls, 1); assert.equal(mock.sessions[0]?.launch.model, "fixture/target:medium"); assert.deepEqual(getWorkerDecisionAuthoritySnapshot(f.sessionId), { kind: "never-owned" }); }
		finally { registration.dispose(); }
	});
});

for (const async of [false, true]) it(`N05-long-file-${async ? "async" : "foreground"}: impossible-to-register file key preserves legacy unowned binding`, async (t) => {
	await withForeground(async (f, mock) => {
		const file = path.join(f.root, "nested/".repeat(40), "parent.jsonl"); f.ctx.sessionManager.getSessionFile = () => file;
		fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "");
		assert.ok(Buffer.byteLength(file, "utf8") > 256);
		let config: any;
		const spawn = t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
			config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8")); throw new Error("intercepted fixture spawn");
		}); syncBuiltinESMExports();
		try {
			const result = await launch(f, async);
			if (async) { assert.equal(spawn.mock.callCount(), 1); assert.equal(config.steps[0].model, "fixture/original:high"); }
			else { assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(mock.sessions[0]?.launch.model, "fixture/original:high"); assert.equal(spawn.mock.callCount(), 0); }
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
	});
});

function writeWatchdogRule(f: ReturnType<typeof fixture>, rule: { allow?: string[]; deny?: string[] }) {
	const settingsPath = path.join(f.root, ".pi", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify({ subagents: { watchdog: { rules: { action: "block", roleModels: { [f.agent.name]: rule } } } } }));
	return settingsPath;
}

for (const async of [false, true]) for (const mode of ["deny", "allow"] as const) {
	it(`N08-${async ? "async" : "fg"}-pair-${mode}: watchdog evaluates committed model and thinking`, async (t) => {
		await withForeground(async (f, mock) => {
			writeWatchdogRule(f, { [mode]: ["fixture/target:medium"] });
			let calls = 0; let config: any;
			const registration = owner(f, { async decide() { calls++; return selected; } });
			const spawn = t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
				config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8"));
				throw new Error("intercepted fixture spawn");
			}); syncBuiltinESMExports();
			try {
				const result = await launch(f, async);
				assert.equal(calls, 1);
				assert.equal(mock.sessions.length, !async && mode === "allow" ? 1 : 0);
				assert.equal(spawn.mock.callCount(), async && mode === "allow" ? 1 : 0);
				if (mode === "deny") assert.equal(result.isError, true);
				else if (async) { assert.equal(config.steps[0].model, "fixture/target:medium"); assert.equal(config.steps[0].thinking, "medium"); }
				else { assert.equal(result.isError, undefined); assert.equal(mock.sessions[0]?.launch.model, "fixture/target:medium"); }
			} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
		});
	});
}

it("N08-late-watchdog: bare-model denial after config write blocks final async spawn", async (t) => {
	await withForeground(async (f, mock) => {
		writeWatchdogRule(f, {});
		const write = fs.writeFileSync; let config: any; let injected = 0; let calls = 0;
		const registration = owner(f, { async decide() { calls++; return selected; } });
		const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected spawn"); });
		t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
			write(...args);
			const content = typeof args[1] === "string" ? args[1] : "";
			if (content.includes('"runnerProcessInstanceId"') && content.includes('"steps"')) {
				config = JSON.parse(content); injected++;
				writeWatchdogRule(f, { deny: ["fixture/target"] });
			}
		}); syncBuiltinESMExports();
		try {
			const result = await launch(f, true);
			assert.equal(injected, 1); assert.equal(calls, 1);
			assert.equal(spawn.mock.callCount(), 0); assert.equal(mock.sessions.length, 0); assert.equal(result.isError, true);
		} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
	});
});

it("N08-late-watchdog-fg: tightening after attempt admission blocks final foreground factory", async (t) => {
	await withForeground(async (f, mock) => {
		const settingsPath = writeWatchdogRule(f, {}); const read = fs.readFileSync;
		let calls = 0; let applied = 0; let injected = 0;
		const registration = owner(f, { async decide() { calls++; return selected; }, onApplied() { applied++; } });
		t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
			const value = read(...args);
			if (String(args[0]) === settingsPath && applied === 1 && !injected && new Error().stack?.includes("validatePair")) {
				injected++;
				queueMicrotask(() => writeWatchdogRule(f, { deny: ["fixture/target:medium"] }));
			}
			return value;
		}); syncBuiltinESMExports();
		try {
			const result = await launch(f);
			assert.equal(injected, 1); assert.equal(calls, 1); assert.equal(applied, 1);
			assert.equal(mock.sessions.length, 0); assert.equal(result.isError, true);
		} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
	});
});

for (const control of ["owner", "cancel", "deadline"] as const) {
	it(`N08-watchdog-final-${control}: final rule loading cannot invalidate authority then spawn`, async (t) => {
		if (control === "deadline") t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
		await withForeground(async (f, mock) => {
			const settingsPath = writeWatchdogRule(f, {}); const read = fs.readFileSync; const write = fs.writeFileSync;
			const cancel = new AbortController(); let config: any; let injected = 0; let calls = 0;
			const registration = owner(f, { async decide() { calls++; return selected; } });
			let replacement: ReturnType<typeof owner> | undefined;
			const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected spawn"); });
			t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
				write(...args); const content = typeof args[1] === "string" ? args[1] : "";
				if (content.includes('"runnerProcessInstanceId"') && content.includes('"steps"')) config = JSON.parse(content);
			});
			t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
				const value = read(...args);
				if (config && !injected && String(args[0]) === settingsPath) {
					injected++;
					if (control === "owner") { registration.dispose(); replacement = owner(f, { async decide() { throw new Error("replacement cannot assess stale launch"); } }); }
					if (control === "cancel") cancel.abort();
					if (control === "deadline") t.mock.timers.setTime(config.deadlineAt);
				}
				return value;
			}); syncBuiltinESMExports();
			try {
				const result = await launch(f, true, cancel.signal, { timeoutMs: 2000 });
				assert.equal(injected, 1); assert.equal(calls, 1); assert.equal(spawn.mock.callCount(), 0); assert.equal(mock.sessions.length, 0); assert.equal(result.isError, true);
			} finally { registration.dispose(); replacement?.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
		});
	});
}

for (const control of ["owner", "cancel", "deadline"] as const) {
	it(`N08-watchdog-final-fg-${control}: final rule loading cannot invalidate authority then create`, async (t) => {
		if (control === "deadline") t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
		await withForeground(async (f, mock) => {
			const settingsPath = writeWatchdogRule(f, {}); const read = fs.readFileSync;
			const cancel = new AbortController(); let armed = false; let injected = 0; let calls = 0; let applied = 0; let deadline = 0;
			const registration = owner(f, { async decide(request) { calls++; deadline = request.control.launchDeadline!; return selected; }, onApplied() { applied++; } });
			let replacement: ReturnType<typeof owner> | undefined;
			t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
				const value = read(...args);
				if (applied === 1 && !injected && String(args[0]) === settingsPath && new Error().stack?.includes("validatePair")) {
					if (!armed) queueMicrotask(() => { armed = true; });
					else {
						injected++;
						if (control === "owner") { registration.dispose(); replacement = owner(f, { async decide() { throw new Error("replacement cannot assess stale launch"); } }); }
						if (control === "cancel") cancel.abort();
						if (control === "deadline") t.mock.timers.setTime(deadline);
					}
				}
				return value;
			}); syncBuiltinESMExports();
			try {
				const result = await launch(f, false, cancel.signal, { timeoutMs: 2000 });
				assert.equal(injected, 1); assert.equal(calls, 1); assert.equal(applied, 1); assert.equal(mock.sessions.length, 0); assert.equal(result.isError, true);
			} finally { registration.dispose(); replacement?.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
		});
	});
}

for (const source of ["project", "runtime"] as const) it(`NAT-NAME-executor-${source}: caller alias cannot replace resolved factual name`, async () => {
	await withForeground(async (f, mock) => {
		Object.assign(f.agent, { source, name: "package/specialized-reviewer", localName: "caller-label", aliases: ["junior"], description: "", systemPrompt: "PRIVATE SYSTEM PROMPT" });
		let calls = 0;
		const registration = owner(f, { async decide(request) {
			calls++;
			assert.deepEqual(request.facts, { task: "Act as unrelated-junior", role: { name: "package/specialized-reviewer", description: "", provenance: "resolved-agent" } });
			assert.equal(mock.sessions.length, 0);
			return selected;
		} });
		try {
			const result = await launch(f, false, undefined, { agent: "junior", task: "Act as unrelated-junior" });
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			assert.equal(calls, 1); assert.equal(mock.sessions.length, 1);
		} finally { registration.dispose(); }
	});
});

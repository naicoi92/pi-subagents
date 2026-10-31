import { finalizeToolResult } from "../../src/extension/tool-result.ts";
import { registerWorkerPresentation } from "../../src/api/worker-presentation.ts";
import { isWorkerPresentationDelegated } from "../../src/shared/worker-presentation.ts";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { runSubagent } from "../../src/runs/background/subagent-runner.ts";
import { registerWorkerDecisionAuthority, invalidateWorkerDecisionAuthority, getWorkerDecisionAuthoritySnapshot, disposeWorkerDecisionSession, type WorkerDecisionAuthority, type WorkerDecision, type WorkerDecisionRequest, type AppliedWorkerDecision } from "../../src/api/worker-decision-authority.ts";
import { createMockPi } from "../support/mock-pi.ts";
import * as os from "node:os";
import { resolveLaunchBinding, stableJsonDigest } from "../../src/shared/launch-contract.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { applySteeringRecoveryAgentConfig, readAsyncRecoveryDescriptor } from "../../src/runs/background/async-resume.ts";
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
	const events: Array<{ channel: string; payload: any }> = [];
	let observe: ((channel: string, payload: any) => void) | undefined;
	const host = { events: { on() { return () => {}; }, emit(channel: string, payload: unknown) { events.push({ channel, payload }); observe?.(channel, payload); } }, sendMessage() {}, getSessionName() {} } as any;
	const executor = createSubagentExecutor({
		pi: host,
		state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null } as any,
		config: { intercomBridge: { mode: "off" } }, asyncByDefault: false, tempArtifactsDir: root,
		getSubagentSessionRoot: () => path.join(root, "sessions"), expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent], modelScope }),
	});
	return { root, ctx, sessionId, agent, executor, events, host, observe(handler: (channel: string, payload: any) => void) { observe = handler; } };
}

it("reports supported tool selection for an explicit foreground agent", async () => {
 await withForeground(async (f) => {
  f.agent.tools = ["read"];
  let observed: unknown;
  const registration = owner(f, { async decide(request) {
   observed = request.facts.toolSelection;
   return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
  } });
  try { await launch(f); assert.equal(observed, "supported"); } finally { registration.dispose(); }
 });
});

for (const baseline of [undefined, ["mcp__server__tool"], ["codemode"], ["models"]] as const) {
 it(`reports unsupported tool selection for baseline ${JSON.stringify(baseline)}`, async () => {
  await withForeground(async (f) => {
   f.agent.tools = baseline ? [...baseline] : undefined;
   let observed: unknown;
   const registration = owner(f, { async decide(request) {
    observed = request.facts.toolSelection;
    return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
   } });
   try { await launch(f); assert.equal(observed, "unsupported"); } finally { registration.dispose(); }
  });
 });
}

it("reports unsupported tool selection when extensions are denied", async () => {
 await withForeground(async (f) => {
  f.agent.tools = ["read"];
  let observed: unknown;
  const registration = owner(f, { async decide(request) {
   observed = request.facts.toolSelection;
   return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
  } });
  try {
   await f.executor.executeDelegated("deny-extensions", { agent: f.agent.name, task: "Work", async: false, artifacts: false, acceptance: false, capabilityCeiling: { version: 1, denyExtensions: true, sources: ["test"] } }, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(observed, "unsupported");
  } finally { registration.dispose(); }
 });
});

it("reports unsupported tool selection when structured output is outside the ceiling", async () => {
 await withForeground(async (f) => {
  f.agent.tools = ["read"];
  let observed: unknown;
  const registration = owner(f, { async decide(request) {
   observed = request.facts.toolSelection;
   return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
  } });
  try {
   await f.executor.executeDelegated("structured-ceiling", { agent: f.agent.name, task: "Work", async: false, artifacts: false, acceptance: false, outputSchema: { type: "object", properties: {} }, capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: false, sources: ["test"] } }, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(observed, "unsupported");
  } finally { registration.dispose(); }
 });
});

it("reports unsupported selection when a resolved skill requires excluded read", async () => {
 await withForeground(async (f) => {
  const skillDir = path.join(f.root, "skills", "local");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: local\ndescription: local skill\n---\nbody\n");
  f.agent.tools = ["read"]; f.agent.excludeTools = ["read"]; f.agent.skills = ["local"]; f.agent.skillPath = [path.join(f.root, "skills")];
  let observed: unknown;
  const registration = owner(f, { async decide(request) { observed = request.facts.toolSelection; return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" }; } });
  try { await launch(f); assert.equal(observed, "unsupported"); } finally { registration.dispose(); }
 });
});

it("reports unsupported selection when structured output is excluded", async () => {
 await withForeground(async (f) => {
  f.agent.tools = ["read"]; f.agent.excludeTools = ["structured_output"];
  let observed: unknown;
  const registration = owner(f, { async decide(request) { observed = request.facts.toolSelection; return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" }; } });
  try {
   await f.executor.executeDelegated("structured-exclusion", { agent: f.agent.name, task: "Work", async: false, artifacts: false, acceptance: false, outputSchema: { type: "object", properties: {} } }, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(observed, "unsupported");
  } finally { registration.dispose(); }
 });
});

it("reports supported selection for asynchronous launches", async () => {
 const f = fixture(); f.agent.tools = ["read"];
 let observed: unknown;
 const registration = owner(f, { async decide(request) { observed = request.facts.toolSelection; return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" }; } });
 const t = await import("node:test");
 try {
  const mock = t.mock.method(childProcess, "spawn", () => { throw new Error("captured spawn"); }); syncBuiltinESMExports();
  await f.executor.executeDelegated("async-fact", { agent: f.agent.name, task: "Work", async: true, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(observed, "supported"); mock.mock.restore(); syncBuiltinESMExports();
 } finally { registration.dispose(); }
});

it("reports unsupported selection for remote launches", async () => {
 await withForeground(async (f) => {
  f.agent.tools = ["read"]; f.agent.machine = "remote";
  let observed: unknown;
  const registration = owner(f, { async decide(request) { observed = request.facts.toolSelection; return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" }; } });
  try { await launch(f); assert.equal(observed, "unsupported"); } finally { registration.dispose(); }
 });
});

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

for (const model of ["inherit", " inherit ", "", "   "]) for (const hasParent of [true, false]) it(`NAT-COMPARISON-sentinel: ${JSON.stringify(model)} with ${hasParent ? "parent fast" : "missing parent"} preserves comparison provenance and separate retention`, async () => {
	await withForeground(async (f, mock) => {
		f.ctx.model = hasParent ? { provider: "fixture", id: "fast" } : undefined;
		f.ctx.modelRegistry.getAvailable = () => ["fast", "deep"].map((id) => ({ provider: "fixture", id, reasoning: true, thinkingLevelMap: { low: "low", medium: "medium", high: "high" } }));
		f.agent.model = "fixture/deep";
		let captured!: WorkerDecisionRequest;
		const registration = owner(f, { async decide(request) {
			captured = request;
			const original = request.policyContext.original;
			return original.kind === "verified"
				? { kind: "apply", model: original.model, thinking: original.thinking, reason: "verified-original-retained" }
				: { kind: "reject", reason: "baseline-unresolved" };
		} });
		try {
			const result = await launch(f, false, undefined, { model });
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			assert.deepEqual(captured.policyContext.comparison, hasParent
				? { kind: "resolved", model: "fixture/fast", provenance: "parent" }
				: { kind: "unresolved", reason: "model-unresolved" });
			const original = captured.policyContext.original;
			assert.equal(original.kind, "verified");
			if (original.kind === "verified") {
				assert.equal(original.model, hasParent ? "fixture/fast" : "fixture/deep");
				assert.equal(original.thinking, "high");
				assert.equal(original.provenance, "host-effective");
			}
			assert.equal(mock.sessions[0]?.launch.model, hasParent ? "fixture/fast:high" : "fixture/deep:high");
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

it("NAT-UNRESOLVED-assessed: bare specialized model can commit complete assessed effort without default baseline", async () => {
	await withForeground(async (f, mock) => {
		f.agent.name = "specialized-junior";
		f.agent.thinking = undefined;
		const registration = owner(f, { async decide(request, context) {
			assert.deepEqual(request.policyContext.original, { kind: "unresolved", reason: "thinking-unresolved" });
			const target = await context.resolveTarget("fixture/original");
			assert.equal(target.kind, "resolved");
			if (target.kind === "resolved") {
				assert.deepEqual(target.baseline, { kind: "unresolved", reason: "thinking-unresolved" });
				assert.deepEqual(target.supportedThinking, ["low", "medium", "high"]);
			}
			return { kind: "apply", model: "fixture/original", thinking: "medium", reason: "assessed" };
		} });
		try {
			assert.equal((await launch(f)).isError, undefined);
			assert.equal(mock.sessions[0]?.launch.model, "fixture/original:medium");
		} finally { registration.dispose(); }
	});
});

for (const response of ["missing-effort", "unsupported-effort", "assessment-unavailable"] as const) it(`NAT-UNRESOLVED-${response}: bare specialized launch cannot invent effort`, async () => {
	await withForeground(async (f, mock) => {
		f.agent.thinking = undefined;
		const registration = owner(f, { async decide() {
			if (response === "assessment-unavailable") return { kind: "reject", reason: "assessment-unavailable" };
			if (response === "unsupported-effort") return { kind: "apply", model: "fixture/original", thinking: "max", reason: "assessed" };
			return { kind: "apply", model: "fixture/original", reason: "assessed" } as WorkerDecision;
		} });
		try { assert.equal((await launch(f)).isError, true); assert.equal(mock.sessions.length, 0); }
		finally { registration.dispose(); }
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

it("async authority warning reaches parent response and serialized child launch", async (t) => {
 const f = fixture(); let launchConfig: any;
 t.mock.method(childProcess, "spawn", (_command: string, args?: readonly string[], options?: childProcess.SpawnOptions) => {
  launchConfig = JSON.parse(fs.readFileSync(String(options?.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args?.at(-1)), "utf8"));
  throw new Error("intercepted fixture spawn");
 }); syncBuiltinESMExports();
 const registration = owner(f, {async decide() {return {...selected, toolWarnings:["Worker tool selection is unavailable."]};}});
 try {
  const result = await f.executor.execute("warning-async", {agent:f.agent.name, task:"Review", async:true, artifacts:false, acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
  assert.match(JSON.stringify(result.content), /Worker tool selection is unavailable/);
  assert.deepEqual(launchConfig.steps[0].workerToolWarnings, ["Worker tool selection is unavailable."]);
  const descriptor = readAsyncRecoveryDescriptor(launchConfig.asyncDir)!;
  assert.deepEqual(descriptor.workerToolWarnings, ["Worker tool selection is unavailable."]);
  const { buildRunnerChildLaunch } = await import("../../src/runs/background/runner-child-launch.ts");
  const child = buildRunnerChildLaunch(launchConfig.steps[0], {cwd:f.root,id:"warning-async",flatIndex:0}, {sessionEnabled:false,watchdogStatus:()=>{}});
  assert.deepEqual(child.session.workerToolWarnings, ["Worker tool selection is unavailable."]);
  fs.rmSync(launchConfig.asyncDir, {recursive:true,force:true});
 } finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("async selected tools reach the runner config, recovery descriptor and child launch", async (t) => {
 const f = fixture(); let launchConfig: any;
 const source = path.join(f.root, "selected.mjs");
 f.agent.tools = ["read"]; f.host.getAllTools = () => [{name:"plugin_selected",description:"Selected",sourceInfo:{path:source}}];
 t.mock.method(childProcess, "spawn", (_command: string, args?: readonly string[], options?: childProcess.SpawnOptions) => {
  launchConfig = JSON.parse(fs.readFileSync(String(options?.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args?.at(-1)), "utf8"));
  throw new Error("intercepted fixture spawn");
 }); syncBuiltinESMExports();
 const identity = {name:"plugin_selected",sourcePath:source};
 const registration = owner(f, {async decide() {return {...selected, selectedTools:[identity]} as WorkerDecision;}});
 try {
  const result = await f.executor.execute("selected-async", {agent:f.agent.name, task:"Review", async:true, artifacts:false, acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
  assert.doesNotMatch(JSON.stringify(result.content), /not supported for background/);
  assert.deepEqual(launchConfig.steps[0].workerSelectedTools, [identity]);
  const descriptor = readAsyncRecoveryDescriptor(launchConfig.asyncDir)!;
  assert.deepEqual(descriptor.workerSelectedTools, [identity]);
  const { buildRunnerChildLaunch } = await import("../../src/runs/background/runner-child-launch.ts");
  const child = buildRunnerChildLaunch(launchConfig.steps[0], {cwd:f.root,id:"selected-async",flatIndex:0}, {sessionEnabled:false,watchdogStatus:()=>{}});
  assert.deepEqual(child.session.workerSelectedTools, [identity]);
  fs.rmSync(launchConfig.asyncDir, {recursive:true,force:true});
 } finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

it("async resume rejects an unbounded selected tool descriptor", async () => {
 const { readAsyncRecoveryDescriptor: read } = await import("../../src/runs/background/async-resume.ts");
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selected-descriptor-")); roots.push(dir);
 for (const bad of [[{name:"x",sourcePath:"relative.ts"}], [{name:""}], "nope", Array.from({length:257},(_, i)=>({name:`t${i}`,sourcePath:"/a.ts"}))]) {
  fs.writeFileSync(path.join(dir, "recovery-descriptor.json"), JSON.stringify({version:1, workerSelectedTools: bad}));
  assert.throws(() => read(dir), /workerSelectedTools|Invalid async recovery descriptor/);
 }
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
		const failed = await f.executor.execute("async", { agent: f.agent.name, task: "Review parser", async: true, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
		assert.equal(failed.isError, true);
		assert.equal(failed.details?.runId, accepted(f)[0]?.runId);
		assert.equal(failed.details?.toolCallId, "async");
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
		assert.equal(accepted(f).length, 1);
		assert.equal(accepted(f)[0].runId, launchConfig.id);
		assert.equal(accepted(f)[0].toolCallId, "async");
		assert.equal(accepted(f)[0].sessionId, f.sessionId);
		assert.equal(launchConfig.reportNativeExecutionStart, true);
		assert.equal(starts(f).length, 0, "failed runner spawn is not native child execution");
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
				assert.equal(accepted(f).length, 0); assert.equal(starts(f).length, 0);
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
		assert.equal(accepted(f).length, 1, "runtime recovery cannot duplicate binding notification");
		assert.equal(starts(f).length, 1, "runtime recovery cannot start same logical leaf twice");
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
			assert.deepEqual(request.facts, { task: "Act as unrelated-junior", toolSelection: "unsupported", role: { name: "package/specialized-reviewer", description: "", provenance: "resolved-agent" } });
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

const acceptedChannel = "subagent:worker-decision-accepted";
const childStatusChannel = "subagent:child-status";
function accepted(f: ReturnType<typeof fixture>) { return f.events.filter((event) => event.channel === acceptedChannel).map((event) => event.payload); }
function starts(f: ReturnType<typeof fixture>) { return f.events.filter((event) => event.channel === childStatusChannel && event.payload.status === "started").map((event) => event.payload); }

it("CORRELATION-leaf: immutable consumed receipt maps originating tool/session to actual leaf before execution", async () => {
	await withForeground(async (f, mock) => {
		let receipt!: AppliedWorkerDecision;
		let sessionsAtAcceptance = -1;
		const presentation = registerWorkerPresentation({ sessionId: f.sessionId });
		const registration = owner(f, { async decide() { return selected; }, onApplied(value) { receipt = value; } });
		f.observe((channel, event) => { if (channel === acceptedChannel) { sessionsAtAcceptance = mock.sessions.length; assert.equal(presentation.acknowledge(event), true, "executor publishes binding before synchronous emit"); } });
		try {
			const result = await f.executor.execute("correlation-tool", { agent: f.agent.name, task: "Private task", async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
			assert.equal(result.isError, undefined, JSON.stringify(result));
			assert.equal(accepted(f).length, 1);
			const event = accepted(f)[0];
			assert.equal(sessionsAtAcceptance, 0);
			assert.equal(isWorkerPresentationDelegated(f.sessionId, event.runId), true);
			assert.equal(event.receipt, receipt);
			assert.ok(Object.isFrozen(event)); assert.ok(Object.isFrozen(event.receipt));
			assert.deepEqual(Object.keys(event).sort(), ["version", "sessionId", "toolCallId", "runId", "logicalLaunchId", "receipt"].sort());
			assert.throws(() => { event.runId = "mutated"; }, TypeError);
			assert.equal(event.version, 1); assert.equal(event.sessionId, f.sessionId); assert.equal(event.toolCallId, "correlation-tool");
			assert.equal(event.runId, result.details?.runId); assert.equal(event.logicalLaunchId, receipt.logicalLaunchId);
			assert.equal(event.receipt.ownerGeneration, registration.generation);
			assert.equal(starts(f).length, 1); assert.equal(starts(f)[0].runId, event.runId);
			assert.ok(f.events.findIndex((entry) => entry.channel === acceptedChannel) < f.events.findIndex((entry) => entry.channel === childStatusChannel));
			assert.doesNotMatch(JSON.stringify(event), /Private task|systemPrompt|policyContext|authorization/);
		} finally { presentation.dispose(); registration.dispose(); }
	});
});

it("CORRELATION-observer: listener failure cannot reject committed launch", async () => {
	await withForeground(async (f, mock) => {
		const registration = owner(f, { async decide() { return selected; } });
		f.observe((channel) => { if (channel === acceptedChannel) throw new Error("observer failed"); });
		try { assert.equal((await launch(f)).isError, undefined); assert.equal(mock.sessions.length, 1); assert.equal(accepted(f).length, 1); }
		finally { registration.dispose(); }
	});
});

for (const mode of ["create-failed", "cancel-before-turn"] as const) it(`CORRELATION-${mode}: accepted is not proof of child execution`, async () => {
	await withForeground(async (f, mock) => {
		const base = childSessionFactory(); const cancel = new AbortController();
		setChildSessionFactory({ async create(input) {
			assert.equal(accepted(f).length, 1); assert.equal(starts(f).length, 0);
			if (mode === "create-failed") throw new Error("fixture creation failed");
			const session = await base.create(input); cancel.abort(); return session;
		}, dispose: () => base.dispose() });
		const registration = owner(f, { async decide() { return selected; } });
		try {
			const failed = await launch(f, false, cancel.signal);
			assert.equal(failed.isError, true); assert.equal(accepted(f).length, 1); assert.equal(starts(f).length, 0);
			assert.equal(failed.details?.runId, accepted(f)[0].runId); assert.equal(failed.details?.toolCallId, accepted(f)[0].toolCallId);
		}
		finally { registration.dispose(); }
	});
});

it("CORRELATION-session: navigation during assessment cannot reattribute acceptance", async () => {
	await withForeground(async (f) => {
		const registration = owner(f, { async decide() { f.ctx.sessionManager.getSessionId = () => "different-session"; return selected; } });
		try { await launch(f); assert.equal(accepted(f).length, 1); assert.equal(accepted(f)[0].sessionId, f.sessionId); }
		finally { registration.dispose(); }
	});
});

it("CORRELATION-workflow: two real leaf receipts join child-status and terminal by childRunId/key, never root-to-siblings", async () => {
	const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({ output: "alpha" }); mock.onCall({ output: "beta" });
	const receipts: AppliedWorkerDecision[] = [];
	const registration = owner(f, { async decide() { return selected; }, onApplied(receipt) { receipts.push(receipt); } });
	const script = path.join(f.root, "workflow.js");
	fs.writeFileSync(script, `await runs.all([{ key: "alpha", label: "Check alpha", agent: "${f.agent.name}", task: "Alpha" }, { key: "beta", label: "Check beta", agent: "${f.agent.name}", task: "Beta" }]);`);
	try {
		const launched = await f.executor.executePublic("workflow-tool", { workflow: script, async: true, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
		assert.equal(launched.isError, undefined, JSON.stringify(launched));
		const root = launched.details?.asyncId;
		assert.ok(root);
		const statusPath = path.join(launched.details!.asyncDir!, "status.json");
		const limit = Date.now() + 5000;
		let terminal: any;
		while (Date.now() < limit) {
			terminal = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			if (terminal.state === "complete" || terminal.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(accepted(f).length, 2); assert.equal(receipts.length, 2); assert.equal(starts(f).length, 2);
		assert.equal(new Set(accepted(f).map((event) => event.runId)).size, 2);
		for (const event of accepted(f)) {
			assert.equal(event.toolCallId, "workflow-tool");
			assert.equal(event.parentWorkflowRunId, root); assert.ok(["alpha", "beta"].includes(event.workflowKey));
			assert.ok(receipts.includes(event.receipt)); assert.notEqual(event.runId, root);
			const start = starts(f).filter((entry) => entry.childRunId === event.runId);
			assert.equal(start.length, 1); assert.equal(start[0].runId, root); assert.equal(start[0].childId, event.workflowKey);
		}
		assert.equal(terminal.state, "complete", "persisted workflow terminal payload (fixture does not install result watcher)");
		for (const event of accepted(f)) assert.ok(terminal.workflowChildren.children.some((child: any) => child.runId === event.runId && child.childId === event.workflowKey));
	} finally { registration.dispose(); mock.uninstall(); }
});

for (const workflow of [false, true]) it(`CORRELATION-runner-${workflow ? "workflow" : "ordinary"}: actual direct async config emits one truthful started event and terminal result for same leaf`, async (t) => {
	const f = fixture(); let config: any;
	t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
		config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8"));
		throw new Error("intercepted fixture spawn");
	}); syncBuiltinESMExports();
	const registration = owner(f, { async decide() { return selected; } });
	try {
		await launch(f, true, undefined, workflow ? { workflowParentRunId: "workflow-root", workflowKey: "alpha" } : {});
		assert.ok(config); assert.equal(starts(f).length, 0);
		t.mock.restoreAll(); syncBuiltinESMExports();
		const mock = createMockPi(); mock.install(); mock.onCall({ output: "async leaf done" });
		try {
			await runSubagent(config, childSessionFactory());
			const events = fs.readFileSync(path.join(config.asyncDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const actualStarts = events.filter((event) => event.type === "subagent.child-status" && event.status === "started");
			assert.equal(actualStarts.length, 1);
			assert.equal(actualStarts[0].runId, workflow ? "workflow-root" : accepted(f)[0].runId);
			assert.equal(actualStarts[0].childId, workflow ? "alpha" : "step:0");
			if (workflow) { assert.equal(actualStarts[0].childRunId, accepted(f)[0].runId); assert.equal(actualStarts[0].workflowKey, "alpha"); }
			const terminal = JSON.parse(fs.readFileSync(path.join(config.asyncDir, "status.json"), "utf8"));
			assert.equal(terminal.runId, accepted(f)[0].runId); assert.equal(terminal.state, "complete");
		} finally { mock.uninstall(); }
	} finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
});

for (const withCompleted of [false, true]) it(`CORRELATION-attached-workflow-failure-${withCompleted}: settled leaves survive canonical public throw without terminating unstarted sibling`, async () => {
	const f = fixture(); const mock = createMockPi(); mock.install();
	if (withCompleted) mock.onCall({ output: "completed alpha" });
	mock.onCall({ exitCode: 1, stderr: "leaf provider failure" });
	const registration = owner(f, { async decide() { return selected; } });
	const script = path.join(f.root, "attached-failure.js");
	fs.writeFileSync(script, `${withCompleted ? `await runs.run("alpha", { agent: "${f.agent.name}", task: "Alpha", async: false, acceptance: false });` : ""}
await runs.run("beta", { agent: "${f.agent.name}", task: "Beta", async: false, acceptance: false });
await runs.run("unstarted", { agent: "${f.agent.name}", task: "Never launched", async: false, acceptance: false });`);
	try {
		const result = await f.executor.executePublic("attached-workflow-tool", { workflow: script, async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
		assert.equal(result.isError, true);
		assert.throws(() => finalizeToolResult(result), /leaf provider failure/);
		const terminal = f.events.filter((event) => event.channel === "subagent:foreground-complete").map((event) => event.payload);
		assert.equal(terminal.length, withCompleted ? 2 : 1);
		assert.equal(accepted(f).length, terminal.length);
		assert.deepEqual(terminal.map((event) => event.state), withCompleted ? ["complete", "failed"] : ["failed"]);
		assert.equal(new Set(terminal.map((event) => event.runId)).size, terminal.length);
		for (const event of terminal) {
			const binding = accepted(f).find((binding) => binding.runId === event.runId);
			assert.ok(binding); assert.equal(event.sessionId, f.sessionId);
			assert.equal(event.parentWorkflowRunId, binding.parentWorkflowRunId); assert.equal(event.workflowKey, binding.workflowKey);
			assert.equal(event.toolCallId, "attached-workflow-tool"); assert.equal(event.attached, true); assert.equal(event.version, 1);
			assert.equal(event.success, event.state === "complete"); assert.equal(event.id, undefined);
			assert.equal(event.summary, undefined); assert.equal(event.output, undefined);
		}
		assert.ok(!terminal.some((event) => event.workflowKey === "unstarted"));
	} finally { registration.dispose(); mock.uninstall(); }
});

it("AC1 delegated caller tools add to explicit agent tools without replacing defaults", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"];
  const result = await f.executor.executeDelegated("delegated", { agent: f.agent.name, task: "Review", tools: ["grep"], async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(mock.sessions[0]?.launch.tools, ["read", "grep"]);
  assert.deepEqual(f.agent.tools, ["read"]);
 });
});

it("AC1 public model launch combines caller tools with agent defaults", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"];
  const registration = owner(f, {async decide(request) {
   assert.deepEqual(request.facts.callerTools, ["grep"]);
   return selected;
  }});
  try {
   const result = await f.executor.executePublic("public-tools", {agent:f.agent.name,task:"Review",tools:["grep"],async:false,artifacts:false,acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(result.isError, undefined, JSON.stringify(result.content));
   assert.deepEqual(mock.sessions[0]?.launch.tools, ["read", "grep"]);
  } finally {registration.dispose();}
 });
});

it("AC3 public caller tools cannot independently grant nested delegation", async () => {
 for (const tool of ["subagent", "subagent_supervisor", "subagent_command"]) {
  await withForeground(async (f, mock) => {
   f.agent.tools = ["read"]; f.agent.allowNestedSubagents = false;
   const result = await f.executor.executePublic(`deny-${tool}`, {agent:f.agent.name,task:"Review",tools:[tool],async:false,artifacts:false,acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(result.isError, true, tool);
   assert.match(JSON.stringify(result.content), /nested delegation/);
   assert.equal(mock.sessions.length, 0);
  });
 }
});

it("AC1 public native caller tools are rejected for external runners", async () => {
 const f = fixture();
 f.agent.tools = ["read"]; f.agent.runner = {type:"external-cli", command:process.execPath, args:[]};
 const result = await f.executor.executePublic("external-caller", {agent:f.agent.name,task:"Review",tools:["grep"],async:true,artifacts:false,acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
 assert.equal(result.isError,true);
 assert.match(JSON.stringify(result.content), /cannot accept native caller tools/);
});

it("AC1 implicit agent defaults cannot silently drop public caller tools", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = undefined;
  const result = await f.executor.executePublic("implicit-public", {agent:f.agent.name,task:"Review",tools:["grep"],async:false,artifacts:false,acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError,true);
  assert.match(JSON.stringify(result.content), /explicit agent tools baseline/);
  assert.equal(mock.sessions.length,0);
 });
});

it("AC3 public caller tools cannot bypass capability ceilings", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"];
  const result = await f.executor.executePublic("public-ceiling", {agent:f.agent.name,task:"Review",tools:["grep"],async:false,artifacts:false,acceptance:false,capabilityCeiling:{version:1,allowedTools:["read"],sources:["test"]}}, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.ok(!mock.sessions[0]?.launch.tools?.includes("grep"));
 });
});

it("AC3 public caller tools cannot bypass wildcard exclusions", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"]; f.agent.excludeTools = ["gr*"];
  const result = await f.executor.executePublic("public-excluded", {agent:f.agent.name,task:"Review",tools:["grep"],async:false,artifacts:false,acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.ok(!mock.sessions[0]?.launch.tools?.includes("grep"));
 });
});

it("AC3 exclusions block delegated caller tools", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"]; f.agent.excludeTools = ["grep"];
  const result = await f.executor.executeDelegated("delegated-excluded", { agent: f.agent.name, task: "Review", tools: ["grep"], async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.ok(!mock.sessions[0]?.launch.tools?.includes("grep"));
 });
});

it("AC2 native authority receives existing host metadata and separate caller provenance", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"];
  f.host.getAllTools = () => [{ name: "grep", description: "Search files", namespace: { name: "plugin" }, sourceInfo: { path: "/plugin/index.ts" } }];
  const registration = owner(f, { async decide(request) {
   assert.deepEqual(request.facts.callerTools, ["grep"]);
   assert.deepEqual(request.facts.tools, [{ name: "grep", description: "Search files", namespace: "plugin", sourcePath: "/plugin/index.ts" }]);
   return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
  } });
  try {
   const result = await f.executor.executeDelegated("provenance", { agent: f.agent.name, task: "Review", tools: ["grep"], async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(result.isError, undefined, JSON.stringify(result.content));
   assert.deepEqual(mock.sessions[0]?.launch.tools, ["read", "grep"]);
  } finally { registration.dispose(); }
 });
});

it("caller identities never become extension paths", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"];
  const result = await f.executor.executeDelegated("caller-path", { agent: f.agent.name, task: "Review", tools: ["/tmp/evil.ts", "plugin/tool"], async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.ok(!mock.sessions[0]?.launch.extensions?.includes("/tmp/evil.ts"));
  assert.ok(mock.sessions[0]?.launch.tools?.includes("plugin/tool"));
 });
});

it("host metadata omits only structurally invalid records and never size or count", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = ["read"];
  f.host.getAllTools = () => [
   { name: "empty", description: "" }, { name: "large", description: "x".repeat(100_000) },
   ...Array.from({length: 600}, (_, i) => ({ name: `tool${i}`, description: "x".repeat(1000) })),
  ];
  const registration = owner(f, { async decide(request) {
   assert.equal(request.facts.toolsIncomplete, true);
   assert.equal(request.facts.tools!.length, 601);
   assert.ok(request.facts.tools!.some(tool => tool.name === "large" && tool.description.length === 100_000));
   assert.ok(request.facts.tools!.every(tool => tool.description.length > 0));
   return { kind: "apply", model: "fixture/target", thinking: "medium", reason: "assessed" };
  } });
  try {
   const result = await f.executor.executeDelegated("metadata-omitted", { agent: f.agent.name, task: "Review", async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(result.isError, undefined, JSON.stringify(result.content));
   assert.ok(mock.sessions[0]);
  } finally { registration.dispose(); }
 });
});

it("implicit defaults keep caller additions in foreground decision contract", async () => {
 await withForeground(async (f, mock) => {
  f.agent.tools = undefined;
  const registration = owner(f, { async decide(request) {
   assert.deepEqual(request.facts.callerTools, ["plugin/tool"]);
   return selected;
  } });
  try {
   const result = await f.executor.executeDelegated("implicit-foreground", { agent: f.agent.name, task: "Review", tools: ["plugin/tool"], async: false, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
   assert.equal(result.isError, undefined, JSON.stringify(result.content));
   assert.equal(mock.sessions[0]?.launch.tools, undefined);
  } finally { registration.dispose(); }
 });
});

it("implicit defaults retain caller identities in background runner contract", async (t) => {
 const f = fixture(); f.agent.tools = undefined; let config: any;
 t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
  config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8")); throw new Error("intercepted fixture spawn");
 }); syncBuiltinESMExports();
 try {
  await f.executor.executeDelegated("implicit-background", { agent: f.agent.name, task: "Review", tools: ["plugin/tool"], async: true, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(config.steps[0].tools, undefined);
  assert.deepEqual(config.steps[0].callerTools, ["plugin/tool"]);
 } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (config) fs.rmSync(config.asyncDir, { recursive: true, force: true }); }
});

it("delegated async recovery preserves caller additions with pre-bridge agent configuration", async (t) => {
 const f = fixture(); f.agent.tools = ["read"]; f.agent.excludeTools = ["excluded"];
 let asyncDir: string | undefined;
 t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
  const config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8"));
  asyncDir = config.asyncDir;
  throw new Error("intercepted fixture spawn");
 }); syncBuiltinESMExports();
 try {
  await f.executor.executeDelegated("recovery-caller", { agent: f.agent.name, task: "Review", tools: ["grep", "excluded", "plugin/tool"], async: true, artifacts: false, acceptance: false, capabilityCeiling: { version: 1, allowedTools: ["read", "grep", "excluded"], denyExtensions: false, sources: ["test"] } }, new AbortController().signal, undefined, f.ctx as any);
  assert.ok(asyncDir);
  const descriptor = readAsyncRecoveryDescriptor(asyncDir)!;
  assert.deepEqual(descriptor.tools, ["read"]);
  assert.deepEqual(descriptor.callerTools, ["grep", "excluded", "plugin/tool"]);
  const revived = applySteeringRecoveryAgentConfig({ ...f.agent, tools: ["bash"] }, descriptor);
  assert.deepEqual(revived.callerTools, ["grep", "excluded", "plugin/tool"]);
  const plan = resolvePiLaunchToolPlan({ tools: revived.tools, callerTools: revived.callerTools, excludeTools: revived.excludeTools, capabilityCeiling: descriptor.capabilityCeiling });
  assert.deepEqual(plan.effectiveToolAllowlist, ["read", "grep"]);
  assert.deepEqual(plan.toolExtensionPaths, []);
 } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (asyncDir) fs.rmSync(asyncDir, { recursive: true, force: true }); }
});

it("delegated async recovery omits caller additions for absent and empty requests", async (t) => {
 const f = fixture(); const directories: string[] = [];
 t.mock.method(childProcess, "spawn", (_cmd: string, args: readonly string[], options: childProcess.SpawnOptions) => {
  const config = JSON.parse(fs.readFileSync(String(options.env?.PI_SUBAGENT_RUNNER_CONFIG ?? args.at(-1)), "utf8"));
  directories.push(config.asyncDir);
  throw new Error("intercepted fixture spawn");
 }); syncBuiltinESMExports();
 try {
  for (const tools of [undefined, []]) {
   await f.executor.executeDelegated("recovery-empty", { agent: f.agent.name, task: "Review", tools, async: true, artifacts: false, acceptance: false }, new AbortController().signal, undefined, f.ctx as any);
   const descriptor = readAsyncRecoveryDescriptor(directories.at(-1)!)!;
   assert.equal(descriptor.callerTools, undefined);
   assert.equal(applySteeringRecoveryAgentConfig({ ...f.agent, callerTools: ["stale"] }, descriptor).callerTools, undefined);
  }
  assert.equal(directories.length, 2);
 } finally { t.mock.restoreAll(); syncBuiltinESMExports(); for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true }); }
});

it("inventory over 256 is complete and not truncated", async () => {
 await withForeground(async (f) => {
  f.host.getAllTools = () => Array.from({length: 1000}, (_, i) => ({ name: `tool${i}`, description: "valid" }));
  const registration = owner(f, { async decide(request) {
   assert.equal(request.facts.toolsIncomplete, false);
   assert.equal(request.facts.tools?.length, 1000);
   return selected;
  } });
  try { assert.equal((await launch(f)).isError, undefined); } finally { registration.dispose(); }
 });
});

it("foreground public decision loads selected file-backed tool into an actual Pi child", { skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "requires Pi 1.4.0 host" }, async () => {
 const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({ output: "done" });
 const source = path.join(f.root, "selected.mjs");
 fs.writeFileSync(source, `export default pi => pi.registerTool({name:'plugin_selected',label:'Selected',description:'Selected',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'selected works'}],details:{}}}});`);
 f.agent.tools = ["read"];
 f.host.getAllTools = () => [{name:"plugin_selected",description:"Selected",sourceInfo:{path:source}}];
 const host = await import(path.join(process.env.PI_SUBAGENTS_NATIVE_PI_ROOT!, "dist/index.js"));
 const { createDefaultChildSessionFactory } = await import("../../src/runs/shared/child-session.ts");
 let actual: any;
 const real = createDefaultChildSessionFactory({loadPiCodingAgent: async () => ({...host, createAgentSession: async (options: any) => { const created = await host.createAgentSession(options); actual = created.session; return created; }}) as any});
 const fake = childSessionFactory();
 setChildSessionFactory({async create(input) {
  const child = await real.create({...input, model: undefined, parentProviderRegistry: undefined, storage: {kind:"memory"}});
  assert.deepEqual(actual.getCallableToolNames().sort(), ["grep", "plugin_selected", "read"]);
  const tool = actual.agent.state.tools.find((value: any) => value.name === "plugin_selected");
  assert.equal((await tool.execute("selected", {}, new AbortController().signal)).content[0].text, "selected works");
  await child.dispose(); return fake.create(input);
 }, dispose: async () => { await real.dispose(); await fake.dispose(); }});
 const registration = owner(f, {async decide() {return {...selected, selectedTools:[{name:"plugin_selected",sourcePath:source}]} as WorkerDecision;}});
 try {
  const result = await f.executor.executeDelegated("actual-selected", {agent:f.agent.name,task:"Review",tools:["grep"],async:false,artifacts:false,acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
 } finally {registration.dispose(); mock.uninstall();}
});

it("foreground authority warnings reach the child and parent without a selected tool", { skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "requires Pi 1.4.0 host" }, async () => {
 const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({output:"done"});
 f.agent.tools = ["read"];
 const host = await import(path.join(process.env.PI_SUBAGENTS_NATIVE_PI_ROOT!, "dist/index.js"));
 const { createDefaultChildSessionFactory } = await import("../../src/runs/shared/child-session.ts");
 const prompts: string[] = [];
 const real = createDefaultChildSessionFactory({loadPiCodingAgent: async () => ({...host, createAgentSession: async (options: any) => { const created = await host.createAgentSession(options); created.session.prompt = async (text: string) => { prompts.push(text); if (prompts.length === 1) throw new Error("first prompt failed"); }; return created; }}) as any});
 const fake = childSessionFactory();
 setChildSessionFactory({async create(input) {
  const child = await real.create({...input, model:undefined, parentProviderRegistry:undefined, storage:{kind:"memory"}});
  await assert.rejects(child.prompt("First attempt"), /first prompt failed/);
  await child.prompt("Task: Review");
  await child.prompt("Follow-up");
  const warnings = child.workerToolWarnings;
  await child.dispose(); const scripted = await fake.create(input);
  return {...scripted, workerToolWarnings:warnings};
 }, dispose:async()=>{await real.dispose();await fake.dispose();}});
 const registration = owner(f,{async decide(){return {...selected,toolWarnings:["Worker tool scores unavailable."]} as WorkerDecision;}});
 try {
  const result = await f.executor.executeDelegated("authority-warning", {agent:f.agent.name,task:"Review",async:false,artifacts:false,acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
  assert.equal(result.isError,undefined,JSON.stringify(result.content));
  assert.match(prompts[0]!, /Worker tool scores unavailable/);
  assert.match(prompts[1]!, /Worker tool scores unavailable/);
  assert.equal(prompts[2], "Follow-up");
  assert.match(JSON.stringify(result.content), /Worker tool scores unavailable/);
 } finally {registration.dispose();mock.uninstall();}
});

for (const mode of ["ceiling", "excluded", "missing", "mismatch", "implicit", "mcp"] as const) it(`foreground selected tool ${mode} keeps ceiling or reports unsupported grant`, { skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "requires Pi 1.4.0 host" }, async () => {
 const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({output:"done"});
 const source = path.join(f.root, "selected.mjs");
 fs.writeFileSync(source, mode === "missing" ? `export default () => {};` : `export default pi => pi.registerTool({name:'plugin_selected',label:'Selected',description:'Selected',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'ok'}],details:{}}}});`);
 f.agent.tools = mode === "implicit" ? undefined : mode === "mcp" ? ["read", "mcp__server__tool"] : ["read"];
 if (mode === "excluded") f.agent.excludeTools = ["plugin_*"];
 const expectedSource = mode === "mismatch" ? path.join(f.root, "wrong.mjs") : source;
 if (mode === "mismatch") { fs.writeFileSync(expectedSource, `export default () => {};`); f.agent.extensions = [source]; }
 f.host.getAllTools = () => [{name:"plugin_selected",description:"Selected",sourceInfo:{path:expectedSource}}];
 const host = await import(path.join(process.env.PI_SUBAGENTS_NATIVE_PI_ROOT!, "dist/index.js"));
 const { createDefaultChildSessionFactory } = await import("../../src/runs/shared/child-session.ts");
 let actual: any, childPrompt = "", followUpPrompt = "", createdCount = 0;
 const real = createDefaultChildSessionFactory({loadPiCodingAgent: async () => ({...host, createAgentSession: async (options: any) => { const created = await host.createAgentSession(options); actual = created.session; return created; }}) as any});
 const fake = childSessionFactory();
 setChildSessionFactory({async create(input) {
  createdCount++;
  const child = await real.create({...input, model:undefined,parentProviderRegistry:undefined,storage:{kind:"memory"}});
  assert.deepEqual(actual.getCallableToolNames(), ["read"]);
  actual.prompt = async (text: string) => {if (!childPrompt) childPrompt = text; else followUpPrompt = text;};
  await child.prompt("Task: Review");
  await child.prompt("Structured output follow-up");
  const warnings = child.workerToolWarnings;
  await child.dispose(); const scripted = await fake.create(input);
  return {...scripted,workerToolWarnings:warnings};
 }, dispose:async()=>{await real.dispose(); await fake.dispose();}});
 const registration = owner(f,{async decide(){return {...selected,selectedTools:[{name:"plugin_selected",sourcePath:expectedSource}]} as WorkerDecision;}});
 try {
  const result = await f.executor.executeDelegated(`actual-${mode}`, {agent:f.agent.name,task:"Review",async:false,artifacts:false,acceptance:false,...(mode === "ceiling" ? {capabilityCeiling:{version:1,allowedTools:["read"],denyExtensions:false,sources:["test"]}} : {})}, new AbortController().signal, undefined, f.ctx as any);
  if (mode === "implicit" || mode === "mcp") { assert.equal(result.isError,true); assert.match(JSON.stringify(result.content), /scope-denied/); assert.equal(createdCount,0); }
  else {
   assert.equal(result.isError,undefined,JSON.stringify(result.content));
   assert.match(childPrompt,/^Tool selection warnings:/); assert.match(childPrompt,/\n\nTask: Review$/);
   assert.equal(followUpPrompt,"Structured output follow-up");
   assert.match(JSON.stringify(result.content), mode === "ceiling" || mode === "excluded" ? /ceiling|exclusion/ : /missing or source mismatch/);
  }
 } finally {registration.dispose();mock.uninstall();}
});

for (const mode of ["implicit", "mcp", "async"] as const) it(`empty worker tool decision preserves ${mode} baseline and receipt`, async (t) => {
 const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({output:"done"});
 f.agent.tools = mode === "mcp" ? ["read", "mcp__server__tool"] : undefined;
 let receipt: AppliedWorkerDecision | undefined; let spawned = false;
 if (mode === "async") { t.mock.method(childProcess, "spawn", () => { spawned = true; throw new Error("fixture spawn"); }); syncBuiltinESMExports(); }
 const registration = owner(f,{async decide(){return {...selected,selectedTools:[]} as WorkerDecision;},onApplied(value){receipt=value;}});
 try {
  const result = await launch(f, mode === "async");
  assert.deepEqual(receipt?.selectedTools, []);
  if (mode === "async") assert.equal(spawned,true);
  else { assert.equal(result.isError,undefined,JSON.stringify(result.content)); assert.equal(mock.sessions.length,1); assert.equal(mock.sessions[0]?.launch.workerSelectedTools,undefined); }
 } finally {registration.dispose();mock.uninstall();t.mock.restoreAll();syncBuiltinESMExports();}
});

for (const mode of ["implicit", "mcp", "codemode", "models", "remote"] as const) it(`nonempty worker selection rejects ${mode} before receipt`, async () => {
 const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({output:"done"});
 f.agent.tools = mode === "implicit" ? undefined : mode === "mcp" ? ["read","mcp__x__y"] : mode === "codemode" || mode === "models" ? ["read", mode] : ["read"];
 const source = path.join(f.root,"selected.mjs"); f.host.getAllTools = () => [{name:"selected",description:"Selected",sourceInfo:{path:source}}];
 let applied = 0;
 const registration = owner(f,{async decide(){return {...selected,selectedTools:[{name:"selected",sourcePath:source}]} as WorkerDecision;},onApplied(){applied++;}});
 try {
  const result = await launch(f, false, undefined, mode === "remote" ? {machine:"fixture"} : {});
  assert.equal(result.isError,true); assert.equal(applied,0); assert.equal(mock.sessions.length,0);
  assert.equal(f.events.filter((event) => event.channel === "subagent:worker-decision-accepted").length,0);
 } finally {registration.dispose();mock.uninstall();}
});

for (const mode of ["missing-callable-api", "extra-callable"] as const) it(`actual child fails closed on ${mode}`, {skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "requires Pi 1.4.0 host"}, async () => {
 const f = fixture(); const mock = createMockPi(); mock.install(); mock.onCall({output:"done"});
 const source = path.join(f.root,"selected.mjs");
 fs.writeFileSync(source, `export default pi => pi.registerTool({name:'plugin_selected',label:'Selected',description:'Selected',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'ok'}],details:{}}}});`);
 f.agent.tools = ["read"]; f.host.getAllTools = () => [{name:"plugin_selected",description:"Selected",sourceInfo:{path:source}}];
 const host = await import(path.join(process.env.PI_SUBAGENTS_NATIVE_PI_ROOT!,"dist/index.js"));
 const {createDefaultChildSessionFactory} = await import("../../src/runs/shared/child-session.ts");
 let disposed = false;
 const real = createDefaultChildSessionFactory({loadPiCodingAgent:async()=>({...host,createAgentSession:async(options:any)=>{
  const result = await host.createAgentSession(options); const session = result.session; const dispose = session.dispose.bind(session);
  session.dispose = () => {disposed = true; return dispose();};
  if (mode === "missing-callable-api") session.getCallableToolNames = undefined;
  else { const callable = session.getCallableToolNames.bind(session); session.getCallableToolNames = () => [...callable(),"ungranted"]; }
  return result;
 }}) as any});
 setChildSessionFactory({create:(input)=>real.create({...input,model:undefined,parentProviderRegistry:undefined,storage:{kind:"memory"}}),dispose:()=>real.dispose()});
 const registration = owner(f,{async decide(){return {...selected,selectedTools:[{name:"plugin_selected",sourcePath:source}]} as WorkerDecision;}});
 try {
  const result = await f.executor.executeDelegated(`registry-${mode}`,{agent:f.agent.name,task:"Review",async:false,artifacts:false,acceptance:false},new AbortController().signal,undefined,f.ctx as any);
  assert.equal(result.isError,true); assert.match(JSON.stringify(result.content), mode === "missing-callable-api" ? /callable registry verification/ : /cannot enforce callable ceiling.*ungranted/); assert.equal(disposed,true);
 } finally {registration.dispose();mock.uninstall();}
});

it("async launch result carries the worker launch receipt without a false unavailable reason", async (t) => {
 const f = fixture();
 t.mock.method(childProcess, "spawn", () => { throw new Error("intercepted fixture spawn"); }); syncBuiltinESMExports();
 f.agent.tools = ["read", "grep"];
 const registration = owner(f, {async decide() {return selected;}});
 try {
  const result = await f.executor.execute("receipt-async", {agent:f.agent.name, task:"Review", async:true, artifacts:false, acceptance:false}, new AbortController().signal, undefined, f.ctx as any);
  const text = JSON.stringify(result.content);
  assert.match(text, /Worker launch: /);
  assert.match(text, /async\)/);
  assert.match(text, /Model: /);
  assert.match(text, /baseline\): read, grep/);
  assert.doesNotMatch(text, /do not support tool selection/);
 } finally { registration.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

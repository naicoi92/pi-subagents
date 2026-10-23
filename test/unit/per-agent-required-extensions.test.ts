import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgent, type RuntimeAgentDefinition } from "../../src/api/agents.ts";
import { registerRequiredChildExtensions } from "../../src/api/required-child-extensions.ts";
import { mergeRuntimeAgents } from "../../src/agents/runtime-agent-registry.ts";
import { mergeRequiredChildExtensions } from "../../src/shared/required-child-extensions.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";

function fixture(t: { after(fn: () => void): void }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "per-agent-required-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "helper.mjs");
	fs.writeFileSync(file, "export default () => {};\n");
	const pi = { on() {}, registerTool() {} } as unknown as ExtensionAPI;
	const requiredExtensions = [{ id: "worker-bound", path: file }];
	const definition: RuntimeAgentDefinition = { description: "Bounded worker", systemPrompt: "Work.", requiredExtensions };
	return { dir, file, pi, requiredExtensions, definition };
}

it("AC-1 public registration owns an immutable canonical snapshot across disposal", (t) => {
	const f = fixture(t);
	const handle = registerAgent({ pi: f.pi, name: "bounded-worker", definition: f.definition });
	t.after(handle.dispose);
	const [agent] = mergeRuntimeAgents(f.pi, { agents: [] }).agents;
	f.requiredExtensions[0].id = "mutated";
	assert.deepEqual(agent.requiredExtensions, [{ id: "worker-bound", path: fs.realpathSync(f.file), requireForAllRunners: true }]);
	assert.ok(Object.isFrozen(agent.requiredExtensions));
	assert.throws(() => registerAgent({ pi: f.pi, name: "bounded-worker", definition: f.definition }), /collides/);
	handle.dispose(); handle.dispose();
	assert.deepEqual(mergeRuntimeAgents(f.pi, { agents: [] }).agents, []);
	assert.equal(agent.requiredExtensions?.[0].id, "worker-bound");
	const replacement = registerAgent({ pi: f.pi, name: "bounded-worker", definition: f.definition });
	t.after(replacement.dispose);
	handle.dispose();
	assert.equal(mergeRuntimeAgents(f.pi, { agents: [] }).agents.length, 1);
});

it("AC-1 public registration rejects malformed required helper definitions", (t) => {
	const f = fixture(t);
	for (const requiredExtensions of [[{ id: "bad id", path: f.file }], [{ id: "missing", path: path.join(f.dir, "absent.mjs") }], [{ id: "flag", path: f.file, requireForAllRunners: true }], [{ id: "dup", path: f.file }, { id: "dup", path: f.file }], false]) {
		assert.throws(() => registerAgent({ pi: f.pi, name: "bounded-worker", definition: { ...f.definition, requiredExtensions } as unknown as RuntimeAgentDefinition }), /Required|Runtime agent/);
	}
});

it("AC-2 retained and inherited requirements compose with current global requirements despite empty caller snapshot", (t) => {
	const f = fixture(t);
	const other = path.join(f.dir, "global.mjs"); fs.writeFileSync(other, "export default () => {};\n");
	const sessionId = `per-agent-${Date.now()}`;
	const handle = registerRequiredChildExtensions({ sessionId, extensions: [{ id: "global", path: other }] });
	t.after(handle.dispose);
	const launch = buildInProcessChildLaunch({ parentSessionId: sessionId, requiredExtensions: [], inherited: { requiredExtensions: [{ id: "worker-bound", path: f.file, requireForAllRunners: true }] }, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, extensions: [], cwd: f.dir, childAgentName: "worker", childIndex: 0, host: "parent" });
	assert.deepEqual(launch.launchResolvedExtensions.required, ["worker-bound", "global"]);
});

it("AC-3 async resolved plans preserve per-agent requirements with optional extensions empty", (t) => {
	const f = fixture(t);
	const handle = registerAgent({ pi: f.pi, name: "bounded-worker", definition: { ...f.definition, extensions: [], model: "mock/model" } });
	t.after(handle.dispose);
	const agents = mergeRuntimeAgents(f.pi, { agents: [] }).agents;
	const built = buildAsyncRunnerSteps("per-agent", { chain: [{ agent: "bounded-worker", task: "Work." }], agents, ctx: { cwd: f.dir }, cwd: f.dir, maxSubagentDepth: 1 });
	assert.ok(!("error" in built), JSON.stringify(built));
	if ("error" in built) return;
	const step = built.steps[0];
	assert.deepEqual(step.requiredExtensions, [{ id: "worker-bound", path: fs.realpathSync(f.file), requireForAllRunners: true }]);
	const launch = buildRunnerChildLaunch(JSON.parse(JSON.stringify(step)), { cwd: f.dir, id: "run", flatIndex: 0 }, { sessionEnabled: false, watchdogStatus() {} });
	assert.ok(launch.session.extensionPaths.includes(fs.realpathSync(f.file)));
});

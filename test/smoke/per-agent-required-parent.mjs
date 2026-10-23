import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PER_AGENT_SMOKE_ROOT;
const installed = process.env.PER_AGENT_SMOKE_PACKAGE;
const { default: registerSubagents } = await import(pathToFileURL(path.join(installed, "index.js")).href);
const { registerAgent } = await import(pathToFileURL(path.join(installed, "src/api/agents.js")).href);
const { registerSubagentCapabilityCeiling } = await import(pathToFileURL(path.join(installed, "src/api/capability-ceiling.js")).href);

export default function (pi) {
	let tool;
	const host = new Proxy(pi, { get(target, key) {
		if (key === "registerTool") return (definition) => { target.registerTool(definition); if (definition.name === "subagent") tool = definition; };
		if (key === "sendMessage") return (message, options) => target.sendMessage(message, { ...options, triggerTurn: false });
		if (key === "sendUserMessage") return () => {};
		return Reflect.get(target, key);
	} });
	registerSubagents(host);
	const bounded = registerAgent({ pi: host, name: "bounded-worker", definition: {
		description: "Required helper smoke worker", systemPrompt: "Return the deterministic response.", model: "local/bounded", tools: [], extensions: [],
		requiredExtensions: [{ id: "worker-bound", path: path.join(root, "helper.mjs") }],
	} });
	registerAgent({ pi: host, name: "ordinary-sibling", definition: { description: "Unrestricted sibling", systemPrompt: "Return the deterministic response.", model: "local/sibling", tools: [], extensions: [] } });
	pi.on("session_start", async (_event, ctx) => {
		const timer = setTimeout(() => { console.error("per-agent smoke timeout"); process.exit(1); }, 90000);
		const receipts = [];
		let ceiling;
		const requests = () => fs.existsSync(path.join(root, "requests.jsonl")) ? fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
		const setDenied = () => { ceiling = registerSubagentCapabilityCeiling({ sessionId: ctx.sessionManager.getSessionId(), source: "per-agent-smoke-denial", ceiling: { denyExtensions: true } }); };
		const options = { context: "fresh", acceptance: false, mission: false, timeoutMs: 20000 };
		const call = async (id, params) => {
			let result;
			try { result = await tool.execute(id, { ...params, options }, new AbortController().signal, undefined, ctx); }
			catch (error) { result = { isError: true, error: String(error) }; }
			receipts.push({ id, result });
			fs.writeFileSync(path.join(root, "receipts.json"), JSON.stringify(receipts, null, 2));
			return result;
		};
		const waitForTerminal = async (launch) => {
			assert.ok(launch.details?.asyncDir, JSON.stringify(launch));
			const dir = launch.details.asyncDir;
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const terminalFile = path.join(dir, "process-terminal.json");
				if (fs.existsSync(terminalFile)) {
					const terminal = JSON.parse(fs.readFileSync(terminalFile, "utf8"));
					if (terminal.state === "observed") {
						const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
						assert.equal(status.state, "complete", JSON.stringify(status));
						assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" });
						fs.cpSync(dir, path.join(root, `retained-${launch.details.asyncId}`), { recursive: true });
						return { dir, status };
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			throw new Error(`runner terminal not observed: ${dir}`);
		};
		try {
			assert.ok(tool);
			setDenied();
			for (const [id, params] of [
				["denied-direct", { agent: "bounded-worker", task: "Work", async: false }],
				["denied-async", { agent: "bounded-worker", task: "Work", async: true }],
				["denied-workflow", { workflow: path.join(root, "workflow.js"), async: false }],
			]) {
				const result = await call(id, params);
				assert.match(JSON.stringify(result), /denies extensions.*requires: worker-bound/);
				assert.equal(requests().filter((r) => r.model === "bounded").length, 0);
			}
			const sibling = await call("denied-policy-sibling", { agent: "ordinary-sibling", task: "Work", async: false });
			assert.notEqual(sibling.isError, true, JSON.stringify(sibling));
			assert.equal(requests().filter((r) => r.model === "sibling").length, 1);
			ceiling.dispose();
			const direct = await call("allowed-direct", { agent: "bounded-worker", task: "Work", async: false });
			assert.notEqual(direct.isError, true, JSON.stringify(direct));
			assert.deepEqual(direct.details.results[0].launchResolvedExtensions.required, ["worker-bound"]);
			const background = await call("allowed-async", { agent: "bounded-worker", task: "Work", async: true });
			const retained = await waitForTerminal(background);
			const descriptor = JSON.parse(fs.readFileSync(path.join(retained.dir, "recovery-descriptor.json"), "utf8"));
			assert.equal(descriptor.requiredExtensions[0].id, "worker-bound");
			const workflow = await call("allowed-workflow", { workflow: path.join(root, "workflow.js"), async: false });
			assert.notEqual(workflow.isError, true, JSON.stringify(workflow));
			assert.equal(requests().filter((r) => r.model === "bounded").length, 3);
			assert.ok(requests().filter((r) => r.model === "bounded").every((r) => r.helperLoadedBeforeRequest));
			bounded.dispose();
			setDenied();
			const recovery = await call("denied-retained-recovery", { action: "resume", id: background.details.asyncId, message: "Continue", async: true });
			assert.match(JSON.stringify(recovery), /denies extensions.*requires: worker-bound/);
			assert.equal(requests().filter((r) => r.model === "bounded").length, 3);
			ceiling.dispose();
			fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ complete: true, cases: receipts.map(({ id }) => id), requests: requests() }, null, 2));
			console.log("PASS per-agent required extension CLI: denied direct/async/workflow/recovery, allowed helper delivery, unaffected sibling, runner reaped");
			clearTimeout(timer);
			process.exit(0);
		} catch (error) {
			fs.writeFileSync(path.join(root, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, requests: requests() }, null, 2));
			console.error(error);
			clearTimeout(timer);
			process.exit(1);
		}
	});
}

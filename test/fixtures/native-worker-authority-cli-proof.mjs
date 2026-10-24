import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAsyncReceipt, assertForegroundReceipt } from "./native-worker-authority-cli-assertions.mjs";

// Explicit opt-in, one host/scenario per invocation; never discovered by the normal test suite.
const [directory, scenario, cli, sdkVersion, bindingKind] = process.argv.slice(2);
assert.ok(directory && ["foreground", "async"].includes(scenario) && cli && sdkVersion && ["package-entry", "compiled-public-sdk"].includes(bindingKind), "Usage: node native-worker-authority-cli-proof.mjs <owned-directory> <foreground|async> <absolute-cli> <sdk-version> <package-entry|compiled-public-sdk>");
assert.ok(path.isAbsolute(cli));
assert.ok(path.isAbsolute(directory));
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.chmodSync(directory, 0o700);
const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: candidate, encoding: "utf8" }).trim();
const sourceFiles = [...new Set([...git("ls-files").split("\n"), "test/fixtures/native-worker-authority-cli-extension.ts", "test/fixtures/native-worker-authority-cli-proof.mjs"])].filter((file) => fs.statSync(path.join(candidate, file)).isFile());
const sourceHashes = () => Object.fromEntries(sourceFiles.map((file) => [file, hash(fs.readFileSync(path.join(candidate, file)))]));
const inputHashes = sourceHashes();
const agentDir = path.join(directory, "agent");
fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
const auditPath = path.join(directory, "audit.jsonl");
const records = () => fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const wait = async (predicate, ms, label) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Observation deadline: ${label}`);
};
let parentRequests = 0;
const requests = [];
const server = createServer(async (request, response) => {
	try {
		assert.equal(request.socket.remoteAddress, "127.0.0.1");
		assert.equal(request.url, "/v1/chat/completions");
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push({ at: Date.now(), model: body.model, reasoning_effort: body.reasoning_effort });
		fs.appendFileSync(path.join(directory, "requests.jsonl"), `${JSON.stringify(requests.at(-1))}\n`, { mode: 0o600 });
		const tool = body.model === "parent" && parentRequests++ === 0;
		const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "authority-proof-child", type: "function", function: {
			name: "subagent", arguments: JSON.stringify({ agent: "authority-proof-worker", task: "Return CHILD_RECEIPT_OK without tools.", async: scenario === "async", options: { context: "fresh", acceptance: false, artifacts: false } }),
		} }] } : { role: "assistant", content: body.model === "parent" ? "PARENT_RECEIPT_OK" : "CHILD_RECEIPT_OK" };
		const chunk = { id: "local-authority-proof", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] };
		const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
	} catch (error) {
		write("provider-error.json", { error: String(error) });
		response.writeHead(400); response.end("Invalid fixture request");
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const thinkingLevelMap = { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
write("agent/models.json", { providers: { local: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-not-a-credential", models: ["parent", "baseline", "selected"].map((id) => ({ id, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 512, thinkingLevelMap, compat: { thinkingFormat: "openai", supportsReasoningEffort: true } })) } } });
write("agent/settings.json", { retry: { enabled: false }, compaction: { enabled: false }, subagents: { intercomBridge: { mode: "off" } } });
write("agent/auth.json", {});
fs.writeFileSync(path.join(agentDir, "agents/authority-proof-worker.md"), "---\nname: authority-proof-worker\ndescription: Bounded native authority receipt subject\nmodel: local/baseline\nthinking: high\ndefaultContext: fresh\ntools: read\n---\nReturn CHILD_RECEIPT_OK without using tools.\n", { mode: 0o600 });
const args = ["--mode", "rpc", "--no-extensions", "--extension", path.join(candidate, "index.ts"), "--extension", path.join(candidate, "test/fixtures/native-worker-authority-cli-extension.ts"), "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-approve", "--model", "local/parent", "--thinking", "high"];
const env = { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_SUBAGENTS_TEMP_ROOT: path.join(directory, "runtime"), NATIVE_AUTHORITY_AUDIT: auditPath, NATIVE_AUTHORITY_SDK_VERSION: sdkVersion, NATIVE_AUTHORITY_BINDING_KIND: bindingKind };
const hostVersion = execFileSync(cli, ["--version"], { cwd: directory, env, encoding: "utf8", timeout: 10_000 }).trim();
write("inputs.json", { candidateSha: git("rev-parse", "HEAD"), workingTree: git("status", "--short"), sourceHashes: inputHashes, cliSha256: hash(fs.readFileSync(cli)), hostVersion, sdkVersion, bindingKind });
const configHashes = () => Object.fromEntries(["auth.json", "models.json", "settings.json"].map((file) => [file, hash(fs.readFileSync(path.join(agentDir, file)))]));
const beforeConfig = configHashes();
write("invocation.json", { cli, args, env, cwd: directory, scenario, harnessPid: process.pid, endpoint: `http://127.0.0.1:${address.port}/v1` });
const child = spawn(cli, args, { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
const stdout = fs.createWriteStream(path.join(directory, "stdout.raw"), { mode: 0o600 });
const stderr = fs.createWriteStream(path.join(directory, "stderr.raw"), { mode: 0o600 });
child.stdout.pipe(stdout); child.stderr.pipe(stderr);
let closed;
const close = new Promise((resolve) => child.once("close", (code, signal) => { closed = { code, signal, at: Date.now() }; write("process-close.json", closed); resolve(closed); }));
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
try {
	await wait(() => records().find((r) => r.type === "ready") || (closed && (() => { throw new Error("CLI closed before ready"); })()), 15_000, "authority registration");
	send({ id: "proof-start", type: "prompt", message: "Execute the bounded receipt task." });
	const result = await wait(() => records().find((r) => r.type === "native_result"), 45_000, "native result");
	assert.equal(result.isError, false, "Native tool returned an error; inspect private audit");
	let terminal;
	let completed = result;
	if (scenario === "async") {
		const id = result.details?.asyncId ?? result.details?.runId;
		assert.ok(id, "Async acknowledgment lacks public run identity");
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const count = records().filter((r) => r.type === "public_status").length;
			send({ id: `status-${count}`, type: "prompt", message: `/authority-proof-status ${id}` });
			const status = await wait(() => records().filter((r) => r.type === "public_status")[count], 4_000, "public status reply");
			assert.equal(status.reply.success, true, "Public status failed");
			completed = status.reply.data;
			terminal = completed.details?.lifecycleStatus?.processTerminal;
			if (terminal?.state === "observed") break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assertAsyncReceipt(completed);
	}
	// CLI-01 and CLI-02 are separate scenario assertions; expected values are matrix literals.
	assert.deepEqual(requests.filter((r) => r.model !== "parent").map(({ model, reasoning_effort }) => ({ model, reasoning_effort })), [{ model: "selected", reasoning_effort: "medium" }]);
	if (scenario === "foreground") assertForegroundReceipt(completed);
	const decisions = records().filter((r) => r.type === "decide");
	const applied = records().filter((r) => r.type === "applied");
	assert.equal(decisions.length, 1); assert.equal(applied.length, 1);
	assert.equal(decisions[0].baseline.thinking, "high");
	assert.equal(applied[0].receipt.logicalLaunchId, decisions[0].logicalLaunchId);
	assert.equal(applied[0].receipt.model, "local/selected"); assert.equal(applied[0].receipt.thinking, "medium");
	child.stdin.end();
	const outcome = await Promise.race([close, new Promise((_, reject) => setTimeout(() => reject(new Error("Orderly CLI close not observed")), 10_000).unref())]);
	assert.equal(outcome.code, 0);
	assert.deepEqual(sourceHashes(), inputHashes, "Candidate sources changed during proof");
	assert.deepEqual(configHashes(), beforeConfig, "Isolated configuration changed during proof");
	write("config-hashes.json", { before: beforeConfig, after: configHashes() });
	assert.ok(records().some((r) => r.type === "session_shutdown"));
	await new Promise((resolve) => server.close(resolve));
	write("outcome.json", { passed: true, scenario, hostVersion, sdkVersion, bindingKind, binding: records().find((r) => r.type === "binding"), decisions: decisions.length, commitments: applied.length, logicalLaunchId: decisions[0].logicalLaunchId, terminal: terminal ?? { state: "not-exposed-for-foreground", method: "parent CLI close after completed tool result and session_shutdown" }, cleanup: "Loopback server closed only after native terminal (async) and orderly parent close; all artifacts retained." });
	console.log(JSON.stringify({ passed: true, scenario, directory }));
} catch (error) {
	// Do not kill or tear down dependencies of an unobserved child. Owner can inspect retained lane.
	write("outcome.json", { passed: false, scenario, error: String(error), childPid: child.pid, harnessPid: process.pid, closed, dependenciesRetained: true });
	console.error(JSON.stringify({ passed: false, scenario, directory, error: String(error) }));
	if (closed && !records().some((r) => r.type === "native_result")) await new Promise((resolve) => server.close(resolve));
	process.exitCode = 1;
}

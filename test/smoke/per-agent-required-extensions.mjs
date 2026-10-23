// Real local Pi CLI and packed dependency. No paid provider, credentials, or host cache patches.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), "per-agent-cli-"));
fs.mkdirSync(root, { recursive: true });
assert.ok(!fs.existsSync(path.join(root, "node_modules")), "requires pristine owned fixture dependencies");
for (const dir of ["home", "agent/extensions/subagent", "work"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
const env = { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), XDG_CACHE_HOME: path.join(root, "cache"), npm_config_cache: path.join(root, "npm-cache"), NODE_COMPILE_CACHE: path.join(root, "node-cache"), JITI_FS_CACHE: "false", PI_OFFLINE: "1", PER_AGENT_SMOKE_ROOT: root };
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key) || ["NODE_OPTIONS", "NODE_PATH", "JITI_ALIAS"].includes(key)) delete env[key];
function run(name, command, args, cwd = source) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
	fs.writeFileSync(path.join(root, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
	return result;
}
run("build", process.execPath, ["scripts/build-package.mjs"]);
const packed = JSON.parse(run("pack", "npm", ["pack", "--json", "--pack-destination", root, path.join(source, "dist-pkg")]).stdout)[0];
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "pi-subagents": `file:${path.join(root, packed.filename)}`, "@earendil-works/pi-coding-agent": "1.2.0" } }));
run("install", "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], root);
const installed = path.join(root, "node_modules/pi-subagents");
env.PER_AGENT_SMOKE_PACKAGE = installed;
fs.copyFileSync(new URL("per-agent-required-parent.mjs", import.meta.url), path.join(root, "parent.mjs"));
fs.writeFileSync(path.join(root, "helper.mjs"), `export default function(pi) { pi.on("before_agent_start", e => ({systemPrompt:e.systemPrompt + "\\nREQUIRED_HELPER_READY"})); }\n`);
fs.writeFileSync(path.join(root, "workflow.js"), 'return await runs.run("bounded", {agent:"bounded-worker",task:"Work"});\n');
fs.writeFileSync(path.join(root, "agent/extensions/subagent/config.json"), JSON.stringify({ toolActivation: "eager", missions: { enabled: false }, intercomBridge: { mode: "off" } }));
const server = http.createServer(async (req, res) => {
	let body = ""; for await (const chunk of req) body += chunk;
	const parsed = JSON.parse(body);
	fs.appendFileSync(path.join(root, "requests.jsonl"), JSON.stringify({ model: parsed.model, helperLoadedBeforeRequest: JSON.stringify(parsed.messages).includes("REQUIRED_HELPER_READY") }) + "\n");
	const chunk = { id: "local", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: "assistant", content: "Deterministic local completion." }, finish_reason: null }] };
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
fs.writeFileSync(path.join(root, "agent/models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture-not-a-credential", models: ["parent", "bounded", "sibling"].map((id) => ({ id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 128 })) } } }));
const cli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const args = [cli, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--model", "local/parent", "-e", path.join(root, "parent.mjs")];
fs.writeFileSync(path.join(root, "command.json"), JSON.stringify({ command: [process.execPath, ...args], cwd: path.join(root, "work") }, null, 2));
const child = spawn(process.execPath, args, { cwd: path.join(root, "work"), env, stdio: ["pipe", "pipe", "pipe"] });
const output = fs.createWriteStream(path.join(root, "parent.log"));
child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
const timer = setTimeout(() => child.kill("SIGTERM"), 100000);
try {
	const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	fs.writeFileSync(path.join(root, "parent-terminal.json"), JSON.stringify({ pid: child.pid, closeObserved: true, code }));
	assert.equal(code, 0, fs.readFileSync(path.join(root, "parent.log"), "utf8"));
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8")).complete, true);
	console.log(`PASS real packed per-agent CLI; receipts retained in ${root}`);
} finally {
	clearTimeout(timer);
	child.stdin.destroy();
	await new Promise((resolve) => server.close(resolve));
	output.end();
}

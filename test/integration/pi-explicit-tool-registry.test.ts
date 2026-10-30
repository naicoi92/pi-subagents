import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";

// This probes the host SDK, without a model or provider. It is not a child-launch test.
it("Pi explicit tool list keeps unselected deferred and MCP resources uncallable, including late registration", {
	skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "Requires PI_SUBAGENTS_NATIVE_PI_ROOT",
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-explicit-tools-"));
	const agentDir = path.join(root, "agent");
	const extensionPath = path.join(root, "tools.mjs");
	fs.writeFileSync(extensionPath, `
export default function (pi) {
  const tool = (name, exposure = "direct") => ({
    name, label: name, description: name, exposure,
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "CALLED_" + name }], details: {} }; },
  });
  pi.registerTool(tool("selected"));
  for (const name of ["unselected", "mcp__demo__extra", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) pi.registerTool(tool(name, "deferred"));
  globalThis.__piExplicitToolsRegisterLate = () => pi.registerTool(tool("late_different", "deferred"));
}
`);
	try {
		const hostRoot = process.env.PI_SUBAGENTS_NATIVE_PI_ROOT!;
		const manifest = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")) as { version: string };
		assert.equal(manifest.version, "1.4.0", "proof targets Pi 1.4.0");
		const host = await import(pathToFileURL(path.join(hostRoot, "dist/index.js")).href);
		const settingsManager = host.SettingsManager.inMemory({});
		const resourceLoader = new host.DefaultResourceLoader({
			cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [extensionPath],
		});
		await resourceLoader.reload();
		const modelRuntime = await host.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		const { session } = await host.createAgentSession({
			cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime,
			sessionManager: host.SessionManager.inMemory(root),
			tools: ["read", "selected"],
			excludeTools: ["mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
		});
		try {
			await session.bindExtensions({});
			assert.deepEqual(session.getCallableToolNames().sort(), ["read", "selected"]);
			(globalThis as typeof globalThis & { __piExplicitToolsRegisterLate: () => void }).__piExplicitToolsRegisterLate();
			assert.deepEqual(session.getCallableToolNames().sort(), ["read", "selected"]);
			assert.deepEqual(session.getAllTools().map((tool: { name: string }) => tool.name).sort(), ["read", "selected"]);
			const tool = session.agent.state.tools.find((candidate: { name: string }) => candidate.name === "selected");
			assert.ok(tool, "selected tool must be directly executable");
			const result = await tool.execute("proof", {}, new AbortController().signal);
			assert.equal(result.content[0].text, "CALLED_selected");
		} finally {
			session.dispose();
		}
	} finally {
		delete (globalThis as typeof globalThis & { __piExplicitToolsRegisterLate?: () => void }).__piExplicitToolsRegisterLate;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

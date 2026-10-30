import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatWorkerLaunchReceipt, toolSelectionUnavailableReason } from "../../src/runs/shared/worker-launch-receipt.ts";

const receipt = { model: "claude-code/claude-haiku-5-5", thinking: "low", reason: "assessed", digest: "d", logicalLaunchId: "l", ownerGeneration: "g" } as any;

describe("worker launch receipt", () => {
	it("shows agent, context, model, effort, decision and tool lists", () => {
		const text = formatWorkerLaunchReceipt({ agent: "scout", context: "fresh", async: true, baselineTools: ["read", "grep"], receipt, toolSelectionUnavailable: "remote launches do not support tool selection" });
		for (const part of ["scout (fresh, async)", "Model: claude-code/claude-haiku-5-5", "Effort: low", "Decision: assessed", "baseline): read, grep", "auto-selected): none — remote launches do not support tool selection"]) assert.ok(text.includes(part), part);
	});
	it("lists auto-selected and caller tools", () => {
		const text = formatWorkerLaunchReceipt({ agent: "worker", context: "fork", async: false, baselineTools: undefined, receipt: { ...receipt, selectedTools: [{ name: "plugin_x" }], callerTools: ["grep"] } });
		assert.ok(text.includes("baseline): executor default") && text.includes("(caller): grep") && text.includes("auto-selected): plugin_x"));
	});
	it("states why tool selection is unavailable, in precedence order", () => {
		const base = { remote: false, denyExtensions: false, baselineSupported: true };
		assert.equal(toolSelectionUnavailableReason(base), undefined);
		assert.match(toolSelectionUnavailableReason({ ...base, remote: true })!, /remote/);
		assert.match(toolSelectionUnavailableReason({ ...base, remote: true })!, /remote/);
		assert.match(toolSelectionUnavailableReason({ ...base, denyExtensions: true })!, /ceiling/);
		assert.match(toolSelectionUnavailableReason({ ...base, baselineSupported: false })!, /baseline/);
		assert.match(toolSelectionUnavailableReason({ ...base, probeError: new Error("boom") })!, /boom/);
	});
});

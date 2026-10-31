import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeToolSelection, formatWorkerLaunchReceipt, toolSelectionUnavailableReason } from "../../src/runs/shared/worker-launch-receipt.ts";

const receipt = { model: "claude-code/claude-haiku-5-5", thinking: "low", reason: "assessed", digest: "d", logicalLaunchId: "l", ownerGeneration: "g" } as any;

describe("worker launch receipt", () => {
	it("shows agent, context, model, effort, decision and tool lists", () => {
		const text = formatWorkerLaunchReceipt({ agent: "scout", context: "fresh", async: true, baselineTools: ["read", "grep"], receipt, toolSelectionUnavailable: "remote launches do not support tool selection" });
		for (const part of ["scout (fresh, async)", "Model: claude-code/claude-haiku-5-5", "Effort: low", "Decision: assessed", "baseline): read, grep", "auto-selected): none — remote launches do not support tool selection"]) assert.ok(text.includes(part), part);
	});
	it("lists auto-selected and caller tools", () => {
		const text = formatWorkerLaunchReceipt({ agent: "worker", context: "fork", async: false, baselineTools: undefined, receipt: { ...receipt, selectedTools: [{ name: "plugin_x" }], callerTools: ["grep"] } });
		assert.ok(text.includes("baseline): executor default") && text.includes("(caller): grep") && text.includes("auto-selected, 1): plugin_x"));
	});
	it("lists tools not selected with counts and bounds long lists", () => {
		const inventory = ["read", "grep", "plugin_x", "plugin_y", "plugin_z"];
		const text = formatWorkerLaunchReceipt({ agent: "worker", context: "fresh", async: false, baselineTools: ["read"], receipt: { ...receipt, selectedTools: [{ name: "plugin_x" }], callerTools: ["grep"] }, inventoryTools: inventory });
		assert.match(text, /auto-selected, 1\): plugin_x/);
		assert.match(text, /not selected, 2\): plugin_y, plugin_z/);
		const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
		const big = formatWorkerLaunchReceipt({ agent: "worker", context: "fresh", async: false, baselineTools: undefined, receipt, inventoryTools: many });
		assert.match(big, /not selected, 100\): t0, .* \(\+\d+ more\)/);
	});
	it("summarizes selection for the child within warning bounds", () => {
		const line = summarizeToolSelection({ selected: ["plugin_x"], inventory: ["plugin_x", ...Array.from({ length: 299 }, (_, i) => `tool_number_${i}`)] });
		assert.ok(Buffer.byteLength(line) <= 512);
		assert.match(line, /^Tools selected \(1\): plugin_x; not selected \(299\): /);
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

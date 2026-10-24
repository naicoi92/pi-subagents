import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assertAsyncReceipt, assertForegroundReceipt } from "./native-worker-authority-cli-assertions.mjs";

function asyncReceipt(t, native = { success: true, results: [{ success: true, output: "CHILD_RECEIPT_OK" }] }) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "authority-receipt-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const resultPath = path.join(directory, "result.json");
	fs.writeFileSync(resultPath, JSON.stringify(native));
	return {
		text: `Task: Return CHILD_RECEIPT_OK\nResult: ${resultPath}`,
		details: { lifecycleStatus: { processTerminal: {
			state: "observed", runnerProcessInstanceId: "runner-current",
			instances: [{ kind: "runner", processInstanceId: "runner-current", exitCode: 0, signal: null }],
		} } },
	};
}

test("CLI-04 rejects observed nonzero runner even alongside unrelated successful runner", (t) => {
	const receipt = asyncReceipt(t);
	const terminal = receipt.details.lifecycleStatus.processTerminal;
	terminal.instances[0].exitCode = 7;
	terminal.instances.push({ kind: "runner", processInstanceId: "other", exitCode: 0, signal: null });
	assert.throws(() => assertAsyncReceipt(receipt));
});
test("CLI-04 rejects wrong runner identity", (t) => {
	const receipt = asyncReceipt(t);
	receipt.details.lifecycleStatus.processTerminal.instances[0].processInstanceId = "other";
	assert.throws(() => assertAsyncReceipt(receipt));
});
test("CLI-04 rejects signaled runner", (t) => {
	const receipt = asyncReceipt(t);
	receipt.details.lifecycleStatus.processTerminal.instances[0].signal = "SIGTERM";
	assert.throws(() => assertAsyncReceipt(receipt));
});
test("CLI-01 rejects task marker with empty foreground finalOutput", () => {
	assert.throws(() => assertForegroundReceipt({ details: { results: [{ task: "Return CHILD_RECEIPT_OK", finalOutput: "" }] } }));
});
test("CLI-02 rejects task marker with empty native output", (t) => {
	assert.throws(() => assertAsyncReceipt(asyncReceipt(t, { success: true, results: [{ success: true, task: "Return CHILD_RECEIPT_OK", output: "" }] })));
});
test("CLI-02 rejects unsuccessful native result even with output marker", (t) => {
	assert.throws(() => assertAsyncReceipt(asyncReceipt(t, { success: false, results: [{ success: true, output: "CHILD_RECEIPT_OK" }] })));
});
test("CLI-01 accepts actual foreground finalOutput", () => {
	assertForegroundReceipt({ details: { results: [{ finalOutput: "CHILD_RECEIPT_OK" }] } });
});
test("CLI-02/04 accepts successful native output and matching clean runner", (t) => {
	assertAsyncReceipt(asyncReceipt(t));
});

// Explicit read-only saved-receipt replay; never launches a CLI or provider.
if (process.env.NATIVE_AUTHORITY_REPLAY_ROOT) {
	for (const scenario of ["foreground", "async"]) test(`saved ${scenario} receipt REPLAY (not fresh E2E)`, () => {
		const records = fs.readFileSync(path.join(process.env.NATIVE_AUTHORITY_REPLAY_ROOT, scenario, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
		if (scenario === "foreground") assertForegroundReceipt(records.find((record) => record.type === "native_result"));
		else {
			const status = records.filter((record) => record.type === "public_status").at(-1);
			assert.equal(status.reply.success, true);
			assertAsyncReceipt(status.reply.data);
		}
	});
}

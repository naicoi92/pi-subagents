import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

export function assertForegroundReceipt(completed) {
	const results = completed.details?.results;
	assert.equal(results?.length, 1, "Expected one completed foreground child");
	assert.equal(typeof results[0].finalOutput, "string", "Foreground finalOutput unavailable");
	assert.match(results[0].finalOutput, /CHILD_RECEIPT_OK/, "Foreground output lacks provider response");
}

export function assertAsyncReceipt(completed) {
	const terminal = completed.details?.lifecycleStatus?.processTerminal;
	assert.equal(terminal?.state, "observed", "Native process terminal not observed: retain dependencies");
	assert.ok(terminal.runnerProcessInstanceId, "Runner process identity unavailable");
	const runner = terminal.instances?.find((instance) => instance.kind === "runner" && instance.processInstanceId === terminal.runnerProcessInstanceId);
	assert.ok(runner, "Matching observed runner instance unavailable");
	assert.equal(runner.exitCode, 0, "Native runner did not exit successfully");
	assert.equal(runner.signal, null, "Native runner terminated by signal");
	// Public status exposes native resultPath as its Result: line, not a top-level field.
	const resultPath = /^Result: (.+)$/m.exec(completed.text ?? "")?.[1];
	assert.ok(resultPath && path.isAbsolute(resultPath), "Public status lacks absolute native result path");
	const native = JSON.parse(fs.readFileSync(resultPath, "utf8"));
	assert.equal(native.success, true, "Native result did not succeed");
	assert.equal(native.results?.length, 1, "Expected one completed native child");
	assert.equal(native.results[0].success, true, "Native child did not succeed");
	assert.equal(typeof native.results[0].output, "string", "Native output unavailable");
	assert.match(native.results[0].output, /CHILD_RECEIPT_OK/, "Native output lacks provider response");
}

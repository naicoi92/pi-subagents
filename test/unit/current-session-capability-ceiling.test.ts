import assert from "node:assert/strict";
import { it } from "node:test";
import { registerSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { resolveCurrentSessionCapabilityCeiling } from "../../src/runs/shared/capability-ceiling.ts";

it("AC-7 intersects trusted UUID-only and legacy file-only registrations with inherited retained policy", (t) => {
	const manager = { getSessionId: () => "current-uuid-test", getSessionFile: () => "/current-session-test.jsonl" };
	const uuid = registerSubagentCapabilityCeiling({ sessionId: manager.getSessionId(), source: "uuid", ceiling: { allowedTools: ["read", "write"] } });
	t.after(uuid.dispose);
	assert.deepEqual(resolveCurrentSessionCapabilityCeiling(manager)?.allowedTools, ["read", "write"]);
	const file = registerSubagentCapabilityCeiling({ sessionId: manager.getSessionFile(), source: "file", ceiling: { allowedTools: ["read", "bash"], denyExtensions: true } });
	t.after(file.dispose);
	assert.deepEqual(resolveCurrentSessionCapabilityCeiling(manager), { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["file", "uuid"] });
	uuid.dispose();
	assert.deepEqual(resolveCurrentSessionCapabilityCeiling(manager)?.allowedTools, ["bash", "read"]);
	file.dispose();
	assert.equal(resolveCurrentSessionCapabilityCeiling(manager), undefined);
	assert.equal(resolveCurrentSessionCapabilityCeiling(manager, { version: 1, denyExtensions: true, sources: ["retained"] })?.denyExtensions, true);
});

it("AC-7 current session switch and fork do not inherit unrelated or disposed registry entries", (t) => {
	const first = registerSubagentCapabilityCeiling({ sessionId: "old-session-uuid", source: "old-session", ceiling: { denyExtensions: true } });
	t.after(first.dispose);
	assert.equal(resolveCurrentSessionCapabilityCeiling({ getSessionId: () => "new-session-uuid", getSessionFile: () => "/new-session.jsonl" }), undefined);
	assert.equal(resolveCurrentSessionCapabilityCeiling({ getSessionId: () => "fork-session-uuid", getSessionFile: () => "/fork-session.jsonl" }), undefined);
	first.dispose();
	assert.equal(resolveCurrentSessionCapabilityCeiling({ getSessionId: () => "old-session-uuid", getSessionFile: () => undefined }), undefined);
});

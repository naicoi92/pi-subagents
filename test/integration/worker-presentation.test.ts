import assert from "node:assert/strict";
import { it } from "node:test";
import { createEventBus, initTheme, CustomMessageComponent } from "@earendil-works/pi-coding-agent";
import { registerWorkerPresentation } from "../../src/api/worker-presentation.ts";
import { captureWorkerPresentation, invalidateWorkerPresentation, issueWorkerPresentationBinding, bindWorkerPresentationMessage, onWorkerPresentationChanged } from "../../src/shared/worker-presentation.ts";
import type { SubagentWorkerDecisionAcceptedEvent } from "../../src/api/worker-decision-authority.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { renderSubagentMessage } from "../../src/tui/subagent-messages.ts";
import { collectFleetStatusEntries, SubagentFleetStatus } from "../../src/tui/fleet-status.ts";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const accepted = (sessionId: string, runId: string): SubagentWorkerDecisionAcceptedEvent => Object.freeze({
	version: 1, sessionId, runId, toolCallId: "tool", logicalLaunchId: runId,
	receipt: Object.freeze({ logicalLaunchId: runId, ownerGeneration: "authority", digest: "digest", model: "fixture/model", thinking: "low", reason: "assessed", definitionRevision: "d", constraintRevision: "c" }),
});
function state(sessionId: string): SubagentState {
	return { baseCwd: process.cwd(), currentSessionId: sessionId, asyncJobs: new Map(), fleetJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} } };
}
function terminal() {
	const widgets = new Map<string, { render(width: number): string[] }>();
	let expanded = false, renders = 0;
	const ctx = { hasUI: true, mode: "tui", ui: { theme, getToolsExpanded: () => expanded, requestRender() { renders++; }, setWidget(key: string, factory: any) { if (factory) widgets.set(key, typeof factory === "function" ? factory({ requestRender() { renders++; } }, theme) : { render: () => factory }); else widgets.delete(key); } } };
	return { ctx: ctx as never, setExpanded(value: boolean) { expanded = value; }, lines: () => [...widgets.values()].flatMap((widget) => widget.render(160)).join("\n"), renders: () => renders };
}

it("worker presentation terminal surfaces: overlap, ack, dispose/reload and absent-consumer native fallback", () => {
	const sessionId = "presentation-widgets", s = state(sessionId), t = terminal();
	const owned: AsyncJobState = { asyncId: "owned-leaf", asyncDir: "/nonexistent/owned-leaf", mode: "single", agents: ["OWNED_ROW"], status: "running", startedAt: Date.now() };
	const sibling: AsyncJobState = { ...owned, asyncId: "unbound-leaf", agents: ["UNBOUND_ROW"] };
	s.asyncJobs.set(owned.asyncId, owned); s.asyncJobs.set(sibling.asyncId, sibling);
	s.lastUiContext = t.ctx;
	const tracker = createAsyncJobTracker({ events: createEventBus() }, s, "/nonexistent", {});
	const fleet = new SubagentFleetStatus(s, () => {});
	fleet.setContext(t.ctx); tracker.refreshWidget(t.ctx);
	const before = JSON.stringify([...s.asyncJobs.values()]);
	const registration = registerWorkerPresentation({ sessionId });
	const unsubscribe = onWorkerPresentationChanged((id) => { if (id === sessionId) { tracker.refreshWidget(t.ctx); fleet.refresh(); } });
	try {
		assert.match(t.lines(), /OWNED_ROW/); assert.match(t.lines(), /UNBOUND_ROW/);
		const event = accepted(sessionId, owned.asyncId); issueWorkerPresentationBinding(event);
		assert.equal(registration.acknowledge(event), true);
		assert.doesNotMatch(t.lines(), /OWNED_ROW/); assert.match(t.lines(), /UNBOUND_ROW/);
		assert.deepEqual(collectFleetStatusEntries(s).map((entry) => entry.agent), ["UNBOUND_ROW"]);
		t.setExpanded(true); assert.doesNotMatch(t.lines(), /OWNED_ROW/); assert.match(t.lines(), /UNBOUND_ROW/);
		invalidateWorkerPresentation(captureWorkerPresentation(sessionId));
		assert.match(t.lines(), /OWNED_ROW/); assert.match(t.lines(), /UNBOUND_ROW/);
		assert.equal(registration.acknowledge(event), false);
		assert.equal(JSON.stringify([...s.asyncJobs.values()]), before, "presentation cannot mutate inspection/model-facing state");
		assert.ok(t.renders() > 0);
	} finally { registration.dispose(); unsubscribe(); tracker.dispose(); fleet.dispose(); }
});

for (const status of ["completed", "failed", "stopped"] as const) it(`worker presentation notify ${status}: compact blank, native expanded output/reason, history and immediate disposal fallback`, async () => {
	const sessionId = `presentation-notify-${status}`, runId = `run-${status}`;
	const registration = registerWorkerPresentation({ sessionId });
	const event = accepted(sessionId, runId); issueWorkerPresentationBinding(event); assert.equal(registration.acknowledge(event), true);
	let sent: any;
	const notifier = registerSubagentNotify({ events: createEventBus(), isHeld: () => false, sendMessage(message) { sent = message; return false; } }, { currentSessionId: sessionId, completionOwnerId: "owner" }, { batchConfig: { enabled: false } });
	try {
		assert.equal(await notifier.deliver({ id: runId, runId, sessionId, completionOwnerId: "owner", source: "foreground", agent: "OWNED_ROW", success: status === "completed", state: status === "completed" ? "complete" : status, stopped: status === "stopped", summary: "useful output", error: status === "failed" ? "provider failure reason" : status === "stopped" ? "cancel reason" : undefined }), true);
		const original = JSON.stringify(sent);
		assert.equal(sent.display, true);
		// Real Pi retains details identity while copying the message envelope.
		const message = { role: "custom" as const, ...sent, timestamp: Date.now() };
		const component = new CustomMessageComponent(message, renderSubagentMessage);
		assert.doesNotMatch(component.render(160).join("\n"), /OWNED_ROW|useful output/);
		component.setExpanded(true);
		assert.match(component.render(160).join("\n"), /useful output/);
		if (status === "failed") assert.match(component.render(160).join("\n"), /provider failure reason/);
		if (status === "stopped") assert.match(component.render(160).join("\n"), /cancel reason/);
		component.setExpanded(false);
		const historical = renderSubagentMessage(JSON.parse(JSON.stringify(message)), { expanded: false }, theme as never)!;
		assert.match(historical.render(160).join("\n"), /OWNED_ROW/);
		registration.dispose();
		assert.match(component.render(160).join("\n"), /OWNED_ROW/, "cached component must restore without rebuild");
		assert.equal(JSON.stringify(sent), original, "message content, details and display unchanged");
	} finally { registration.dispose(); notifier.dispose(); }
});

it("worker presentation notify mixed/unbound and safety notices stay native", () => {
	const sessionId = "presentation-notice-mixed", owner = registerWorkerPresentation({ sessionId });
	try {
		const event = accepted(sessionId, "owned"); issueWorkerPresentationBinding(event); owner.acknowledge(event);
		const details = { runs: [{ agent: "OWNED_ROW", status: "failed" }, { agent: "UNBOUND_ROW", status: "failed" }] };
		bindWorkerPresentationMessage(details, [{ sessionId, runId: "owned" }, { sessionId, runId: "unbound" }]);
		const message = { customType: "subagent-notify", content: "useful output", details };
		assert.match(renderSubagentMessage(message, { expanded: false }, theme as never)!.render(160).join("\n"), /2 background runs/);
		for (const customType of ["subagent_supervisor_request", "subagent_control_notice", "subagent_watchdog_warning"]) {
			const safe = renderSubagentMessage({ ...message, customType }, { expanded: false }, theme as never);
			assert.ok(safe); assert.ok(safe.render(160).some((line) => line.trim()));
		}
	} finally { owner.dispose(); }
});

it("worker presentation silent async success keeps native display:false and content", async () => {
	const sessionId = "presentation-silent-success", runId = "silent-leaf", owner = registerWorkerPresentation({ sessionId });
	const event = accepted(sessionId, runId); issueWorkerPresentationBinding(event); owner.acknowledge(event);
	let sent: any;
	const notifier = registerSubagentNotify({ events: createEventBus(), isHeld: () => false, sendMessage(message) { sent = message; return false; } }, { currentSessionId: sessionId, completionOwnerId: "owner" }, { batchConfig: { enabled: false } });
	try {
		await notifier.deliver({ id: runId, runId, sessionId, completionOwnerId: "owner", success: true, source: "async", agent: "worker", summary: "retained model-facing output" });
		assert.equal(sent.display, false); assert.match(sent.content, /retained model-facing output/);
	} finally { owner.dispose(); notifier.dispose(); }
});

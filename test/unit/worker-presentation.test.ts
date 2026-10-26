import assert from "node:assert/strict";
import { it } from "node:test";
import { registerWorkerPresentation } from "../../src/api/worker-presentation.ts";
import { issueWorkerPresentationBinding, isWorkerPresentationDelegated, captureWorkerPresentation, invalidateWorkerPresentation } from "../../src/shared/worker-presentation.ts";
import type { SubagentWorkerDecisionAcceptedEvent } from "../../src/api/worker-decision-authority.ts";

function accepted(sessionId: string, runId = "leaf"): SubagentWorkerDecisionAcceptedEvent {
	return Object.freeze({ version: 1, sessionId, runId, toolCallId: "tool", logicalLaunchId: runId,
		receipt: Object.freeze({ logicalLaunchId: runId, ownerGeneration: "authority", digest: "digest", model: "fixture/model", thinking: "low", reason: "assessed", definitionRevision: "d", constraintRevision: "c" }) });
}

it("worker presentation: exact issued object only, synchronous ack and per-leaf isolation", () => {
	const sessionId = "presentation-exact";
	const owner = registerWorkerPresentation({ sessionId });
	try {
		const first = accepted(sessionId), second = accepted(sessionId, "sibling");
		assert.equal(owner.acknowledge(first), false);
		issueWorkerPresentationBinding(first); issueWorkerPresentationBinding(second);
		assert.equal(owner.acknowledge({ ...first }), false);
		assert.equal(owner.acknowledge(first), true);
		assert.equal(owner.acknowledge(first), true);
		assert.equal(isWorkerPresentationDelegated(sessionId, first.runId), true);
		assert.equal(isWorkerPresentationDelegated(sessionId, second.runId), false);
		assert.equal(isWorkerPresentationDelegated("other-session", first.runId), false);
		assert.throws(() => registerWorkerPresentation({ sessionId }), /already registered/);
	} finally { owner.dispose(); }
	assert.equal(isWorkerPresentationDelegated(sessionId, "leaf"), false);
});

it("worker presentation: missing consumer, stale registration/disposer and reload fail native", () => {
	const sessionId = "presentation-reload", oldEvent = accepted(sessionId);
	issueWorkerPresentationBinding(oldEvent);
	const old = registerWorkerPresentation({ sessionId });
	assert.equal(old.acknowledge(oldEvent), false);
	const event = accepted(sessionId); issueWorkerPresentationBinding(event);
	assert.equal(old.acknowledge(event), true);
	const captured = captureWorkerPresentation(sessionId);
	invalidateWorkerPresentation(captured);
	assert.equal(isWorkerPresentationDelegated(sessionId, event.runId), false);
	const next = registerWorkerPresentation({ sessionId });
	try {
		old.dispose(); invalidateWorkerPresentation(captured);
		assert.equal(old.acknowledge(event), false);
		assert.equal(next.acknowledge(event), false);
		const fresh = accepted(sessionId); issueWorkerPresentationBinding(fresh);
		assert.equal(next.acknowledge(fresh), true);
		assert.equal(isWorkerPresentationDelegated(sessionId, fresh.runId), true);
	} finally { next.dispose(); }
});

it("worker presentation: malformed registration cannot hide work; cross-session ack refused", async () => {
	assert.throws(() => registerWorkerPresentation({ sessionId: "" }));
	const owner = registerWorkerPresentation({ sessionId: "presentation-copy" });
	const other = registerWorkerPresentation({ sessionId: "presentation-other" });
	try {
		const copy = await import("../../src/shared/worker-presentation.ts?copy");
		const event = accepted("presentation-copy"); copy.issueWorkerPresentationBinding(event);
		assert.equal(other.acknowledge(event), false);
		assert.equal(owner.acknowledge(event), true);
		assert.equal(copy.isWorkerPresentationDelegated(event.sessionId, event.runId), true);
	} finally { owner.dispose(); other.dispose(); }
});

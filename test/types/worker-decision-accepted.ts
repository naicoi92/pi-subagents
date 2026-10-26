import { SUBAGENT_WORKER_DECISION_ACCEPTED_EVENT, type SubagentWorkerDecisionAcceptedEvent } from "../../src/api/worker-decision-authority.ts";

const channel: "subagent:worker-decision-accepted" = SUBAGENT_WORKER_DECISION_ACCEPTED_EVENT;
function immutable(event: SubagentWorkerDecisionAcceptedEvent): void {
	// @ts-expect-error Correlation identity is immutable.
	event.runId = channel;
	// @ts-expect-error Receipt reference is immutable.
	event.receipt = event.receipt;
	// @ts-expect-error Exact consumed receipt metadata is immutable.
	event.receipt.digest = "different";
	// @ts-expect-error Event does not expose authored task.
	event.task;
	// @ts-expect-error Event does not expose private policy context.
	event.policyContext;
	const digest: string = event.receipt.digest;
	const generation: string = event.receipt.ownerGeneration;
	void digest; void generation;
}
void immutable;

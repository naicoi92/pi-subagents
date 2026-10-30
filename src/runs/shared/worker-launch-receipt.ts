import type { AppliedWorkerDecision } from "../../shared/worker-decision-authority.ts";

export interface WorkerLaunchReceiptInput {
	readonly agent: string;
	readonly context: "fresh" | "fork";
	readonly async: boolean;
	readonly baselineTools: readonly string[] | undefined;
	readonly receipt: AppliedWorkerDecision;
	/** Why automatic tool selection could not run; undefined when it was supported. */
	readonly toolSelectionUnavailable?: string;
	readonly toolsIncomplete?: boolean;
}

/** Explicit, task-free launch facts shown to the parent: who runs, on what, with which tools. */
export function formatWorkerLaunchReceipt(input: WorkerLaunchReceiptInput): string {
	const { receipt } = input;
	const selected = receipt.selectedTools?.map((tool) => tool.name) ?? [];
	const caller = receipt.callerTools ?? [];
	const baseline = input.baselineTools?.length ? input.baselineTools.join(", ") : "executor default";
	const lines = [
		`Worker launch: ${input.agent} (${input.context}, ${input.async ? "async" : "sync"})`,
		`- Model: ${receipt.model}`,
		`- Effort: ${receipt.thinking}${receipt.requestedThinking && receipt.requestedThinking !== receipt.thinking ? ` (requested ${receipt.requestedThinking})` : ""}`,
		`- Decision: ${receipt.reason}`,
		`- Tools (agent baseline): ${baseline}`,
	];
	if (caller.length) lines.push(`- Tools (caller): ${caller.join(", ")}`);
	if (selected.length) lines.push(`- Tools (auto-selected): ${selected.join(", ")}`);
	else lines.push(`- Tools (auto-selected): none${input.toolSelectionUnavailable ? ` — ${input.toolSelectionUnavailable}` : ""}`);
	if (input.toolsIncomplete) lines.push("- Tool inventory: some host tool records were structurally invalid and omitted");
	return lines.join("\n");
}

/** First reason, in executor precedence, why automatic tool selection is unavailable. */
export function toolSelectionUnavailableReason(input: {
	readonly remote: boolean;
	readonly denyExtensions: boolean;
	readonly baselineSupported: boolean;
	readonly probeError?: unknown;
}): string | undefined {
	if (input.remote) return "remote launches do not support tool selection";
	if (input.denyExtensions) return "capability ceiling denies extensions";
	if (!input.baselineSupported) return "agent baseline uses wildcard, path, MCP, codemode or models tools";
	if (input.probeError !== undefined) return `launch tool plan failed: ${input.probeError instanceof Error ? input.probeError.message : String(input.probeError)}`;
	return undefined;
}

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
	/** Every host tool name the selector could see; not-selected = inventory minus granted tools. */
	readonly inventoryTools?: readonly string[];
}

const RECEIPT_LIST_LIMIT = 40;
const SUMMARY_BYTE_LIMIT = 512;

/** Inventory names that were neither selected, requested by the caller, nor in the agent baseline. */
export function unselectedTools(inventory: readonly string[] | undefined, granted: readonly string[]): string[] {
	const taken = new Set(granted);
	return [...new Set(inventory ?? [])].filter((name) => !taken.has(name));
}

/** Comma list capped at `limit` names with an explicit remainder, never a silent cut. */
function boundedList(names: readonly string[], limit: number): string {
	if (names.length <= limit) return names.join(", ");
	return `${names.slice(0, limit).join(", ")} (+${names.length - limit} more)`;
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
	if (selected.length) lines.push(`- Tools (auto-selected, ${selected.length}): ${selected.join(", ")}`);
	else lines.push(`- Tools (auto-selected): none${input.toolSelectionUnavailable ? ` — ${input.toolSelectionUnavailable}` : ""}`);
	const rejected = unselectedTools(input.inventoryTools, [...selected, ...caller, ...(input.baselineTools ?? [])]);
	if (rejected.length) lines.push(`- Tools (not selected, ${rejected.length}): ${boundedList(rejected, RECEIPT_LIST_LIMIT)}`);
	if (input.toolsIncomplete) lines.push("- Tool inventory: some host tool records were structurally invalid and omitted");
	return lines.join("\n");
}

/**
 * One line for the child's first prompt. Tool selection state travels through the bounded
 * warning channel, so the line is truncated at a name boundary below its byte budget.
 */
export function summarizeToolSelection(input: { selected: readonly string[]; inventory: readonly string[] }): string {
	const rejected = unselectedTools(input.inventory, input.selected);
	const head = `Tools selected (${input.selected.length}): ${input.selected.join(", ") || "none"}; not selected (${rejected.length}): `;
	let line = head;
	let shown = 0;
	for (const name of rejected) {
		const next = `${line}${shown ? ", " : ""}${name}`;
		const suffix = ` (+${rejected.length - shown - 1} more)`;
		if (Buffer.byteLength(next + suffix) > SUMMARY_BYTE_LIMIT) break;
		line = next;
		shown++;
	}
	return shown < rejected.length ? `${line} (+${rejected.length - shown} more)` : line;
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

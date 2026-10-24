import { resolveCurrentSessionId } from "./session-identity.ts";
import { getWorkerDecisionAuthoritySnapshot, WORKER_DECISION_AUTHORITY_LIMITS, WorkerDecisionAuthorityError, type WorkerDecisionAuthoritySnapshot } from "./worker-decision-authority.ts";

/** Native registration and routing share the existing file-first host identity, never a UUID fallback. */
export function readNativeWorkerAuthorityRouting(
	sessionManager: Parameters<typeof resolveCurrentSessionId>[0],
	expectedGeneration?: string,
): { sessionId: string; routing: WorkerDecisionAuthoritySnapshot } {
	const sessionId = resolveCurrentSessionId(sessionManager);
	// An overlength file key cannot have public registration. Preserve legacy unowned launches only.
	if (expectedGeneration === undefined && sessionId === sessionManager.getSessionFile() && sessionId.trim() === sessionId && !sessionId.includes("\0") && Buffer.byteLength(sessionId, "utf8") > WORKER_DECISION_AUTHORITY_LIMITS.idBytes) {
		return { sessionId, routing: { kind: "never-owned" } };
	}
	const routing = getWorkerDecisionAuthoritySnapshot(sessionId);
	if (expectedGeneration !== undefined && (routing.kind !== "active" || routing.generation !== expectedGeneration)) {
		throw new WorkerDecisionAuthorityError(routing.kind === "disposed" ? "session-disposed" : routing.kind === "active" ? "stale-owner" : "owner-missing");
	}
	return { sessionId, routing };
}

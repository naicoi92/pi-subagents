import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkerDecisionAuthority, type WorkerDecisionAuthorityRegistration } from "../../src/api/worker-decision-authority.ts";
import { resolveHostPiSdkBinding } from "../../src/runs/shared/pi-spawn.ts";
import { loadHostPiCodingAgent } from "../../src/runs/shared/child-session.ts";

/** Opt-in CLI proof: authority owns no classifier, provider, or child-session implementation. */
export default function (pi: ExtensionAPI) {
	const auditPath = process.env.NATIVE_AUTHORITY_AUDIT;
	if (!auditPath) throw new Error("NATIVE_AUTHORITY_AUDIT is required.");
	const log = (value: unknown) => fs.appendFileSync(auditPath, `${JSON.stringify({ at: Date.now(), ...value as object })}\n`);
	let registration: WorkerDecisionAuthorityRegistration | undefined;
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		if (!sessionId) throw new Error("Current session identity is unavailable.");
		const binding = resolveHostPiSdkBinding();
		if (!binding) throw new Error("Host SDK binding unavailable.");
		const manifest = fs.readFileSync(`${binding.root}/package.json`);
		const version = JSON.parse(manifest.toString()).version;
		const loaded = await loadHostPiCodingAgent();
		const samePublicSdk = loaded.createAgentSession === sdk.createAgentSession;
		const capabilities = Object.fromEntries(["createAgentSession", "ModelRuntime", "SessionManager", "DefaultResourceLoader", "resolveCliModel"].map((key) => [key, typeof (loaded as unknown as Record<string, unknown>)[key]]));
		const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
		log({ type: "binding", ...binding, version, manifestSha256: hash(manifest), executableSha256: hash(fs.readFileSync(process.execPath)), execPath: process.execPath, argv: process.argv, sessionId, samePublicSdk, capabilities });
		if (version !== process.env.NATIVE_AUTHORITY_SDK_VERSION || binding.kind !== process.env.NATIVE_AUTHORITY_BINDING_KIND || !samePublicSdk || Object.values(capabilities).some((kind) => kind !== "function")) throw new Error("Unexpected public host SDK binding.");
		registration = registerWorkerDecisionAuthority({ sessionId, lifetimeDeadline: Date.now() + 120_000, assessmentTimeoutMs: 5_000, authority: {
			async decide(request) {
				// Only policy baseline metadata is recorded; authored task/role text stays private.
				log({ type: "decide", logicalLaunchId: request.control.logicalLaunchId, baseline: request.policyContext.original,
					facts: { taskPresent: Boolean(request.facts.task), roleProvenance: request.facts.role?.provenance } });
				return { kind: "apply", model: "local/selected", thinking: "medium", reason: "assessed" };
			},
			onApplied(receipt) { log({ type: "applied", receipt }); },
		} });
		log({ type: "ready", generation: registration.generation });
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "subagent") log({ type: "native_result", isError: event.isError, content: event.content, details: event.details });
	});
	pi.registerCommand("authority-proof-status", { handler: async (id) => {
		const requestId = `authority-proof-${Date.now()}`;
		await new Promise<void>((resolve, reject) => {
			const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
				clearTimeout(timer); off(); log({ type: "public_status", reply }); resolve();
			});
			const timer = setTimeout(() => { off(); reject(new Error("Public status RPC timed out.")); }, 3_000);
			pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: { id } });
		});
	} });
	pi.on("session_shutdown", () => { registration?.dispose(); registration = undefined; log({ type: "session_shutdown" }); });
}

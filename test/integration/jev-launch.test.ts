import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installSingleExecutionHooks, makeExecutor, mockPi, tempDir, readCall, readAllCallArgs } from "../support/single-execution-fixture.ts";
import { makeAgent, makeMinimalCtx, events } from "../support/helpers.ts";
import { AGENCY_ROLES } from "../../src/agents/agency-roles.ts";

const role = AGENCY_ROLES.find((item) => item.id === "engineering-code-reviewer")!;
const candidate = { id: "review", agent: "worker", persona: role.id, model: "mock/test-model", effort: "high" };
function context(options: { failure?: boolean; onChoice?: () => void } = {}) {
	return {
		...makeMinimalCtx(tempDir),
		modelRegistry: {
			getAvailable: () => [{ provider: "mock", id: "test-model", reasoning: true }],
			getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-latest" }],
			classify: async () => {
				options.onChoice?.();
				if (options.failure) throw new Error("provider secret");
				return { provider: "typesafe", model: "jev-latest", stopReason: "stop", answers: {
					candidate: { type: "choice", choice: "review", confidence: 1, probabilities: { review: 1 } },
				} };
			},
		},
	};
}
function executor() {
	return makeExecutor([makeAgent("scout"), makeAgent("worker", { systemPrompt: "Base worker contract" })], { jev: { candidates: [candidate] } });
}

describe("Jev qua child launch pipeline", () => {
	installSingleExecutionHooks();
	it("AC-4 persona-launch: child nhận role prompt và tuple Jev thay hint", async () => {
		mockPi.onCall({ steps: [{ jsonl: [events.assistantMessage("Reviewed")] }] });
		const result = await executor().executePublic("jev-launch", { agent: "scout", task: "Review parser", async: false }, new AbortController().signal, undefined, context());
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const launch = readCall();
		assert.equal(launch.launch?.model, "mock/test-model:high");
		assert.equal(launch.runtime?.agent, "worker");
		assert.ok(launch.systemPrompts.some((prompt) => prompt.text?.includes(role.prompt)), JSON.stringify(launch.systemPrompts));
		const args = launch.effectiveArgs ?? launch.args;
		assert.equal(args[args.indexOf("--model") + 1], "mock/test-model:high");
	});
	it("AC-5 failure: lỗi Jev không tạo child launch", async () => {
		const result = await executor().executePublic("jev-failed", { agent: "scout", task: "Review parser", async: false }, new AbortController().signal, undefined, context({ failure: true }));
		assert.equal(result.isError, true);
		assert.equal(JSON.stringify(result).includes("provider secret"), false);
		assert.deepEqual(readAllCallArgs(), []);
	});
	it("AC-5 operator: lỗi Jev hỏi operator, không cho main fallback", async () => {
		let asked = 0;
		const ctx = { ...context({ failure: true }), hasUI: true, ui: { select: async () => { asked++; return undefined; } } };
		const result = await executor().executePublic("jev-operator", { agent: "scout", task: "Review parser", async: false }, new AbortController().signal, undefined, ctx);
		assert.equal(result.isError, true);
		assert.equal(asked, 1);
		assert.deepEqual(readAllCallArgs(), []);
	});
	it("AC-7 workflow-child: runs.run gọi Jev trước child launch", async () => {
		let choices = 0;
		mockPi.onCall({ steps: [{ jsonl: [events.assistantMessage("Reviewed")] }] });
		const result = await executor().execute("jev-workflow", {
			workflowScript: 'const child = await runs.run("review", { agent: "scout", task: "Review parser", async: false }); return child;',
			async: false,
		}, new AbortController().signal, undefined, context({ onChoice: () => { choices++; } }));
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(choices, 1);
		assert.equal(readCall().runtime?.agent, "worker");
	});
});

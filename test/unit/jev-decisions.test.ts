import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectJevCandidate, type JevRegistry } from "../../src/agents/jev-decisions.ts";
import { AGENCY_ROLES } from "../../src/agents/agency-roles.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const persona = AGENCY_ROLES[0]!.id;
const agents = [{ name: "worker", description: "Implementation", systemPrompt: "base", maxThinking: "high" }] as AgentConfig[];
const candidates = [
	{ id: "cheap", agent: "worker", persona, model: "mock/small", effort: "off" as const },
	{ id: "deep", agent: "worker", persona, model: "mock/large", effort: "high" as const },
];
const models = [
	{ provider: "mock", id: "small", fullId: "mock/small", reasoning: false },
	{ provider: "mock", id: "large", fullId: "mock/large", reasoning: true },
];
function registry(choice = "deep"): JevRegistry {
	return {
		getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-latest" }],
		classify: async () => ({ provider: "typesafe", model: "jev-latest", stopReason: "stop", answers: {
			candidate: { type: "choice", choice, confidence: 0.9, probabilities: { cheap: 0.1, deep: 0.9 } },
		} }),
	};
}
const input = () => ({ config: { candidates }, agents, models, task: "Fix parser", hint: "scout", signal: new AbortController().signal });

describe("Jev joint launch selection", () => {
	it("AC-1 agent-selection: Jev thay hint của main", async () => {
		const decision = await selectJevCandidate(registry(), input());
		assert.equal(decision.candidate.agent, "worker");
	});
	it("AC-2 joint-tuple: chỉ một Choice chọn model cùng effort", async () => {
		const backend = registry();
		backend.classify = async (_model, context) => {
			assert.deepEqual(Object.keys(context.questions), ["candidate"]);
			assert.match(context.questions.candidate!.criteria.deep!, /mock\/large/);
			assert.match(context.questions.candidate!.criteria.deep!, /high/);
			return registry().classify(_model, context, { signal: new AbortController().signal, maxRetries: 0 });
		};
		assert.deepEqual((await selectJevCandidate(backend, input())).candidate, candidates[1]);
	});
	it("AC-2 model-scope: loại tuple ngoài guardrail trước Choice", async () => {
		const backend = registry();
		backend.classify = async (_model, context) => {
			assert.deepEqual(Object.keys(context.questions.candidate!.criteria), ["deep"]);
			return { provider: "typesafe", model: "jev-latest", stopReason: "stop", answers: { candidate: { type: "choice", choice: "deep", confidence: 1, probabilities: { deep: 1 } } } };
		};
		await selectJevCandidate(backend, { ...input(), allowed: (candidate) => candidate.model === "mock/large" });
	});
	it("AC-3 effort-ceiling: loại effort không được model hỗ trợ hoặc vượt ceiling", async () => {
		const backend = registry();
		backend.classify = async (_model, context) => {
			assert.deepEqual(Object.keys(context.questions.candidate!.criteria), ["cheap", "deep"]);
			return registry().classify(_model, context, { signal: new AbortController().signal, maxRetries: 0 });
		};
		await selectJevCandidate(backend, { ...input(), config: { candidates: [...candidates,
			{ ...candidates[0]!, id: "unsupported", effort: "high" },
			{ ...candidates[1]!, id: "over-ceiling", effort: "xhigh" },
		] } });
	});
	it("AC-5 failure: không retry hoặc chat fallback", async () => {
		let calls = 0;
		const backend = registry();
		backend.classify = async () => { calls++; throw new Error("SECRET provider body"); };
		await assert.rejects(selectJevCandidate(backend, input()), /Jev request thất bại/);
		assert.equal(calls, 1);
	});
	it("AC-5 timeout: deadline chặn provider không tuân AbortSignal", async () => {
		const backend = registry();
		backend.classify = () => new Promise(() => {});
		await assert.rejects(selectJevCandidate(backend, { ...input(), config: { candidates, timeoutMs: 10 } }), /Jev timeout/);
	});
	it("AC-5 invalid-choice: từ chối tuple không nằm trong catalog", async () => {
		await assert.rejects(selectJevCandidate(registry("invented"), input()), /Jev response không hợp lệ/);
	});
	it("AC-5 invalid-choice: từ chối probability distribution sai", async () => {
		const backend = registry();
		backend.classify = async () => ({ provider: "typesafe", model: "jev-latest", stopReason: "stop", answers: {
			candidate: { type: "choice", choice: "deep", confidence: 0.9, probabilities: { cheap: 0.8, deep: 0.9 } },
		} });
		await assert.rejects(selectJevCandidate(backend, input()), /Jev response không hợp lệ/);
	});
	it("AC-6 audit: ghi digest thay raw task", async () => {
		const decision = await selectJevCandidate(registry(), input());
		assert.match(decision.taskDigest, /^[a-f0-9]{64}$/);
		assert.equal(JSON.stringify(decision).includes("Fix parser"), false);
		assert.equal(decision.backend, "typesafe/jev-latest");
	});
});

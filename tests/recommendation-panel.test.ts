// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mountGovernedRecommendationPanel } from "../src/lab/governed-recommendation-panel";
import type { ProductionRecommendationView } from "../src/recommendation/production";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const jobId = `job-${"a".repeat(64)}`;

function view(current = true): ProductionRecommendationView {
  const tiers = ["economy", "balanced", "long_term"] as const;
  const recommendations = tiers.map((tier, index) => ({
    recommendationId: `recommendation-${tier}`,
    tier,
    solution: {
      candidateId: `candidate-${index}`,
      promotionRecordId: `promotion-${index}`,
      scoringVersion: "recommendation-score-v1",
      objectiveScores: {
        workloadValue: 0.9 - index * 0.1,
        evidencedReliability: 1,
        maintainability: 0.8,
        usableExpandability: 0.7 + index * 0.1,
        replacementFriction: 0.8,
        marketAndLifecycleCost: 0.6,
      },
      rank: index + 1,
      explanationRef: `sha256:${String(index + 7).repeat(64)}`,
    },
    alternativeCandidateIds: tiers.filter((_, alternative) => alternative !== index).map((_, alternative) => `candidate-${alternative === 0 && index === 0 ? 1 : alternative}`),
    candidateConfigRef: `sha256:${String(index + 1).repeat(64)}`,
    requirementCoverageRef: `sha256:${String(index + 4).repeat(64)}`,
    inputHashes: {
      configHash: "1".repeat(64), requirementSpecHash: "2".repeat(64), factSnapshotHash: "3".repeat(64),
      userObservationSnapshotHash: "4".repeat(64), priceSnapshotHash: "5".repeat(64),
      ruleSetHash: "6".repeat(64), systemProfileHash: "7".repeat(64), adapterSnapshotHash: "8".repeat(64),
      engineHash: "9".repeat(64), simulationModelHash: "a".repeat(64), simulationInputHash: "b".repeat(64),
    },
    solverVersion: "solver-v1", scoringVersion: "recommendation-score-v1",
    searchCompleteness: "complete" as const, priceConfidence: "high" as const,
    optimalityClaim: "bounded_best" as const, totalCny: 8_000 + index * 1_000,
    plannedCny: 8_000 + index * 1_000, orderedCny: 0,
    explanationRef: `sha256:${String(index + 7).repeat(64)}`,
  }));
  const contexts = tiers.map((_, index) => ({
    candidate: { candidateId: `candidate-${index}` },
    eligibilityContext: {
      coverage: [
        { domain: "identity", verdict: "pass" },
        { domain: "thermal", verdict: "pass" },
      ],
    },
    score: {
      objectiveScores: recommendations[index]!.solution.objectiveScores,
      penalties: [{ kind: "abnormal_price_cycle", amount: 0.05, explanation: "本地历史样本显示当前周期偏高" }],
    },
  }));
  const explanations = tiers.map((_, index) => ({
    candidateId: `candidate-${index}`,
    priceStatement: index === 0 ? "<img src=x> 当前总价来自同规格样本" : "当前总价来自同规格样本",
    upgradeStatement: "保留主要平台部件，后续可按需扩展",
  }));
  return {
    schemaVersion: "production-recommendation-view-v1",
    setRef: `sha256:${"f".repeat(64)}`,
    current,
    staleCandidateIds: current ? [] : ["candidate-0"],
    set: {
      schemaVersion: "production-recommendation-set-v1",
      planId: "plan-a", solverJobId: jobId,
      solverRequestRef: `sha256:${"a".repeat(64)}`,
      solverResultRef: `sha256:${"b".repeat(64)}`,
      runtimeGeneration: 1, generatedAt: "2026-08-29T00:00:00.000Z",
      weights: {
        workloadValue: 0.3, evidencedReliability: 0.2, maintainability: 0.15,
        usableExpandability: 0.15, replacementFriction: 0.1, marketAndLifecycleCost: 0.1,
      },
      status: "ranked", recommendations, excluded: [], candidates: [], searchCompleteness: "complete",
    },
    contexts: contexts as never,
    explanations: explanations as never,
  };
}

describe("governed recommendation panel", () => {
  it("requests only the solver job id and renders three transparent recommendation tiers", async () => {
    const host = document.createElement("section");
    document.body.replaceChildren(host);
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(view()), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    const controller = mountGovernedRecommendationPanel(host, {
      enabled: true,
      getPlanId: () => "plan-a",
      subscribe: () => () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
      storage: new MemoryStorage(),
    });
    host.querySelector<HTMLInputElement>('input[name="solverJobId"]')!.value = jobId;
    host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-recommendation-tier]")).toHaveLength(3));
    expect(requests).toEqual([{ url: "/api/workspace/plans/plan-a/recommendations", body: { solverJobId: jobId } }]);
    expect(host.textContent).toContain("采购硬门槛");
    expect(host.textContent).toContain("独立惩罚");
    expect(host.textContent).toContain("备选");
    expect(host.textContent).toContain("当前总价来自同规格样本");
    expect(host.querySelector("img")).toBeNull();
    controller.dispose();
  });

  it("keeps the surface absent when the production capability is disabled", () => {
    const host = document.createElement("section");
    const fetchImpl = vi.fn();
    mountGovernedRecommendationPanel(host, {
      enabled: false, getPlanId: () => "plan-a", subscribe: () => () => undefined,
      fetchImpl: fetchImpl as typeof fetch, storage: new MemoryStorage(),
    });
    expect(host.hidden).toBe(true);
    expect(host.childElementCount).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

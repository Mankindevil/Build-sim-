import { describe, expect, it, vi } from "vitest";
import type { BuildConfig } from "../src/config/types";
import type { BuildEvaluation } from "../src/core/evaluate";
import { EvaluationCoordinator } from "../src/plans/evaluation";
import { createDefaultN6Config } from "../src/plans/default-plan";

function evaluation(config: BuildConfig, findingId = "finding"): BuildEvaluation {
  return { config, findings: [{ id: findingId, verdict: "warn" }], price: { knownCny: 100, unknownSkuIds: [] } } as unknown as BuildEvaluation;
}

describe("R4 evaluation coordinator", () => {
  it("deduplicates equal config hashes and binds the snapshot to plan revision", async () => {
    const evaluator = vi.fn((config: BuildConfig) => evaluation(config));
    const coordinator = new EvaluationCoordinator(evaluator, () => "2026-08-25T00:00:00.000Z");
    const config = createDefaultN6Config("plan-12345678", "2026-08-25T00:00:00.000Z");
    const first = await coordinator.evaluate({ planId: "plan-12345678", planVersionId: null, draftRevision: 2, config });
    const second = await coordinator.evaluate({ planId: "plan-12345678", planVersionId: "version-1", draftRevision: 3, config: structuredClone(config) });
    expect(evaluator).toHaveBeenCalledOnce();
    expect(first.snapshot.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.snapshot).toMatchObject({ planId: "plan-12345678", planVersionId: "version-1", draftRevision: 3, configHash: first.snapshot.configHash, evaluationHash: first.snapshot.evaluationHash });
  });

  it("marks a slow prior result stale after a newer config starts", async () => {
    const resolvers = new Map<number, (value: BuildEvaluation) => void>();
    const coordinator = new EvaluationCoordinator((config) => new Promise<BuildEvaluation>((resolve) => resolvers.set(config.selection.diskCount, resolve)));
    const slowConfig = createDefaultN6Config("plan-12345678", "2026-08-25T00:00:00.000Z");
    const fastConfig = structuredClone(slowConfig);
    fastConfig.selection.diskCount = 2;
    const slow = coordinator.evaluate({ planId: "plan-12345678", planVersionId: null, draftRevision: 1, config: slowConfig });
    const fast = coordinator.evaluate({ planId: "plan-12345678", planVersionId: null, draftRevision: 1, config: fastConfig });
    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    resolvers.get(2)!(evaluation(fastConfig, "new"));
    await expect(fast).resolves.toMatchObject({ latest: true });
    resolvers.get(1)!(evaluation(slowConfig, "old"));
    await expect(slow).resolves.toMatchObject({ latest: false });
  });
});


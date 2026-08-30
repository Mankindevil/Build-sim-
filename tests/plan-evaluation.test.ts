import { describe, expect, it, vi } from "vitest";
import type { BuildConfig } from "../src/config/types";
import type { BuildEvaluation } from "../src/core/evaluate";
import { EvaluationCoordinator } from "../src/plans/evaluation";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { configV3Hash } from "../src/topology/hash";
import { createPlanPartialEvaluationV3 } from "../src/plans/evaluation";
import { sha256Hex } from "../src/plans/canonical";
import { evaluateProgressiveCompatibility } from "../src/compatibility/engine";
import { progressiveInput } from "./helpers/progressive-evaluation-fixture";

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

  it("accepts a server-resolved V3 partial snapshot with domain-hash closure", async () => {
    const coordinator = new EvaluationCoordinator((config) => evaluation(config));
    const config = createEmptyBuildConfigV3("plan-v3-evaluation", "V3", "2026-08-27T00:00:00.000Z");
    const partial = createPlanPartialEvaluationV3(config);
    const result = await coordinator.acceptPlanResolved({
      planId: config.id,
      planVersionId: null,
      draftRevision: 4,
      config,
      evaluation: partial,
      expectedConfigHash: await configV3Hash(config),
      expectedEvaluationHash: await sha256Hex(partial),
    });
    expect(result).toMatchObject({ latest: true, snapshot: { draftRevision: 4, evaluation: { kind: "topology-v3-partial", unknownDomains: expect.arrayContaining(["price", "compatibility"]) } } });
    await expect(coordinator.acceptPlanResolved({
      planId: config.id,
      planVersionId: null,
      draftRevision: 5,
      config,
      evaluation: partial,
      expectedConfigHash: "0".repeat(64),
    })).rejects.toThrow(/config hash mismatch/);
  });

  it("accepts a server-resolved V3 progressive evaluation and binds its config authority", async () => {
    const coordinator = new EvaluationCoordinator((config) => evaluation(config));
    const config = createEmptyBuildConfigV3("plan-v3-progressive", "V3 progressive", "2026-08-28T00:00:00.000Z");
    const progressive = await evaluateProgressiveCompatibility(await progressiveInput(config));
    await expect(coordinator.acceptPlanResolved({
      planId: config.id,
      planVersionId: null,
      draftRevision: 5,
      config,
      evaluation: progressive,
      expectedConfigHash: await configV3Hash(config),
      expectedEvaluationHash: await sha256Hex(progressive),
    })).resolves.toMatchObject({
      latest: true,
      snapshot: { evaluation: { kind: "topology-v3-progressive", readiness: { powerReady: false } } },
    });

    const changed = { ...config, name: "Changed after evaluation" };
    await expect(coordinator.acceptPlanResolved({
      planId: changed.id,
      planVersionId: null,
      draftRevision: 6,
      config: changed,
      evaluation: progressive,
    })).rejects.toThrow(/does not match the active topology\/config authority/);

    const legacy = createDefaultN6Config("plan-v2-rollback", "2026-08-28T00:00:00.000Z");
    await expect(coordinator.acceptPlanResolved({
      planId: legacy.id,
      planVersionId: null,
      draftRevision: 1,
      config: legacy,
      evaluation: progressive,
    })).rejects.toThrow(/V2 cannot use a V3 topology evaluation/);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { SnapshotHashes } from "../src/hash";
import type { BuildConfig } from "../src/config/types";
import type { BuildEvaluation } from "../src/core/evaluate";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { assessEvaluationFreshness, EvaluationCoordinator } from "../src/plans/evaluation";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { hashPlanConfig } from "../src/plans/canonical";

const digest = (letter: string): string => letter.repeat(64);

function hashes(configHash: string): SnapshotHashes {
  return {
    configHash, requirementSpecHash: digest("b"), factSnapshotHash: digest("c"), userObservationSnapshotHash: digest("d"),
    priceSnapshotHash: digest("e"), ruleSetHash: digest("f"), systemProfileHash: digest("1"), adapterSnapshotHash: digest("2"),
    engineHash: digest("3"), simulationModelHash: digest("4"), simulationInputHash: digest("5"),
  };
}

function result(config: BuildConfig): BuildEvaluation {
  return { config, findings: [], price: { knownCny: 0, unknownSkuIds: [] } } as unknown as BuildEvaluation;
}

describe("U3 evaluation cache closure", () => {
  it("deduplicates one exact lock and misses when any snapshot/artifact input changes", async () => {
    const evaluator = vi.fn((config: BuildConfig) => result(config));
    const coordinator = new EvaluationCoordinator(evaluator);
    const config = createDefaultN6Config("plan-cache", "2026-08-28T00:00:00.000Z");
    const configHash = await hashPlanConfig(config);
    const baseHashes = hashes(configHash);
    const lock = await createPlanEvaluationLock({ planId: "plan-cache", snapshotHashes: baseHashes, factSnapshotId: "fact-snapshot", userObservationSnapshotId: "observation-snapshot", artifactLockfileHash: digest("6") });
    const first = await coordinator.evaluate({ planId: "plan-cache", planVersionId: null, draftRevision: 0, config, evaluationLock: lock });
    await coordinator.evaluate({ planId: "plan-cache", planVersionId: null, draftRevision: 0, config: structuredClone(config), evaluationLock: structuredClone(lock) });
    expect(evaluator).toHaveBeenCalledTimes(1);

    for (const field of Object.keys(baseHashes).filter((field) => field !== "configHash") as Array<keyof SnapshotHashes>) {
      const changed = { ...baseHashes, [field]: digest(field === "factSnapshotHash" ? "7" : "8") };
      const changedLock = await createPlanEvaluationLock({ planId: "plan-cache", snapshotHashes: changed, factSnapshotId: "fact-snapshot", userObservationSnapshotId: "observation-snapshot", artifactLockfileHash: digest("6") });
      await coordinator.evaluate({ planId: "plan-cache", planVersionId: null, draftRevision: 0, config, evaluationLock: changedLock });
    }
    const artifactChanged = await createPlanEvaluationLock({ planId: "plan-cache", snapshotHashes: baseHashes, factSnapshotId: "fact-snapshot", userObservationSnapshotId: "observation-snapshot", artifactLockfileHash: digest("9") });
    await coordinator.evaluate({ planId: "plan-cache", planVersionId: null, draftRevision: 0, config, evaluationLock: artifactChanged });
    expect(evaluator).toHaveBeenCalledTimes(12);
    await expect(assessEvaluationFreshness(first.snapshot, lock)).resolves.toEqual({ status: "current", reason: "lock_matches" });
    await expect(assessEvaluationFreshness(first.snapshot, artifactChanged)).resolves.toEqual({ status: "stale", reason: "snapshot_inputs_changed" });
    const legacy = structuredClone(first.snapshot);
    delete legacy.evaluationLock;
    await expect(assessEvaluationFreshness(legacy, lock)).resolves.toEqual({ status: "legacy_unlocked", reason: "snapshot_has_no_evaluation_lock" });
  });

  it("rejects a lock whose config hash does not match the evaluated config", async () => {
    const coordinator = new EvaluationCoordinator((config) => result(config));
    const config = createDefaultN6Config("plan-cache", "2026-08-28T00:00:00.000Z");
    const lock = await createPlanEvaluationLock({ planId: "plan-cache", snapshotHashes: hashes(digest("0")), factSnapshotId: "fact", userObservationSnapshotId: "obs", artifactLockfileHash: digest("6") });
    await expect(coordinator.evaluate({ planId: "plan-cache", planVersionId: null, draftRevision: 0, config, evaluationLock: lock })).rejects.toThrow(/does not match plan\/config/);
  });
});

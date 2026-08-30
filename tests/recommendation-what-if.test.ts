import { describe, expect, it } from "vitest";
import { compareRecommendationWhatIf, type RecommendationWhatIfSide } from "../src/recommendation/what-if";
import type { SnapshotHashes } from "../src/hash";

const hash = (character: string) => character.repeat(64);
const snapshots: SnapshotHashes = {
  configHash: hash("a"), requirementSpecHash: hash("b"), factSnapshotHash: hash("c"), userObservationSnapshotHash: hash("d"),
  priceSnapshotHash: hash("e"), ruleSetHash: hash("f"), systemProfileHash: hash("1"), adapterSnapshotHash: hash("2"),
  engineHash: hash("3"), simulationModelHash: hash("4"), simulationInputHash: hash("5"),
};

function side(overrides: Partial<RecommendationWhatIfSide> = {}): RecommendationWhatIfSide {
  return {
    evaluationHash: hash("6"), snapshotHashes: snapshots, knownTotalCny: 8_000, priceComplete: true,
    domainVerdicts: { mechanical: "pass", routing: "pass", thermal: "pass", acoustic: "pass", storage: "pass" },
    peakTemperatureC: { lo: 65, hi: 75 }, acousticTotalDba: { lo: 30, hi: 34 }, upgradePathRefs: ["upgrade:gpu"],
    ...overrides,
  };
}

describe("U10 recommendation what-if", () => {
  it("separates user changes and reports cost, compatibility, thermal/acoustic, spatial, wiring and upgrade sensitivity", async () => {
    const result = await compareRecommendationWhatIf(side(), side({
      evaluationHash: hash("7"),
      snapshotHashes: { ...snapshots, configHash: hash("8"), simulationInputHash: hash("9") },
      knownTotalCny: 8_500,
      domainVerdicts: { mechanical: "blocked", routing: "blocked", thermal: "pass", acoustic: "pass", storage: "fail" },
      peakTemperatureC: { lo: 68, hi: 80 }, acousticTotalDba: { lo: 33, hi: 37 }, upgradePathRefs: ["upgrade:storage"],
    }));
    expect(result.snapshotAttribution).toBe("same_governed_snapshots");
    expect(result.userInputChanges).toEqual(["configHash", "simulationInputHash"]);
    expect(result.marketRefreshChanges).toEqual([]);
    expect(result.cost.deltaKnownCny).toBe(500);
    expect(result.thermal.midpointDeltaC).toBe(4);
    expect(result.acoustic.midpointDeltaDba).toBe(3);
    expect(Object.fromEntries(result.sensitivity.map(({ dimension, changed }) => [dimension, changed]))).toMatchObject({ compatibility: true, spatial: true, wiring: true, upgrade_path: true });
  });

  it("requires explicit market-refresh attribution and never permits model snapshot drift", async () => {
    const refreshed = side({ evaluationHash: hash("7"), snapshotHashes: { ...snapshots, priceSnapshotHash: hash("8") } });
    await expect(compareRecommendationWhatIf(side(), refreshed)).rejects.toThrow(/explicit attribution/);
    const attributed = await compareRecommendationWhatIf(side(), refreshed, { allowMarketRefresh: true });
    expect(attributed.snapshotAttribution).toBe("market_refreshed");
    expect(attributed.marketRefreshChanges).toEqual(["priceSnapshotHash"]);
    await expect(compareRecommendationWhatIf(side(), side({ snapshotHashes: { ...snapshots, engineHash: hash("9") } }), { allowMarketRefresh: true })).rejects.toThrow(/governed snapshots changed/);
  });
});

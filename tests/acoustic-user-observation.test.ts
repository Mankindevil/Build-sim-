import { describe, expect, it } from "vitest";
import { acousticObservationSources, type AcousticCalibrationObservation } from "../src/acoustics/calibration";
import { aggregateAcousticSources } from "../src/acoustics/aggregate";

function observation(overrides: Partial<AcousticCalibrationObservation> = {}): AcousticCalibrationObservation {
  return {
    observationId: "obs-noise", planId: "plan-a", componentInstanceId: "fan-1", loadId: "balanced",
    rpm: { lo: 900, hi: 1100 }, soundPressureDba: 36, uncertaintyPlusMinusDba: 1,
    weighting: "A", referenceDistanceM: 0.5, testMethodId: "bounded-free-field",
    observedAt: "2026-08-29T10:00:00.000Z", status: "active", ...overrides,
  };
}

describe("U9 plan-scoped acoustic observations", () => {
  it("normalizes a matching measurement but rejects different plan/load/method conditions", () => {
    const projected = acousticObservationSources({
      planId: "plan-a", loadId: "balanced", testMethodId: "bounded-free-field",
      observations: [
        observation(),
        observation({ observationId: "other-plan", planId: "plan-b" }),
        observation({ observationId: "other-load", loadId: "idle" }),
        observation({ observationId: "other-method", testMethodId: "room-phone" }),
      ],
    });
    expect(projected.sources).toHaveLength(1);
    expect(projected.sources[0]!.soundPressureDbaAt1M.lo).toBeCloseTo(28.9794, 3);
    expect(projected.sources[0]!.soundPressureDbaAt1M.hi).toBeCloseTo(30.9794, 3);
    expect(projected.rejectedObservationIds).toEqual(["other-load", "other-method", "other-plan"]);
    expect(aggregateAcousticSources({ sources: projected.sources, loadId: "balanced", testMethodId: "bounded-free-field" }).totalDba)
      .toEqual(projected.sources[0]!.soundPressureDbaAt1M);
  });

  it("does not retain a retracted plan measurement as a reusable sound fact", () => {
    const projected = acousticObservationSources({
      planId: "plan-a", loadId: "balanced", testMethodId: "bounded-free-field",
      observations: [observation({ status: "retracted" })],
    });
    expect(projected.sources).toEqual([]);
    expect(projected.rejectedObservationIds).toEqual(["obs-noise"]);
    expect(aggregateAcousticSources({ sources: [], loadId: "balanced", testMethodId: "bounded-free-field" }))
      .toMatchObject({ totalDba: null, verdict: "blocked", level: "unknown" });
  });
});

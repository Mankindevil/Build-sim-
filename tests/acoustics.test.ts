import { describe, expect, it } from "vitest";
import { aggregateAcousticSources } from "../src/acoustics/aggregate";
import { normalizeAcousticSource, normalizeSoundPressureDistance } from "../src/acoustics/normalize";
import { acousticSourceAtOperatingPoint } from "../src/acoustics/operating-point";

function source(sourceId: string, dba = 30, overrides: Partial<Parameters<typeof normalizeAcousticSource>[0]> = {}) {
  return normalizeAcousticSource({
    sourceId, componentInstanceId: sourceId, soundPressureDba: { lo: dba, hi: dba }, weighting: "A",
    referenceDistanceM: 1, loadId: "balanced", rpm: { lo: 1000, hi: 1000 }, testMethodId: "iso-fixture",
    sourceRefs: [`fact:${sourceId}`], evidence: "official", ...overrides,
  });
}

describe("U9 normalized hardware acoustics", () => {
  it("energetically aggregates two independent 30 dBA sources to about 33.01 dBA", () => {
    const result = aggregateAcousticSources({ sources: [source("fan-a"), source("fan-b")], loadId: "balanced", testMethodId: "iso-fixture" });
    expect(result.totalDba?.lo).toBeCloseTo(33.0103, 3);
    expect(result.totalDba?.hi).toBeCloseTo(33.0103, 3);
    expect(result.contributions.map(({ shareOfUpperEnergy }) => shareOfUpperEnergy)).toEqual([0.5, 0.5]);
    expect(result.displayNotice).toContain("不代表房间");
  });

  it("normalizes reference distance and refuses to sum unlike load/method conditions", () => {
    expect(normalizeSoundPressureDistance({ lo: 36, hi: 36 }, 0.5, 1).lo).toBeCloseTo(29.9794, 3);
    const unlikeLoad = source("other-load", 28, { loadId: "idle" });
    const unlikeMethod = source("other-method", 29, { testMethodId: "open-bench" });
    const result = aggregateAcousticSources({ sources: [source("fan"), unlikeLoad, unlikeMethod], loadId: "balanced", testMethodId: "iso-fixture" });
    expect(result.totalDba?.lo).toBe(30);
    expect(result.excludedSourceIds).toEqual(["other-load", "other-method"]);
  });

  it("interpolates a governed RPM curve and keeps coil-whine risk outside the deterministic sum", () => {
    const operating = acousticSourceAtOperatingPoint({
      curveId: "curve.fan", componentInstanceId: "fan-1", weighting: "A", referenceDistanceM: 1,
      loadId: "balanced", testMethodId: "iso-fixture", sourceRefs: ["fact:fan.curve"], evidence: "official",
      points: [
        { rpm: 500, soundPressureDba: { lo: 18, hi: 20 } },
        { rpm: 1500, soundPressureDba: { lo: 32, hi: 35 } },
      ],
    }, { lo: 900, hi: 1100 });
    const result = aggregateAcousticSources({
      sources: [operating], loadId: "balanced", testMethodId: "iso-fixture",
      coilWhineRisks: [{ componentInstanceId: "gpu-1", risk: "reported", sourceRefs: ["claim:review"], note: "sample-dependent report" }],
    });
    expect(result.totalDba).toEqual(operating.soundPressureDbaAt1M);
    expect(result.coilWhineRisks).toHaveLength(1);
  });
});

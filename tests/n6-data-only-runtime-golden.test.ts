import { describe, expect, it } from "vitest";
import adapterSeed from "../data/cases/jonsbo-n6/adapter.json";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import {
  CaseRuntimeAdapterRegistry,
  compileLockedCaseAdapterRuntime,
  createBundledCaseRuntimeModels,
  materializeCaseAdapterFixtureSeed,
  type CaseAdapterSeed,
} from "../src/adapters";
import { evaluateBuild, type ThermalEnv } from "../src/core/evaluate";
import type { BuildConfig } from "../src/config/types";
import { loadRawCatalog } from "../src/sku/catalog";

async function dataOnlyRuntime() {
  const { manifest } = await materializeCaseAdapterFixtureSeed(adapterSeed as unknown as CaseAdapterSeed);
  const [model] = await createBundledCaseRuntimeModels([manifest]);
  if (!model) throw new Error("bundled N6 data-only runtime model is unavailable");
  return compileLockedCaseAdapterRuntime(manifest, model);
}

describe("N6 flag-on data-only runtime golden", () => {
  it("replays geometry, wiring, routing, assembly and thermal without importing a per-case implementation", async () => {
    const adapter = await dataOnlyRuntime();
    const registry = CaseRuntimeAdapterRegistry.create([adapter]);
    const config = structuredClone(baseline) as BuildConfig;
    config.selection.fanGroups = [
      { mountId: "front", sizeMm: 140, count: 2 },
      { mountId: "rear", sizeMm: 120, count: 1 },
      { mountId: "left", sizeMm: 120, count: 2 },
    ];
    const thermalEnv: ThermalEnv = {
      ambientC: 25,
      fanMode: "balanced",
      fans: {},
      upperWatts: 90,
      psuDcWatts: 150,
      workload: "idle",
    };
    const evaluation = evaluateBuild(config, loadRawCatalog(), thermalEnv, {
      registry,
      caseIdentity: adapter.identity,
    });

    expect(evaluation.caseRuntime).toMatchObject({
      status: "ready",
      safetyStatus: "unknown",
      authorityStatus: "legacy_unverified",
      domains: {
        geometry: { status: "ready" }, wiring: { status: "ready" }, routing: { status: "ready" },
        assembly: { status: "ready" }, thermal: { status: "ready" },
      },
    });
    expect(evaluation.geometry.find((part) => part.id === "board")?.box).toEqual({ c: [0, -9, 20], w: 244, h: 3, d: 244 });
    expect(evaluation.geometry.find((part) => part.id === "chassis.deck")?.box.c[1]).toBe(-23);
    expect(evaluation.geometry.filter((part) => part.thermalId === "hdd")).toHaveLength(1);
    expect(evaluation.geometry.filter((part) => part.id.startsWith("fan.drive"))).toHaveLength(2);

    expect(evaluation.wiring.bayPaths).toHaveLength(9);
    expect(evaluation.wiring.bayPaths[0]).toMatchObject({ bayIndex: 1, target: "sata" });
    expect(evaluation.wiring.bayPaths[8]).toMatchObject({ bayIndex: 9, target: "sata" });
    expect(evaluation.wiring.backplanePower).toHaveLength(4);
    // A legacy replay may preserve a conservative failure; only passes are downgraded.
    expect(evaluation.wiring.backplaneHarness.verdict).toBe("bad");

    const portIds = new Set(evaluation.routing.ports.map((port) => port.id));
    for (let index = 1; index <= 9; index += 1) expect(portIds).toContain(`port.backplane.data.${index}`);
    for (let index = 1; index <= 4; index += 1) expect(portIds).toContain(`port.backplane.power.${index}`);
    expect(evaluation.routing.cables.length).toBeGreaterThan(5);
    expect(evaluation.routing.cables.filter((cable) => cable.id.startsWith("run.backplane.power."))).toHaveLength(4);

    const stepIndex = (id: string) => evaluation.assembly.steps.findIndex((step) => step.id === id);
    expect(stepIndex("part:board")).toBeGreaterThanOrEqual(0);
    expect(stepIndex("part:board")).toBeLessThan(stepIndex("part:cpu"));
    expect(stepIndex("part:cpu")).toBeLessThan(stepIndex("part:cooler.base"));
    expect(evaluation.assembly.steps.filter((step) => step.deadlocked)).toEqual([]);

    expect(evaluation.thermal?.chambers.lower.fanned).toBe(true);
    expect(evaluation.thermal?.chambers.lower.loadW.lo).toBeCloseTo(10.3, 6);
    expect(evaluation.thermal?.evidence).toBe("unknown");
    expect(evaluation.occupancy.verdict).not.toBe("ok");
    expect(evaluation.findings.some((finding) => finding.id === "case-runtime.authority:legacy-unverified")).toBe(true);
    expect(evaluation.findings.some((finding) => finding.verdict === "ok")).toBe(false);
  });
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundledCatalog } from "../src/sku/catalog";
import { evaluateBuild } from "../src/core/evaluate";
import { evaluatePhysicalConstraints, obbProjectedExtents, type PhysicalEvaluation } from "../src/core/physical";
import { narrowPlanningRange } from "../src/core/calibration";
import { exportChecklist, parseConfig } from "../src/config/io";
import { buildAdviceInput, validateAdviceInput } from "../src/advice/validate";
import type { BuildConfig } from "../src/config/types";
import { N6_INTERIOR_BOX } from "../src/adapters/jonsbo-n6/geometry";
import { N6_CASE_RUNTIME_ADAPTER } from "../src/adapters/jonsbo-n6/assembly";

const catalog = loadBundledCatalog();
const fixtureDir = path.resolve("tests/fixtures/upgrade-scenarios");

const baseConfig: BuildConfig = {
  schemaVersion: "2.0.0", id: "g7-base", name: "G7 base", updatedAt: "2026-08-23", caseId: "case.jonsbo-n6", boardId: "board.asus-w680m-ace-se", cpuId: "cpu.i5-14500",
  selection: { psuId: "psu.seasonic-focus-gx-850-v5", psuTopology: "auto", coolerId: "cooler.thermalright-axp90-x53-full", gpuId: "gpu.none", memoryId: "memory.kingston-ksm48e40bd8km-32hm-x2", diskCount: 1, diskSkuId: "storage.seagate-exos-x24-24tb", boot: "bay", hbaMode: "auto" }, bom: [],
};

async function config(name: string): Promise<BuildConfig> {
  const raw = JSON.parse(await readFile(path.join(fixtureDir, name), "utf8")) as { extends?: string; id?: string; updatedAt?: string; selection?: Partial<BuildConfig["selection"]> };
  if (raw.extends || !raw.updatedAt) {
    const selection = { ...baseConfig.selection, ...raw.selection };
    for (const field of ["psuId", "coolerId", "gpuId", "memoryId", "diskSkuId"] as const) {
      if (!catalog.skus.some((sku) => sku.id === selection[field])) selection[field] = String(baseConfig.selection[field]);
    }
    if (selection.gpuId === "gpu.nvidia-rtx-a4000") selection.gpuId = "gpu.rtx-a4000-16gb";
    return { ...baseConfig, id: raw.id ?? baseConfig.id, selection };
  }
  return parseConfig(JSON.stringify(raw));
}

describe("G7 physical expansion, calibration and cross-layer facts", () => {
  it("keeps physical hashes stable across non-physical plan metadata updates", () => {
    const before = evaluateBuild(baseConfig, catalog).physical.hash;
    const after = evaluateBuild({ ...baseConfig, id: "another-plan", name: "Renamed", updatedAt: "2030-01-01T00:00:00.000Z", notes: ["non-physical note"] }, catalog).physical.hash;
    expect(after).toBe(before);
  });

  it.each(["baseline.json", "dual-psu.json", "front-240-radiator.json", "nine-hdd-hba.json"])("keeps %s on one physical evaluation", async (name) => {
    const evaluation = evaluateBuild(await config(name), catalog);
    expect(evaluation.physical.rulesetVersion).toBe("physical-rules-1.0.0");
    expect(evaluation.physical.hash).toMatch(/^fnv1a-/);
    expect(evaluation.physical.provenance).toContain("BuildEvaluation.wiring");
    expect(evaluation.calibration.snapshot.calibrationVersion).toBe("n6-calibration-1.0.0");
    expect(evaluation.findings).toEqual(expect.arrayContaining(evaluation.physical.findings));
    expect(exportChecklist(evaluation.config, evaluation.bom, evaluation)).toContain(evaluation.calibration.hash);
    expect(exportChecklist(evaluation.config, evaluation.bom, evaluation)).toContain("Physical provenance:");
  });

  it("projects a rotated GPU OBB and preserves a physical warning when it leaves the case", () => {
    const base = evaluateBuild({ ...baseConfig, id: "g7-gpu", name: "G7 GPU", selection: { ...baseConfig.selection, gpuId: "gpu.rtx-a4000-16gb", boot: "m2" } }, catalog);
    const gpu = base.geometry.find((part) => part.kind === "gpu")!;
    const rotated = evaluatePhysicalConstraints(base.config, catalog, [{ ...gpu, box: { ...gpu.box, c: [150, gpu.box.c[1], 170] } }], base.routing, base.wiring, { gpuRotationDeg: 45, interiorBox: N6_INTERIOR_BOX });
    expect(rotated.gpu?.angleDeg).toBe(45);
    expect(obbProjectedExtents(rotated.gpu!.obb).widthMm).toBeGreaterThan(gpu.box.w);
    expect(rotated.findings.some((finding) => finding.id === "physical.gpu-obb-case")).toBe(true);
  });

  it("records plug sweeps, bend radius and lane/service-space facts", async () => {
    const evaluation = evaluateBuild(await config("nine-hdd-hba.json"), catalog);
    expect(evaluation.physical.plugSweeps.length).toBeGreaterThan(0);
    expect(evaluation.physical.bendRadius.length).toBe(evaluation.routing.cables.length);
    expect(evaluation.physical.lane.nvmeCount).toBe(evaluation.config.selection.nvmeCount ?? 0);
    expect(evaluation.physical.serviceSpace.evidence).toBe("inferred");
  });

  it.each([
    ["9 HDD", { diskCount: 9 }],
    ["NVMe over M.2", { nvmeCount: 3, boot: "m2" as const }],
    ["dual PSU", { psuTopology: "dual" as const, secondaryPsuId: "psu.silverstone-sx750-g", dualStart: "sync" as const }],
  ])("parameterizes %s through the same BuildEvaluation", (_label, selection) => {
    const evaluation = evaluateBuild({ ...baseConfig, id: `g7-${_label.replace(/\W+/g, "-")}`, name: `G7 ${_label}`, selection: { ...baseConfig.selection, ...selection } }, catalog);
    expect(evaluation.physical.hash).toMatch(/^fnv1a-/);
    expect(evaluation.physical.lane.nvmeCount).toBe(evaluation.config.selection.nvmeCount ?? 0);
    expect(evaluation.findings).toEqual(expect.arrayContaining(evaluation.physical.findings));
  });

  it("keeps fan count, missing fields, official conflict and advice provenance explicit", async () => {
    const thermalEnv = { ambientC: 25, fanMode: "balanced" as const, fans: {}, upperWatts: 120, psuDcWatts: 80 };
    const noFan = evaluateBuild({ ...baseConfig, selection: { ...baseConfig.selection, fanMode: "balanced", fanGroups: [] } }, catalog, thermalEnv);
    const twoFans = evaluateBuild({ ...baseConfig, selection: { ...baseConfig.selection, fanMode: "balanced", fanGroups: [{ mountId: "front", sizeMm: 120, count: 2 }] } }, catalog, thermalEnv);
    expect(noFan.thermal?.chambers.upper.fanned).toBe(false);
    expect(twoFans.thermal?.chambers.upper.fanned).toBe(true);
    const missing = JSON.parse(await readFile(path.join(fixtureDir, "missing-fields.json"), "utf8")) as { fields?: Record<string, unknown> };
    expect(missing.fields?.lengthMm).toBe("unknown");
    const adviceInput = buildAdviceInput({ requestId: "g7-cross-layer", buildConfig: baseConfig, evaluation: twoFans, selectedSkuFacts: twoFans.bom.map((line) => {
      const sku = catalog.skus.find((item) => item.id === line.skuId)!;
      return { skuId: sku.id, name: sku.name, fields: sku.attrs ?? {}, provenance: [] };
    }) });
    expect(validateAdviceInput(adviceInput)).toEqual([]);
    expect(adviceInput.evaluation.physical.hash).toBe(twoFans.physical.hash);
    expect(adviceInput.evaluation.calibration.hash).toBe(twoFans.calibration.hash);
  });

  it("keeps calibration unknown and only narrows a planning range with measured evidence", () => {
    const calibration = N6_CASE_RUNTIME_ADAPTER.evaluateCalibration(baseConfig);
    expect(calibration.unknown).toEqual(expect.arrayContaining(["wallPowerW", "smartTemperatureC", "fanCurve"]));
    const planning = { lo: 20, hi: 80 };
    expect(narrowPlanningRange("cpu", planning, { min: 35, max: 55, evidence: "manual", unit: "°C" })).toEqual({ lo: 35, hi: 55 });
    expect(narrowPlanningRange("cpu", planning, { value: 120, evidence: "manual", unit: "°C" })).toEqual(planning);
    expect(narrowPlanningRange("cpu", planning, { min: 35, max: 55, evidence: "unknown", unit: "°C" })).toEqual(planning);
  });

  it("keeps imported legacy configs explicitly migrated and unknown", async () => {
    const legacy = parseConfig(JSON.stringify({ schemaVersion: "1.0.0", id: "legacy", name: "Legacy", updatedAt: "2026-08-23", caseId: "case.jonsbo-n6", boardId: "board.asus-w680m-ace-se", cpuId: "cpu.i5-14500", psuId: "psu.seasonic-focus-gx-850-v5", coolerId: "cooler.thermalright-axp90-x53-full", gpuId: "gpu.none", memoryId: "memory.kingston-ddr5-32gb", diskCount: 1, boot: "bay", hbaMode: "auto", bom: [] }));
    expect(legacy.schemaVersion).toBe("2.0.0");
    expect(legacy.migration?.fromSchemaVersion).toBe("1.0.0");
    expect(legacy.selection.diskCount).toBe(1);
  });
});

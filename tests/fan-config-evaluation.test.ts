import { describe, expect, it } from "vitest";
import { parseConfig, serializeConfig } from "../src/config/types";
import { validateConfig } from "../src/config/validate";
import { configuredFanGroups, derivePower, evaluateBuild } from "../src/core/evaluate";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { deriveBuildTasks } from "../src/plans/build-tasks";
import { sha256Hex } from "../src/plans/canonical";
import { evaluateBuildAuthoritatively } from "../src/server/evaluation-service";
import { loadBundledCatalog } from "../src/sku/catalog";

describe("case-aware persisted fan configuration", () => {
  it("round-trips and produces the same local and authoritative fan facts", async () => {
    const catalog = loadBundledCatalog();
    const config = createDefaultN6Config("plan-fans", "2026-08-27T00:00:00.000Z");
    config.selection.fanMode = "quiet";
    config.selection.fanGroups = [
      { mountId: "front", sizeMm: 140, count: 1 },
      { mountId: "left", sizeMm: 120, count: 1 },
      { mountId: "right", sizeMm: 120, count: 2 },
    ];
    const parsed = parseConfig(serializeConfig(config));
    expect(parsed.selection.fanGroups).toEqual(config.selection.fanGroups);
    const local = evaluateBuild(parsed, catalog);
    const authoritative = evaluateBuildAuthoritatively(parsed, catalog).evaluation;
    expect(authoritative.power.fanW).toBe(local.power.fanW);
    expect(authoritative.geometry.filter((part) => part.kind === "fan").map((part) => part.id)).toEqual(
      local.geometry.filter((part) => part.kind === "fan").map((part) => part.id),
    );
    const withoutFans = structuredClone(config);
    withoutFans.selection.fanGroups = [];
    expect(await sha256Hex(withoutFans)).not.toBe(await sha256Hex(config));
    expect(evaluateBuild(withoutFans, catalog).power.fanW).toBeLessThan(local.power.fanW ?? Infinity);
  });

  it("keeps generic case fans out of the SKU BOM while exposing the unresolved purchase", () => {
    const catalog = loadBundledCatalog();
    const config = createDefaultN6Config("plan-fan-procurement", "2026-08-27T00:00:00.000Z");
    config.selection.fanGroups = [{ mountId: "front", sizeMm: 140, count: 2 }];
    const evaluation = evaluateBuild(config, catalog);

    expect(evaluation.price).toMatchObject({
      complete: false,
      unresolvedRequirements: [{
        id: "case-fan:front:140mm:2",
        category: "case-fan",
        mountId: "front",
        mountLabel: "前部进风",
        sizeMm: 140,
        qty: 2,
        skuId: null,
        unitPriceCny: null,
        reason: "concrete-sku-not-reviewed",
        unknownFields: ["skuId", "unitPriceCny", "noiseDba", "airflowCfm"],
      }],
    });
    expect(evaluation.bom.some((line) => line.skuId.includes("case-fan"))).toBe(false);
    expect(evaluation.findings).toContainEqual(expect.objectContaining({
      id: "procurement.unresolved:case-fan:front:140mm:2",
      verdict: "warn",
      evidence: "unknown",
      message: expect.stringContaining("不能视为预算或采购已完成"),
    }));

    const tasks = deriveBuildTasks({ planId: config.id, sourceVersionId: "version-1", evaluation });
    expect(tasks).toContainEqual(expect.objectContaining({
      sourceRef: "purchase:requirement:case-fan:front:140mm:2",
      kind: "purchase",
      status: "blocked",
      title: expect.stringContaining("140mm 风扇具体 SKU（2 个）"),
      staleReason: expect.stringContaining("具体产品的实际风量均未知"),
    }));
  });

  it("keeps unsupported cases partial instead of borrowing N6 mount geometry", () => {
    const catalog = loadBundledCatalog();
    const otherCase = structuredClone(catalog.skus.find((sku) => sku.category === "case")!);
    otherCase.id = "case.fixture-unknown";
    otherCase.name = "Fixture case without adapter";
    catalog.skus.push(otherCase);
    const config = createDefaultN6Config("plan-other-case", "2026-08-27T00:00:00.000Z");
    config.caseId = otherCase.id;
    config.selection.fanGroups = [];
    const evaluation = evaluateBuild(config, catalog);
    expect(evaluation.readiness).toMatchObject({ status: "incomplete", missing: expect.arrayContaining(["case.adapter"]) });
    expect(evaluation.geometry).toEqual([]);
    expect(evaluation.wiring.bayPaths).toEqual([]);
  });

  it("reports topology conflicts without silently deleting a requested mount", () => {
    const catalog = loadBundledCatalog();
    const config = createDefaultN6Config("plan-conflict", "2026-08-27T00:00:00.000Z");
    config.selection.psuTopology = "bottom";
    config.selection.psuId = "psu.corsair-sf750-atx31";
    config.selection.fanGroups = [{ mountId: "left", sizeMm: 120, count: 2 }];
    expect(validateConfig(config, catalog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "selection.fanGroups", verdict: "bad", message: expect.stringContaining("拆除左侧风扇架") }),
    ]));
    const evaluation = evaluateBuild(config, catalog);
    expect(evaluation.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining("fan.config"), verdict: "bad" }),
    ]));
    expect(evaluation.power.fanW).toBe(5);
    expect(evaluation.geometry.filter((part) => part.kind === "fan")).toHaveLength(0);
    expect(evaluation.price.unresolvedRequirements).toEqual([]);
    expect(evaluation.findings.some((finding) => finding.id.startsWith("procurement.unresolved:"))).toBe(false);
    expect(deriveBuildTasks({ planId: config.id, sourceVersionId: "version-conflict", evaluation }).some((task) => task.sourceRef.startsWith("purchase:requirement:case-fan:"))).toBe(false);
    expect(config.selection.fanGroups).toEqual([{ mountId: "left", sizeMm: 120, count: 2 }]);

    const overCapacity = createDefaultN6Config("plan-over-capacity", "2026-08-27T00:00:00.000Z");
    overCapacity.selection.fanGroups = [{ mountId: "front", sizeMm: 140, count: 3 }];
    const invalidEvaluation = evaluateBuild(overCapacity, catalog);
    expect(invalidEvaluation.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining("fan.config"), verdict: "bad" }),
    ]));
    expect(invalidEvaluation.price.unresolvedRequirements).toEqual([]);
    expect(deriveBuildTasks({ planId: overCapacity.id, sourceVersionId: "version-invalid", evaluation: invalidEvaluation }).some((task) => task.sourceRef.startsWith("purchase:requirement:case-fan:"))).toBe(false);
  });

  it("puts left-mount fan motor heat in the lower chamber", () => {
    const catalog = loadBundledCatalog();
    const config = createDefaultN6Config("plan-left-heat", "2026-08-27T00:00:00.000Z");
    config.selection.fanGroups = [{ mountId: "left", sizeMm: 120, count: 1 }];
    const fans = configuredFanGroups(config, catalog);
    const power = derivePower(config, catalog, { workload: "idle", fans });
    const withLeft = evaluateBuild(config, catalog, { ambientC: 25, fanMode: "balanced", fans, workload: "idle", upperWatts: power.upperDcW!, psuDcWatts: 0, power, loads: power.loads });
    const without = structuredClone(config);
    without.selection.fanGroups = [];
    const powerWithout = derivePower(without, catalog, { workload: "idle", fans: configuredFanGroups(without, catalog) });
    const withoutLeft = evaluateBuild(without, catalog, { ambientC: 25, fanMode: "balanced", fans: {}, workload: "idle", upperWatts: powerWithout.upperDcW!, psuDcWatts: 0, power: powerWithout, loads: powerWithout.loads });
    expect(power).toMatchObject({ fanW: 7, upperFanW: 5, lowerFanW: 2 });
    expect((withLeft.thermal?.chambers.lower.loadW.lo ?? 0) - (withoutLeft.thermal?.chambers.lower.loadW.lo ?? 0)).toBeCloseTo(2, 6);
  });

  it("counts reviewed AIO radiator fans without requiring a duplicate case-fan selection", () => {
    const catalog = loadBundledCatalog();
    const config = createDefaultN6Config("plan-aio", "2026-08-27T00:00:00.000Z");
    config.selection.coolerId = "cooler.aio-240-front";
    config.selection.fanGroups = [];
    const evaluation = evaluateBuild(config, catalog);
    expect(evaluation.geometry.filter((part) => part.id.startsWith("fan.radiator."))).toHaveLength(2);
    expect(evaluation.power.fanW).toBe(9);
    expect(evaluation.price.unresolvedRequirements).toEqual([]);

    config.selection.coolerId = "cooler.aio-120-experimental";
    const rear = evaluateBuild(config, catalog);
    expect(rear.geometry.filter((part) => part.id.startsWith("fan.radiator."))).toHaveLength(1);
    expect(rear.power.fanW).toBe(7);
    expect(rear.price.unresolvedRequirements).toEqual([]);
  });
});

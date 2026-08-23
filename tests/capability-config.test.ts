import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/types";
import { validateConfig } from "../src/config/validate";
import { n6CaseCapabilities, n6PowerProfile, boardCapabilities } from "../src/core/capabilities";
import { derivePower, evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog, loadRawCatalog } from "../src/sku/catalog";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import type { BuildConfig } from "../src/config/types";
import type { SkuCatalog } from "../src/sku/types";

const rawCatalog = loadRawCatalog();
const catalog = loadBundledCatalog();

describe("G2 capability and configuration facts", () => {
  it("exposes case and board capabilities from the profile/catalog", () => {
    const n6 = n6CaseCapabilities();
    const board = boardCapabilities(catalog, "board.asus-w680m-ace-se");
    expect(n6.trayCount).toBe(9);
    expect(n6.backplane.sataPowerInlets + n6.backplane.molexInlets).toBe(4);
    expect(n6.fanMounts.front.size).toBe(140);
    expect(board.nativeSataPorts).toBe(4);
    expect(board.slimsasSataPorts).toBe(4);
    expect(board.pcie.chipsetX4Slots).toBe(1);
  });

  it("keeps profile power facts centralized and typed", () => {
    const profile = n6PowerProfile();
    expect(profile.boardBaseW).toBe(23);
    expect(profile.driveSpinUpExtraW).toBe(31.2);
    expect(profile.source).toContain("planning profile");
  });

  it("migrates a v1 config without inventing a component SKU", () => {
    const old = {
      schemaVersion: "1.0.0",
      id: "legacy",
      name: "Legacy",
      updatedAt: "2026-08-20",
      caseId: "case.jonsbo-n6",
      boardId: "board.asus-w680m-ace-se",
      cpuId: "cpu.i5-14500",
      psuId: "psu.seasonic-focus-gx-850-v5",
      psuTopology: "auto",
      coolerId: "cooler.thermalright-axp90-x53-full",
      gpuId: "gpu.none",
      memoryId: "memory.kingston-ksm48e40bd8km-32hm-x2",
      diskCount: 1,
      boot: "bay",
      hbaMode: "auto",
      bom: [],
    };
    const migrated = parseConfig(JSON.stringify(old));
    expect(migrated.schemaVersion).toBe("2.0.0");
    expect(migrated.migration).toEqual({ fromSchemaVersion: "1.0.0", toSchemaVersion: "2.0.0" });
    expect(migrated.selection.psuId).toBe(old.psuId);
    expect(migrated.selection.diskSkuId).toBeUndefined();
  });

  it("rejects malformed schema and reports invalid SKU/topology without partial writes", () => {
    expect(() => parseConfig(JSON.stringify({ schemaVersion: "0.1.0" }))).toThrow(/Unsupported config schema/);
    const invalid = structuredClone(baseline) as BuildConfig;
    invalid.selection.psuId = "psu.missing";
    invalid.selection.psuTopology = "dual";
    const issues = validateConfig(invalid, catalog);
    expect(issues.some((issue) => issue.path === "selection.psuId" && issue.verdict === "bad")).toBe(true);
    expect(issues.some((issue) => issue.path === "selection.secondaryPsuId" && issue.verdict === "bad")).toBe(true);
    expect(invalid.selection.psuId).toBe("psu.missing");
  });

  it("preserves unknown power inputs instead of replacing them with zero", () => {
    const unknownCatalog: SkuCatalog = structuredClone(rawCatalog);
    const gpu = unknownCatalog.skus.find((sku) => sku.id === "gpu.rtx-a4000-16gb")!;
    delete gpu.power.tgpW;
    const cfg = structuredClone(baseline) as BuildConfig;
    cfg.selection.gpuId = gpu.id;
    const power = derivePower(cfg, unknownCatalog, { workload: "ai" });
    expect(power.gpuW).toBeNull();
    expect(power.unknown).toContain("gpu.power");
    expect(power.wallW).toBeNull();
  });

  it("carries structured controller assignments and price provenance in one evaluation", () => {
    const cfg = structuredClone(baseline) as BuildConfig;
    cfg.selection.diskCount = 9;
    cfg.selection.boot = "m2";
    cfg.selection.hbaMode = "always";
    cfg.selection.hbaSkuId = "hba.lsi-9300-8i-it";
    const result = evaluateBuild(cfg, catalog);
    const hbaPath = result.wiring.bayPaths.find((path) => path.target === "hba");
    expect(hbaPath?.assignment).toMatchObject({ controller: "hba", connector: "sff-8643" });
    expect(hbaPath?.assignment.portIndex).toBeTypeOf("number");
    expect(result.price.catalogUpdatedAt).toBe(catalog.updatedAt);
    expect(result.price.items[0]).toHaveProperty("priceKind");
    expect(result.price.items[0]).toHaveProperty("historicalLowCny");
  });
});

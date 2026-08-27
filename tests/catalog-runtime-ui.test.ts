// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import baseline from "../data/configs/baseline-atx-1hdd.json";
import { applyAcceptedCatalogSkuToPlan, syncCatalogCategoryOptions, syncGpuCatalogOptions, upsertCatalogSku } from "../src/lab/catalog-runtime";
import type { BuildConfig } from "../src/config/types";
import { loadBundledCatalog } from "../src/sku/catalog";
import type { SkuRecord } from "../src/sku/types";
import { buildLabCatalogs } from "../src/lab/view-models";

const reviewedGpu: SkuRecord = {
  id: "gpu.msi-geforce-rtx-3070-ventus-2x-oc",
  category: "gpu",
  brand: "MSI",
  model: "GeForce RTX 3070 VENTUS 2X OC",
  name: "MSI GeForce RTX 3070 VENTUS 2X OC",
  dims: { lengthMm: 232, slots: 3, evidence: "inferred" },
  power: { tgpW: 220, evidence: "official" },
  price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
  attrs: { capacity: "8GB GDDR6" },
};

describe("runtime catalog selector", () => {
  it("adds an accepted no-MPN GPU once and makes it selectable", () => {
    const select = document.createElement("select");
    select.innerHTML = '<option value="gpu.none">暂不安装 GPU</option>';
    const first = upsertCatalogSku(loadBundledCatalog(), reviewedGpu);
    const second = upsertCatalogSku(first, { ...reviewedGpu, power: { tgpW: 225, evidence: "official" } });

    syncGpuCatalogOptions(select, second);
    syncGpuCatalogOptions(select, second);
    const matches = [...select.options].filter((option) => option.value === reviewedGpu.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.textContent).toContain("8GB GDDR6");
    expect(matches[0]?.textContent).toContain("225W");
    select.value = reviewedGpu.id;
    expect(select.value).toBe(reviewedGpu.id);
    expect(buildLabCatalogs(second).gpus[reviewedGpu.id]).toMatchObject({ vram: 8, kind: "GDDR6", tgp: 225, length: 232, slots: 3 });
  });

  it("adds reviewed catalog records to their matching selectors", () => {
    const psu = document.createElement("select");
    const reviewedPsu: SkuRecord = {
      id: "psu.fixture-reviewed-850", category: "psu", brand: "Fixture", model: "Reviewed 850", name: "Fixture Reviewed 850",
      dims: { evidence: "official" }, power: { ratedW: 850, evidence: "official" },
      price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    };
    const catalog = upsertCatalogSku(loadBundledCatalog(), reviewedPsu);
    syncCatalogCategoryOptions(psu, catalog, "psu");
    expect([...psu.options].find((option) => option.value === reviewedPsu.id)?.textContent).toContain("850W");
  });

  it("refreshes a bundled option when official information supplements the same SKU", () => {
    const select = document.createElement("select");
    select.innerHTML = '<option value="gpu.rtx-a2000-12gb">旧的静态标签</option>';
    const catalog = loadBundledCatalog();
    const existing = catalog.skus.find((sku) => sku.id === "gpu.rtx-a2000-12gb")!;
    const supplemented = upsertCatalogSku(catalog, { ...existing, power: { ...existing.power, tgpW: 71 } });
    syncCatalogCategoryOptions(select, supplemented, "gpu");
    expect(select.options[0]?.textContent).toContain("71W");
    expect(select.options[0]?.textContent).not.toBe("旧的静态标签");
  });

  it("updates only the explicitly linked plan component", () => {
    const config = structuredClone(baseline) as BuildConfig;
    const originalPsu = config.selection.psuId;
    expect(applyAcceptedCatalogSkuToPlan(config, reviewedGpu, "gpu.primary")).toBe("GPU");
    expect(config.selection.gpuId).toBe(reviewedGpu.id);
    expect(config.selection.psuId).toBe(originalPsu);
    expect(applyAcceptedCatalogSkuToPlan(config, { ...reviewedGpu, id: "gpu.unlinked" }, originalPsu)).toBeNull();
    expect(config.selection.gpuId).toBe(reviewedGpu.id);
  });
});

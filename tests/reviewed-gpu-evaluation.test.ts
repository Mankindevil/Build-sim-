import { describe, expect, it } from "vitest";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { derivePower, evaluateBuild } from "../src/core/evaluate";
import { loadBundledCatalog } from "../src/sku/catalog";
import type { SkuRecord } from "../src/sku/types";

describe("reviewed official GPU evaluation", () => {
  it("uses the accepted SKU for BOM, size, heat load and component noise without inventing an idle value", () => {
    const sku: SkuRecord = {
      id: "gpu.msi-geforce-rtx-3070-ventus-2x-oc",
      category: "gpu",
      brand: "MSI",
      model: "GeForce RTX 3070 VENTUS 2X OC",
      name: "MSI GeForce RTX 3070 VENTUS 2X OC",
      dims: { lengthMm: 232, heightMm: 124, thicknessMm: 52, slots: 3, evidence: "inferred", note: "槽位由官网厚度保守换算" },
      power: { tgpW: 220, evidence: "official" },
      price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
      attrs: { capacity: "8GB GDDR6", vramGb: 8, noiseDba: 34.5 },
      appearance: { page: "https://www.msi.com/Graphics-Card/GeForce-RTX-3070-VENTUS-2X-OC/Specification" },
    };
    const base = loadBundledCatalog();
    const catalog = { ...base, skus: [...base.skus, sku] };
    const config = createDefaultN6Config("plan-reviewed-gpu", "2026-08-26T00:00:00.000Z");
    config.selection.gpuId = sku.id;

    const evaluation = evaluateBuild(config, catalog);
    expect(evaluation.bom).toContainEqual(expect.objectContaining({ skuId: sku.id, qty: 1 }));
    expect(evaluation.geometry.find((part) => part.skuId === sku.id)?.dimsLabel).toContain("232");
    expect(evaluation.noise).toMatchObject({ totalDba: null, parts: { gpu: 34.5 } });
    expect(derivePower(config, catalog, { workload: "ai" }).gpuW).toBe(220);
    expect(derivePower(config, catalog, { workload: "idle" }).unknown).toContain("gpu.power");
  });
});

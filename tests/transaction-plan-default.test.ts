import { describe, expect, it } from "vitest";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { loadBundledCatalog } from "../src/sku/catalog";
import { applyArchivedPurchasesAsDefaults } from "../src/lab/transaction-plan-default";
import type { BuildProgressItem } from "../src/lab/build-progress";

describe("transaction plan defaults", () => {
  it("makes a verified archived purchase the active plan component", () => {
    const planId = "plan-default-12345678";
    const config = createDefaultN6Config(planId, "2026-08-26T00:00:00.000Z");
    config.selection.psuId = "psu.seasonic-focus-gx-850-v5";
    const item: BuildProgressItem = {
      id: "transaction-fx",
      skuId: "psu.seasonic-focus-plus-gold-850-fx",
      name: "Seasonic GX-850 FX",
      category: "psu",
      qty: 1,
      unitPriceCny: 400,
      stage: "purchased",
      source: "transaction",
      planLink: { schemaVersion: "1.0.0", planId, planVersionIdAtCapture: null, planItemId: "psu.seasonic-focus-gx-850-v5", linkStatus: "linked" },
    };

    expect(applyArchivedPurchasesAsDefaults(config, [item], planId, loadBundledCatalog())).toEqual(["Seasonic FOCUS Plus Gold 850 (SSR-850FX)"]);
    expect(config.selection.psuId).toBe("psu.seasonic-focus-plus-gold-850-fx");
  });

  it("does not change the plan for an unlinked or merely staged candidate", () => {
    const planId = "plan-default-12345678";
    const config = createDefaultN6Config(planId, "2026-08-26T00:00:00.000Z");
    const before = config.selection.psuId;
    const item = {
      id: "transaction-unlinked", skuId: "psu.seasonic-focus-gx-850-v5", name: "PSU", category: "psu", qty: 1, unitPriceCny: 400,
      stage: "candidate", source: "transaction", planLink: { schemaVersion: "1.0.0", planId, planVersionIdAtCapture: null, planItemId: null, linkStatus: "unlinked" },
    } as const satisfies BuildProgressItem;
    expect(applyArchivedPurchasesAsDefaults(config, [item], planId, loadBundledCatalog())).toEqual([]);
    expect(config.selection.psuId).toBe(before);
  });
});

import { describe, expect, it } from "vitest";
import {
  emptyProgressState,
  normalizeProgressState,
  stageForBucket,
  summarizeProgress,
  type BuildProgressItem,
} from "../src/lab/build-progress";

describe("build progress", () => {
  it("keeps engine purchase buckets separate from user lifecycle state", () => {
    expect(stageForBucket("owned")).toBe("purchased");
    expect(stageForBucket("buy_now")).toBe("candidate");
    expect(stageForBucket("upgrade_later")).toBe("candidate");
    expect(stageForBucket("optional")).toBe("candidate");
  });

  it("summarizes purchase, installation and only known spend", () => {
    const items: BuildProgressItem[] = [
      { id: "case", skuId: "case", name: "Case", category: "case", qty: 1, unitPriceCny: 600, stage: "installed", source: "catalog" },
      { id: "disk", skuId: "disk", name: "Disk", category: "storage", qty: 2, unitPriceCny: 1200, stage: "purchased", source: "catalog" },
      { id: "fan", skuId: null, name: "Fan", category: "fan", qty: 1, unitPriceCny: null, stage: "purchased", source: "manual" },
      { id: "gpu", skuId: "gpu", name: "GPU", category: "gpu", qty: 1, unitPriceCny: 0, stage: "locked", source: "catalog" },
    ];
    expect(summarizeProgress(items)).toEqual({
      total: 4,
      candidate: 0,
      locked: 1,
      purchased: 2,
      installed: 1,
      knownSpentCny: 3000,
      unknownPurchasedPrice: 1,
    });
  });

  it("drops malformed persisted rows without making up prices or stages", () => {
    const normalized = normalizeProgressState({
      schemaVersion: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
      items: {
        valid: { name: "Valid", stage: "locked", qty: 2, unitPriceCny: null, source: "manual" },
        invalid: { name: "Invalid", stage: "done", unitPriceCny: 999 },
      },
    });
    expect(Object.keys(normalized.items)).toEqual(["valid"]);
    const valid = normalized.items.valid;
    expect(valid).toBeDefined();
    expect(valid?.unitPriceCny).toBeNull();
    expect(valid?.skuId).toBeNull();
    expect(valid?.qty).toBe(2);
  });

  it("falls back to an empty versioned state", () => {
    expect(normalizeProgressState(null)).toMatchObject({ schemaVersion: 1, items: {} });
    expect(emptyProgressState()).toMatchObject({ schemaVersion: 1, items: {} });
  });
});

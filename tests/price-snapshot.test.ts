import { describe, expect, it } from "vitest";
import { applyPriceSnapshot, snapshotSummary } from "../src/price/merge";
import { formatSnapshotStamp } from "../src/price/types";
import type { PriceSnapshotFile } from "../src/price/types";
import { loadRawCatalog } from "../src/sku/catalog";
import { buildLabCatalogs } from "../src/lab/view-models";

const baseSkuId = "memory.corsair-cmk32gx5m2x6400c38";

describe("price snapshots", () => {
  it("formats stamp without claiming live market", () => {
    expect(
      formatSnapshotStamp({ platform: "jd", asOf: "2026-08-21" }),
    ).toBe("snapshot 2026-08-21 · jd");
  });

  it("leaves catalog untouched when snapshot has no audited quotes", () => {
    const raw = loadRawCatalog();
    const empty: PriceSnapshotFile = {
      schemaVersion: "1.0.0",
      asOf: "2026-08-21",
      quotes: [],
    };
    const merged = applyPriceSnapshot(raw, empty);
    const sku = merged.skus.find((s) => s.id === baseSkuId);
    expect(sku?.price.current ?? null).toBeNull();
    expect(sku?.price.snapshot).toBeUndefined();
    expect(snapshotSummary(empty).auditedCount).toBe(0);
  });

  it("merges audited quote into current + snapshot meta", () => {
    const raw = loadRawCatalog();
    const snap: PriceSnapshotFile = {
      schemaVersion: "1.0.0",
      asOf: "2026-08-21",
      quotes: [
        {
          skuId: baseSkuId,
          platform: "jd",
          priceCny: 529,
          currency: "CNY",
          listingUrl: "https://item.jd.com/example.html",
          match: "mpn",
          evidence: "audited",
          note: "Title contains CMK32GX5M2X6400C38",
        },
        {
          skuId: baseSkuId,
          platform: "pdd",
          priceCny: 499,
          currency: "CNY",
          match: "mpn",
          evidence: "audited",
          note: "Lower PDD quote wins",
        },
      ],
    };
    const merged = applyPriceSnapshot(raw, snap);
    const sku = merged.skus.find((s) => s.id === baseSkuId);
    expect(sku?.price.current).toBe(499);
    expect(sku?.price.currentEvidence).toBe("standard");
    expect(sku?.price.asOf).toBe("2026-08-21");
    expect(sku?.price.snapshot?.platform).toBe("pdd");
    expect(sku?.price.historicalLow ?? null).toBeNull();

    const views = buildLabCatalogs(merged);
    expect(views.rams[baseSkuId]?.mid).toBe(499);
    expect(views.rams[baseSkuId]?.priceQuality).toBe("snapshot 2026-08-21 · pdd");
  });

  it("ignores unknown-evidence quotes", () => {
    const raw = loadRawCatalog();
    const snap: PriceSnapshotFile = {
      schemaVersion: "1.0.0",
      asOf: "2026-08-21",
      quotes: [
        {
          skuId: baseSkuId,
          platform: "jd",
          priceCny: 100,
          currency: "CNY",
          match: "manual",
          evidence: "unknown",
        },
      ],
    };
    const merged = applyPriceSnapshot(raw, snap);
    const sku = merged.skus.find((s) => s.id === baseSkuId);
    expect(sku?.price.current ?? null).toBeNull();
    expect(sku?.price.snapshot).toBeUndefined();
  });
});

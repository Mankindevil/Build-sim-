import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/hash";
import { applyPriceSnapshot, snapshotSummary } from "../src/price/merge";
import type { ImmutableListingCapture, PriceObservation } from "../src/price/contracts";
import { PriceRepository } from "../src/price/repository";
import { CurrentPriceSnapshotService } from "../src/price/snapshot";
import { formatSnapshotStamp } from "../src/price/types";
import type { PriceSnapshotFile } from "../src/price/types";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { loadRawCatalog } from "../src/sku/catalog";
import { buildLabCatalogs } from "../src/lab/view-models";

const baseSkuId = "memory.corsair-cmk32gx5m2x6400c38";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

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

describe("U10 observation-derived current price snapshot", () => {
  it("uses the same seller-deduplicated usable observations and preserves provenance across restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-snapshot-")); roots.push(root);
    const now = "2026-08-29T12:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    const prices = new PriceRepository({ coordinator, now: () => now });
    await prices.initialize("price-snapshot-test");
    const add = async (id: string, platform: "jd" | "tmall", sellerId: string, capturedAt: string, amount: number) => {
      const raw: Omit<ImmutableListingCapture, "contentHash"> = {
        schemaVersion: "listing-capture-v1", listingCaptureId: `capture-${id}`, skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"],
        platform, sellerId, sellerTier: "unknown", condition: "new", stockStatus: "in_stock", priceCny: amount, comparableTotalCny: amount,
        invoiceStatus: "unknown", warrantyStatus: "unknown", canonicalUrl: platform === "jd" ? `https://item.jd.com/${id}.html` : `https://detail.tmall.com/item.htm?id=${id}`,
        capturedAt,
      };
      const capture: ImmutableListingCapture = { ...raw, contentHash: await hashContent(raw, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
      const observation: PriceObservation = {
        observationId: `observation-${id}`, skuId: raw.skuId, variantIdentityFactIds: raw.variantIdentityFactIds, platform, sellerId,
        sellerTier: "unknown", sellerTierEvidenceRefs: [], condition: "new", stockStatus: "in_stock", priceCny: amount, comparableTotalCny: amount,
        invoiceStatus: "unknown", warrantyStatus: "unknown", canonicalUrl: raw.canonicalUrl, listingCaptureId: capture.listingCaptureId, capturedAt,
      };
      await prices.putListingCapture(capture); await prices.putObservation(observation);
      return observation;
    };
    await add("old-same-seller", "jd", "seller-a", "2026-08-24T12:00:00.000Z", 5_200);
    const latest = await add("latest-same-seller", "jd", "seller-a", "2026-08-28T12:00:00.000Z", 5_000);
    const independent = await add("independent", "tmall", "seller-b", "2026-08-28T13:00:00.000Z", 5_100);
    const expired = await add("expired", "jd", "seller-c", "2026-08-20T12:00:00.000Z", 4_000);
    const catalog = { schemaVersion: "2.0.0", catalogVersion: "fixture", updatedAt: "2026-08-29", skus: [] };
    const first = await new CurrentPriceSnapshotService({ coordinator, prices, catalog: () => catalog, now: () => now }).rebuild("2026-08-29");
    expect(first.selectedObservationIds).toEqual([independent.observationId, latest.observationId].sort());
    expect(first.omittedObservationIds).toEqual(expect.arrayContaining([expired.observationId, "observation-old-same-seller"]));
    expect(first.snapshot.quotes).toHaveLength(2);
    expect(first.snapshot.quotes.map((quote) => quote.provenanceId).sort()).toEqual(first.selectedObservationIds);
    expect(first.snapshot.quotes.map((quote) => quote.platform).sort()).toEqual(["jd", "tmall"]);
    expect(first.snapshot.quotes.every((quote) => quote.variantLabel === "claim.variant.gpu" && /^[a-f0-9]{64}$/.test(quote.sourceHash ?? ""))).toBe(true);
    const restarted = new CurrentPriceSnapshotService({ coordinator: new RuntimeCoordinator({ root }), prices: new PriceRepository({ runtimeRoot: root }), catalog: () => catalog, now: () => now });
    const replay = await restarted.rebuild("2026-08-29");
    expect(replay.snapshot).toEqual(first.snapshot);
  });
});

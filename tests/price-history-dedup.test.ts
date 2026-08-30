import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/hash";
import { buildPriceHistoryPoint, projectCurrentHistoryPoints } from "../src/price/history";
import type { ImmutableListingCapture, PriceObservation } from "../src/price/contracts";
import { ProductionPlanPriceService } from "../src/price/production";
import { ProductionPriceRuntime } from "../src/price/production-runtime";
import { PriceRepository } from "../src/price/repository";
import { CurrentPriceSnapshotService } from "../src/price/snapshot";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function observation(id: string, sellerId: string, price: number): PriceObservation {
  return {
    observationId: id, skuId: "gpu.fixture", variantIdentityFactIds: ["variant.gpu"], platform: "jd", sellerId,
    sellerTier: "unknown", sellerTierEvidenceRefs: [], condition: "new", stockStatus: "in_stock", priceCny: price, comparableTotalCny: price,
    invoiceStatus: "unknown", warrantyStatus: "unknown", canonicalUrl: `https://item.jd.com/${id}.html`, listingCaptureId: `capture-${id}`,
    capturedAt: "2026-08-29T01:00:00.000Z",
  };
}

describe("U10 immutable history head projection", () => {
  it("keeps sparse rebuilds auditable while exposing only the most complete exact bucket", async () => {
    const firstObservation = observation("observation-a", "seller-a", 1_000);
    const secondObservation = observation("observation-b", "seller-b", 900);
    const base = { skuId: "gpu.fixture", variantIdentityFactIds: ["variant.gpu"], bucketStart: "2026-08-29T00:00:00.000Z", bucketEnd: "2026-08-30T00:00:00.000Z" } as const;
    const sparse = await buildPriceHistoryPoint({ ...base, snapshotId: "snapshot-sparse", observations: [firstObservation] });
    const complete = await buildPriceHistoryPoint({ ...base, snapshotId: "snapshot-complete", observations: [firstObservation, secondObservation] });
    const heads = projectCurrentHistoryPoints([sparse, complete]);
    expect([sparse, complete]).toHaveLength(2);
    expect(heads).toEqual([complete]);
    expect(heads[0]).toMatchObject({ sampleCount: 2, sellerCount: 2, minCny: 900, maxCny: 1_000 });
  });

  it("rebuilds the previous Shanghai day through a durable schedule and replays without duplicate heads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-history-")); roots.push(root);
    const now = "2026-08-30T16:00:00.000Z"; // 2026-08-31 00:00 Asia/Shanghai
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    const prices = new PriceRepository({ coordinator, now: () => now }); await prices.initialize("history-worker-test");
    const saved: PriceObservation[] = [];
    for (const [suffix, sellerId, amount] of [["a", "seller-a", 1_000], ["b", "seller-b", 900]] as const) {
      const raw: Omit<ImmutableListingCapture, "contentHash"> = {
        schemaVersion: "listing-capture-v1", listingCaptureId: `capture-${suffix}`, skuId: "gpu.fixture",
        variantIdentityFactIds: ["variant.gpu"], platform: "jd", sellerId, sellerTier: "unknown", condition: "new",
        stockStatus: "in_stock", priceCny: amount, comparableTotalCny: amount, invoiceStatus: "unknown",
        warrantyStatus: "mainland", canonicalUrl: `https://item.jd.com/${suffix}.html`, capturedAt: "2026-08-30T01:00:00.000Z",
      };
      const capture = { ...raw, contentHash: await hashContent(raw, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
      const item: PriceObservation = {
        observationId: `observation-${suffix}`, skuId: raw.skuId, variantIdentityFactIds: raw.variantIdentityFactIds,
        platform: raw.platform, sellerId, sellerTier: "unknown", sellerTierEvidenceRefs: [], condition: "new",
        stockStatus: "in_stock", priceCny: amount, comparableTotalCny: amount, invoiceStatus: "unknown",
        warrantyStatus: "mainland", canonicalUrl: raw.canonicalUrl, listingCaptureId: raw.listingCaptureId, capturedAt: raw.capturedAt,
      };
      await prices.putListingCapture(capture); await prices.putObservation(item); saved.push(item);
    }
    const bucket = { skuId: "gpu.fixture", variantIdentityFactIds: ["variant.gpu"], bucketStart: "2026-08-29T16:00:00.000Z", bucketEnd: now } as const;
    await prices.putHistoryPoint(await buildPriceHistoryPoint({ ...bucket, snapshotId: "snapshot-sparse", observations: [saved[0]!] }));
    const planPrices = new ProductionPlanPriceService({
      coordinator, prices,
      plans: { getAtRoot: async () => { throw new Error("unused"); } },
      locks: {
        currentLockAtRoot: async () => null,
        hydrateExternalInputsAtRoot: async () => { throw new Error("unused"); },
      }, now: () => now,
    });
    const snapshots = new CurrentPriceSnapshotService({ coordinator, prices, catalog: () => ({ schemaVersion: "2.0.0", skus: [] }), now: () => now });
    const runtimeOptions = {
      coordinator, prices, planPrices, snapshots, now: () => now, online: () => false,
      currentSnapshotAtRoot: () => ({ schemaVersion: "1.1.0" as const, snapshotId: "snapshot-current", asOf: "2026-08-30", quotes: [] }),
      schedulerIntervalMs: 100,
    };
    const first = new ProductionPriceRuntime(runtimeOptions);
    expect((await first.tick()).worker.worker.outcome).toBe("succeeded");
    const all = await prices.listHistoryPoints();
    expect(all).toHaveLength(2);
    expect(projectCurrentHistoryPoints(all)).toMatchObject([{ sampleCount: 2, sellerCount: 2, snapshotId: "snapshot-current" }]);

    const restarted = new ProductionPriceRuntime(runtimeOptions);
    const replay = await restarted.tick();
    expect(replay.schedules.every(({ due }) => !due)).toBe(true);
    expect(replay.worker.worker.outcome).toBe("idle");
    expect(await prices.listHistoryPoints()).toHaveLength(2);
  });
});

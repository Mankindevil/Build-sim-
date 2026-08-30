import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runUniversalReleaseCanary } from "../scripts/release/universal-canary";
import { planFactsV1Migration, migrateFactsV1 } from "../scripts/migrations/migrate-facts-v1.mjs";
import { initializeRuntimeCatalog, loadMergedCatalogSync } from "../scripts/price-server/catalog/repository.mjs";
import { hashContent } from "../src/hash";
import type { ImmutableListingCapture, PriceObservation } from "../src/price/contracts";
import { PriceRepository } from "../src/price/repository";
import { CurrentPriceSnapshotService } from "../src/price/snapshot";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const canarySkus = [
  "case.jonsbo-n6",
  "board.asus-w680m-ace-se",
  "cpu.i5-14500",
  "storage.samsung-980-pro",
  "psu.seasonic-focus-plus-gold-850-fx",
] as const;

function safeId(value: string): string {
  return value.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").toLowerCase();
}

async function currentPriceRecords(skuId: string, index: number, sellerIndex: number): Promise<{
  capture: ImmutableListingCapture;
  observation: PriceObservation;
}> {
  const suffix = `${safeId(skuId)}-${sellerIndex}`;
  const platform = sellerIndex === 0 ? "jd" as const : "tmall" as const;
  const material = {
    schemaVersion: "listing-capture-v1" as const,
    listingCaptureId: `capture-canary-${suffix}`,
    skuId,
    variantIdentityFactIds: [`variant-fact-${safeId(skuId)}`],
    platform,
    sellerId: `seller-canary-${index}-${sellerIndex}`,
    sellerTier: "unknown" as const,
    condition: "new" as const,
    stockStatus: "in_stock" as const,
    priceCny: 500 + index * 100 + sellerIndex * 20,
    comparableTotalCny: 500 + index * 100 + sellerIndex * 20,
    invoiceStatus: "unknown" as const,
    warrantyStatus: "unknown" as const,
    canonicalUrl: platform === "jd"
      ? `https://item.jd.com/${10_000 + index * 10 + sellerIndex}.html`
      : `https://detail.tmall.com/item.htm?id=${20_000 + index * 10 + sellerIndex}`,
    capturedAt: "2026-08-30T08:00:00.000Z",
  };
  const capture: ImmutableListingCapture = {
    ...material,
    contentHash: await hashContent(material, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }),
  };
  return {
    capture,
    observation: {
      observationId: `price-observation-canary-${suffix}`,
      skuId,
      variantIdentityFactIds: [...capture.variantIdentityFactIds],
      platform,
      sellerId: material.sellerId,
      sellerTier: "unknown",
      sellerTierEvidenceRefs: [],
      condition: "new",
      stockStatus: "in_stock",
      priceCny: capture.priceCny,
      comparableTotalCny: capture.comparableTotalCny,
      invoiceStatus: "unknown",
      warrantyStatus: "unknown",
      canonicalUrl: capture.canonicalUrl,
      listingCaptureId: capture.listingCaptureId,
      capturedAt: capture.capturedAt,
    },
  };
}

describe("U12 universal release canary", () => {
  it("runs the exact N6 partial plan through production authority and reports only real remaining blockers", async () => {
    const report = await runUniversalReleaseCanary();
    expect(report).toMatchObject({
      schemaVersion: "universal-release-canary-v1",
      status: "blocked",
      blockers: [
        "stage-a.official-fact-closure",
        "stage-a.cpu-max-turbo-power-is-official",
      ],
    });
    expect(report.checks.filter(({ status }) => status === "pass").map(({ checkId }) => checkId)).toEqual([
      "stage-a.two-distinct-ssd-instances",
      "stage-a.no-profile-default-components",
      "stage-a.agent-claim-scopes-are-explicit",
      "stage-a.partial-remains-not-power-ready",
      "stage-a.no-empty-bay-data-cables",
      "stage-a.backplane-current-and-future-scopes-are-distinct",
      "stage-a.spatial-scene-is-locked-and-blocked",
      "stage-a.thermal-acoustic-remains-blocked",
      "stage-a.price-is-not-invented",
      "stage-a.no-executable-first-power-completion",
      "stage-a.procedure-is-preparation-only",
    ]);
    const factCheck = report.checks.find(({ checkId }) => checkId === "stage-a.official-fact-closure");
    expect(factCheck?.evidence).toMatchObject({
      missingSkuIds: [
        "cpu.i5-14500",
        "storage.samsung-980-pro",
        "psu.seasonic-focus-plus-gold-850-fx",
      ],
    });
  }, 30_000);

  it("clones an initialized runtime read-only and verifies low-confidence points plus an independent-seller range", async () => {
    const sourceRuntimeRoot = await mkdtemp(path.join(tmpdir(), "buildsim-canary-source-"));
    try {
      const migration = await planFactsV1Migration();
      await migrateFactsV1({
        dryRun: false,
        expectedSourceHash: migration.sourceHash,
        runtimeRoot: sourceRuntimeRoot,
        now: () => "2026-08-30T07:00:00.000Z",
      });
      const coordinator = new RuntimeCoordinator({ root: sourceRuntimeRoot, now: () => "2026-08-30T09:00:00.000Z" });
      await initializeRuntimeCatalog({ coordinator, generationAware: true });
      const prices = new PriceRepository({ coordinator, now: () => "2026-08-30T09:00:00.000Z" });
      await prices.initialize("universal-release-canary-source-test");
      for (const [index, skuId] of canarySkus.entries()) {
        const sellerCount = skuId === "storage.samsung-980-pro" ? 2 : 1;
        for (let sellerIndex = 0; sellerIndex < sellerCount; sellerIndex += 1) {
          const record = await currentPriceRecords(skuId, index, sellerIndex);
          await prices.putListingCapture(record.capture);
          await prices.putObservation(record.observation);
        }
      }
      const snapshots = new CurrentPriceSnapshotService({
        coordinator,
        prices,
        catalog: (activeRoot) => loadMergedCatalogSync({ runtimeRoot: sourceRuntimeRoot, activeRoot }),
        now: () => "2026-08-30T09:00:00.000Z",
      });
      await snapshots.rebuild("2026-08-30");

      const state = await coordinator.readState();
      const pointerPath = path.join(sourceRuntimeRoot, "control", "active-pointer.json");
      const latestPath = path.join(sourceRuntimeRoot, state.activeRoot, "prices", "latest.json");
      const plansPath = path.join(sourceRuntimeRoot, state.activeRoot, "plans");
      const [pointerBefore, latestBefore, plansBefore] = await Promise.all([
        readFile(pointerPath),
        readFile(latestPath),
        readdir(plansPath),
      ]);

      const report = await runUniversalReleaseCanary({ sourceRuntimeRoot });
      const priceCheck = report.checks.find(({ checkId }) => checkId === "stage-a.china-new-price-is-governed");
      expect(priceCheck?.status, JSON.stringify(priceCheck?.evidence, null, 2)).toBe("pass");
      expect(priceCheck?.evidence).toMatchObject({
        components: expect.arrayContaining([
          expect.objectContaining({ skuId: "cpu.i5-14500", status: "single", confidence: "low", sampleCount: 1 }),
          expect.objectContaining({ skuId: "storage.samsung-980-pro", status: "range", confidence: "medium", sampleCount: 2, sellerCount: 2 }),
        ]),
        progressiveUnknownInstanceIds: [],
      });
      expect(report.checks.some(({ checkId }) => checkId === "stage-a.price-is-not-invented")).toBe(false);
      expect(report.blockers).toEqual([
        "stage-a.official-fact-closure",
        "stage-a.cpu-max-turbo-power-is-official",
      ]);

      const [pointerAfter, latestAfter, plansAfter] = await Promise.all([
        readFile(pointerPath),
        readFile(latestPath),
        readdir(plansPath),
      ]);
      expect(pointerAfter.equals(pointerBefore)).toBe(true);
      expect(latestAfter.equals(latestBefore)).toBe(true);
      expect(plansAfter.sort()).toEqual(plansBefore.sort());
    } finally {
      await rm(sourceRuntimeRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

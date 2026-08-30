import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashContent } from "../src/hash";
import type { ImmutableListingCapture, PriceObservation } from "../src/price/contracts";
import { ProductionPlanPriceService } from "../src/price/production";
import { PriceRepository } from "../src/price/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const h = (character: string) => character.repeat(64);
const now = "2026-08-29T12:00:00.000Z";

describe("U10 production plan price authority", () => {
  it("projects only observations present in the exact evaluation price snapshot and edits targets by CAS", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-plan-prices-"));
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    const prices = new PriceRepository({ coordinator, now: () => now });
    await prices.initialize("price-production-test");
    const rawCapture: Omit<ImmutableListingCapture, "contentHash"> = {
      schemaVersion: "listing-capture-v1", listingCaptureId: "capture-gpu", skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"],
      platform: "jd", sellerId: "seller-a", sellerTier: "S1", condition: "new", stockStatus: "in_stock", priceCny: 5_000,
      comparableTotalCny: 5_000, invoiceStatus: "yes", warrantyStatus: "mainland", canonicalUrl: "https://item.jd.com/gpu.html", capturedAt: "2026-08-28T00:00:00.000Z",
    };
    const capture: ImmutableListingCapture = { ...rawCapture, contentHash: await hashContent(rawCapture, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
    const observation: PriceObservation = {
      observationId: "price-observation-gpu", skuId: capture.skuId, variantIdentityFactIds: capture.variantIdentityFactIds,
      platform: capture.platform, ...(capture.sellerId ? { sellerId: capture.sellerId } : {}), sellerTier: capture.sellerTier, sellerTierEvidenceRefs: ["evidence-claim:seller-tier-a"],
      condition: "new", stockStatus: "in_stock", priceCny: 5_000, comparableTotalCny: 5_000, invoiceStatus: "yes", warrantyStatus: "mainland",
      canonicalUrl: capture.canonicalUrl, listingCaptureId: capture.listingCaptureId, capturedAt: capture.capturedAt,
    };
    await prices.putListingCapture(capture);
    await prices.putObservation(observation);
    const config = createEmptyBuildConfigV3("plan-a", "Plan", now);
    config.components.push({
      instanceId: "gpu-a", kind: "gpu", role: "gpu", state: "planned", source: "user",
      identity: { status: "resolved", skuId: "gpu.fixture", identityClaimIds: ["claim.variant.gpu"] },
    });
    const plan = { draftRevision: 4, draft: { config } };
    const snapshot = {
      schemaVersion: "1.1.0", snapshotId: "price-snapshot-aaaaaaaaaaaaaaaaaaaa", asOf: "2026-08-29", contentHash: h("a"),
      quotes: [{ provenanceId: observation.observationId }],
    };
    const service = new ProductionPlanPriceService({
      coordinator, prices,
      plans: { getAtRoot: async () => plan },
      locks: {
        currentLockAtRoot: async () => ({ contentHash: h("b"), snapshotHashes: { configHash: h("c"), priceSnapshotHash: h("d") } }),
        hydrateExternalInputsAtRoot: async () => ({ priceSnapshot: { ref: { contentHash: h("d") }, payload: { payload: snapshot } } }),
      },
      now: () => now,
    });
    const view = await service.forPlan("plan-a");
    expect(view).toMatchObject({ priceSnapshotHash: h("d"), components: [{ instanceId: "gpu-a", current: { status: "single", confidence: "low", minCny: 5_000 } }] });
    const created = await service.createTarget("plan-a", { instanceId: "gpu-a", targetTotalCny: 4_500, requireMainlandWarranty: true });
    const updated = await service.reviseTarget("plan-a", {
      targetId: created.target.targetId,
      expectedRevision: created.revision,
      expectedRecordHash: created.recordHash,
      expectedTargetRevisionHash: created.target.revisionHash,
      targetTotalCny: 4_200,
    });
    expect(updated).toMatchObject({ revision: 1, target: { planId: "plan-a", instanceId: "gpu-a", skuId: "gpu.fixture", targetTotalCny: 4_200 } });
    await expect(service.reviseTarget("plan-a", {
      targetId: created.target.targetId,
      expectedRevision: created.revision,
      expectedRecordHash: created.recordHash,
      expectedTargetRevisionHash: created.target.revisionHash,
      targetTotalCny: 4_000,
    })).rejects.toThrow(/revision changed|conflict/);
  });
});

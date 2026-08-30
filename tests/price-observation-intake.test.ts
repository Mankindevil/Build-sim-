import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveCandidates } from "../scripts/price-server/store.mjs";
import { ProductionPriceObservationIntake } from "../src/price/intake";
import { PriceRepository } from "../src/price/repository";
import { CurrentPriceSnapshotService } from "../src/price/snapshot";
import type { PlanRepository } from "../src/plans/contracts";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const now = "2026-08-29T12:00:00.000Z";

async function fixture(title = "Fixture GPU 12GB new") {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-intake-")); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => now });
  const saved = await saveCandidates({
    candidates: [{
      skuId: "gpu.fixture", platform: "jd", channel: "jd", title,
      url: "https://item.jd.com/gpu-fixture.html?utm_source=fixture", fetchedAt: "2026-08-29T08:00:00.000Z",
      variants: [{ skuId: "gpu-12", label: "12GB", amount: 4_999, currency: "CNY", stock: 1 }],
    }],
  }, "2026-08-29", { coordinator, generationAware: true });
  const candidate = saved.candidates[0]!;
  const config = createEmptyBuildConfigV3("plan-a", "Plan", now);
  config.components.push({
    instanceId: "gpu-a", kind: "gpu", role: "gpu", state: "planned", source: "user",
    identity: { status: "resolved", skuId: "gpu.fixture", identityClaimIds: ["claim.variant.gpu"] },
  });
  const prices = new PriceRepository({ coordinator, now: () => now });
  const snapshots = new CurrentPriceSnapshotService({
    coordinator, prices, now: () => now,
    catalog: async () => ({ schemaVersion: "2.0.0", catalogVersion: "fixture", updatedAt: "2026-08-29", skus: [] }),
  });
  const service = new ProductionPriceObservationIntake({
    coordinator,
    plans: { getAtRoot: async () => ({ draft: { config } }) },
    prices,
    snapshots,
    now: () => now,
  });
  return { root, coordinator, candidate, prices, service };
}

describe("U10 production price observation intake", () => {
  it("derives an exact plan-bound observation from an immutable collected listing and replays after restart", async () => {
    const { root, coordinator, candidate, service } = await fixture();
    const input = {
      planId: "plan-a", instanceId: "gpu-a",
      listingCaptureId: candidate.listingCaptureId,
      variantLabel: "12GB",
    };
    const result = await service.ingest(input);
    expect(result).toMatchObject({
      schemaVersion: "price-observation-intake-result-v1",
      requiresEvaluationRefresh: true,
      listingCapture: {
        skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"],
        sourceListingCaptureId: candidate.listingCaptureId,
        sourceListingCaptureContentHash: candidate.captureContentHash,
        sellerTier: "unknown", stockStatus: "in_stock", priceCny: 4_999,
      },
      observation: {
        skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"],
        sellerTierEvidenceRefs: [], comparableTotalCny: 4_999,
      },
      snapshot: { quotes: [{ provenanceId: expect.stringMatching(/^price-observation-/) }] },
    });
    const graph = await createProductionReferenceGraph({ coordinator, now: () => now });
    expect(graph.nodes).toEqual(expect.arrayContaining([
      `legacy-price-capture:${candidate.listingCaptureId}`,
      `price-capture:${result.listingCapture.listingCaptureId}`,
      `price-observation:${result.observation.observationId}`,
      `price-snapshot:${result.snapshot.snapshotId}`,
    ]));

    const restartedCoordinator = new RuntimeCoordinator({ root, now: () => now });
    const restartedPrices = new PriceRepository({ coordinator: restartedCoordinator, now: () => now });
    const restarted = new ProductionPriceObservationIntake({
      coordinator: restartedCoordinator,
      plans: { getAtRoot: async () => ({ draft: { config: createConfig() } }) },
      prices: restartedPrices,
      snapshots: new CurrentPriceSnapshotService({
        coordinator: restartedCoordinator, prices: restartedPrices, now: () => now,
        catalog: async () => ({ schemaVersion: "2.0.0", catalogVersion: "fixture", updatedAt: "2026-08-29", skus: [] }),
      }),
      now: () => now,
    });
    const replay = await restarted.ingest(input);
    expect(replay.listingCapture).toEqual(result.listingCapture);
    expect(replay.observation).toEqual(result.observation);
    expect(replay.snapshot.snapshotId).toBe(result.snapshot.snapshotId);
  });

  it("does not create a formal observation for a listing marked as non-current-new", async () => {
    const { candidate, prices, service } = await fixture("二手 Fixture GPU 12GB");
    await expect(service.ingest({
      planId: "plan-a", instanceId: "gpu-a", listingCaptureId: candidate.listingCaptureId, variantLabel: "12GB",
    })).rejects.toThrow(/not eligible/);
    await expect(prices.listObservations()).resolves.toEqual([]);
    await expect(prices.listListingCapturesAtRoot(
      prices.coordinator.activeRoot(await prices.coordinator.readState()),
    )).resolves.toEqual([]);
  });

  it("exposes an ID-only workspace route and rejects caller-supplied price fields", async () => {
    const result = { schemaVersion: "price-observation-intake-result-v1", observation: { observationId: "observation-a" } };
    const intake = { ingest: vi.fn(async () => result) };
    const options = {
      priceHistoryEnabled: true,
      planPrices: {} as never,
      priceObservationIntake: intake as never,
    };
    expect(await handleWorkspaceRoute("POST", "/api/workspace/plans/plan-a/price-observations", {
      instanceId: "gpu-a", listingCaptureId: `listing-capture-${"a".repeat(20)}`, variantLabel: "12GB",
    }, {} as PlanRepository, options)).toEqual({ status: 201, payload: result });
    expect(intake.ingest).toHaveBeenCalledWith({
      planId: "plan-a", instanceId: "gpu-a", listingCaptureId: `listing-capture-${"a".repeat(20)}`, variantLabel: "12GB",
    });
    expect((await handleWorkspaceRoute("POST", "/api/workspace/plans/plan-a/price-observations", {
      instanceId: "gpu-a", listingCaptureId: `listing-capture-${"a".repeat(20)}`, variantLabel: "12GB", priceCny: 1,
    }, {} as PlanRepository, options)).status).toBe(400);
  });
});

function createConfig() {
  const config = createEmptyBuildConfigV3("plan-a", "Plan", now);
  config.components.push({
    instanceId: "gpu-a", kind: "gpu", role: "gpu", state: "planned", source: "user",
    identity: { status: "resolved", skuId: "gpu.fixture", identityClaimIds: ["claim.variant.gpu"] },
  });
  return config;
}

import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/hash";
import { PriceRepository, PriceRepositoryError } from "../src/price/repository";
import { priceTargetEventIdempotencyKey, type ImmutableListingCapture, type PriceHistoryPoint, type PriceObservation, type PriceTarget } from "../src/price/contracts";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createConsistentReferenceGraph } from "../src/runtime/reference-graph.mjs";

const roots: string[] = [];
const digest = (letter: string) => letter.repeat(64);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(root?: string) {
  const runtimeRoot = root ?? await mkdtemp(path.join(os.tmpdir(), "buildsim-price-repository-"));
  if (!root) roots.push(runtimeRoot);
  const repo = new PriceRepository({ runtimeRoot, now: () => "2026-08-27T02:00:00.000Z" });
  await repo.initialize("test");
  const raw: Omit<ImmutableListingCapture, "contentHash"> = {
    schemaVersion: "listing-capture-v1", listingCaptureId: "capture-1", skuId: "gpu.fixture", variantIdentityFactIds: ["variant-gpu"],
    platform: "jd", sellerId: "seller-1", sellerName: "Fixture seller", sellerTier: "S1", condition: "new", stockStatus: "in_stock",
    priceCny: 999, shippingCny: 1, comparableTotalCny: 1000, invoiceStatus: "yes", warrantyStatus: "mainland", canonicalUrl: "https://item.jd.com/fixture.html", capturedAt: "2026-08-27T00:00:00.000Z",
  };
  const capture: ImmutableListingCapture = { ...raw, contentHash: await hashContent(raw, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
  const observation: PriceObservation = { observationId: "observation-1", skuId: capture.skuId, variantIdentityFactIds: capture.variantIdentityFactIds, platform: capture.platform, sellerId: "seller-1", sellerName: "Fixture seller", sellerTier: capture.sellerTier, sellerTierEvidenceRefs: ["claim:seller-1"], condition: capture.condition, stockStatus: capture.stockStatus, priceCny: capture.priceCny, shippingCny: 1, comparableTotalCny: capture.comparableTotalCny, invoiceStatus: capture.invoiceStatus, warrantyStatus: capture.warrantyStatus, canonicalUrl: capture.canonicalUrl, listingCaptureId: capture.listingCaptureId, capturedAt: capture.capturedAt };
  const point: PriceHistoryPoint = { historyPointId: "history-1", skuId: capture.skuId, variantIdentityFactIds: capture.variantIdentityFactIds, bucketStart: "2026-08-27T00:00:00.000Z", bucketEnd: "2026-08-28T00:00:00.000Z", timeZone: "Asia/Shanghai", policyHash: digest("a"), priceBasis: "comparable_total_cny", condition: "new", region: "CN", currency: "CNY", minCny: 1000, maxCny: 1000, medianCny: 1000, sampleCount: 1, sellerCount: 1, platformCounts: { jd: 1 }, observationIds: [observation.observationId], confidence: "low", snapshotId: "snapshot-1" };
  const target: PriceTarget = { targetId: "target-1", planId: "plan-1", instanceId: "gpu-1", skuId: capture.skuId, variantIdentityFactIds: capture.variantIdentityFactIds, targetTotalCny: 1000, enabled: true, status: "watching", revisionHash: digest("b"), updatedAt: "2026-08-27T00:00:00.000Z" };
  return { runtimeRoot, repo, capture, observation, point, target };
}

describe("U1 PriceRepository", () => {
  it("persists validated captures, observations, history and targets across restart", async () => {
    const { runtimeRoot, repo, capture, observation, point, target } = await fixture();
    await repo.putListingCapture(capture);
    await repo.putObservation(observation);
    await repo.putHistoryPoint(point);
    const created = await repo.putTarget(target);
    expect(created.revision).toBe(0);
    const restarted = new PriceRepository({ runtimeRoot });
    expect(await restarted.listObservations()).toEqual([observation]);
    expect(await restarted.listHistoryPoints()).toEqual([point]);
    expect((await restarted.getTarget(target.targetId)).target).toEqual(target);
    const state = await restarted.coordinator.readState();
    expect((await stat(path.join(restarted.coordinator.activeRoot(state), "prices", "domain", "targets", "target-1.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects dangling/mutated evidence, serializes CAS target updates, and records rollback evidence", async () => {
    const { repo, capture, observation, target } = await fixture();
    await expect(repo.putObservation(observation)).rejects.toMatchObject({ code: "not_found" });
    await repo.putListingCapture(capture);
    await repo.putObservation(observation);
    const created = await repo.putTarget(target);
    const changed = { ...target, targetTotalCny: 900, revisionHash: digest("c"), updatedAt: "2026-08-27T02:00:00.000Z" };
    const updated = await repo.putTarget(changed, { expectedRevision: created.revision, expectedHash: created.recordHash });
    expect(updated.revision).toBe(1);
    await expect(repo.putTarget({ ...changed, targetTotalCny: 800 }, { expectedRevision: 0, expectedHash: created.recordHash })).rejects.toMatchObject({ code: "conflict" });
    const state = await repo.coordinator.readState();
    const rollback = path.join(repo.coordinator.activeRoot(state), "prices", "domain", "rollback", "targets", target.targetId, "000000000000.json");
    expect(await readFile(rollback, "utf8")).toContain("price-target-rollback-v1");
    expect(await readFile(path.join(repo.coordinator.activeRoot(state), "prices", "domain", "rollback", "manifest.json"), "utf8")).toContain("price-rollback-manifest-v1");
  });

  it("deduplicates concurrent target events by durable semantic idempotency key", async () => {
    const { runtimeRoot, repo, target } = await fixture();
    await repo.putTarget(target);
    const base = { targetId: target.targetId, targetRevisionHash: target.revisionHash, priceSnapshotId: "snapshot-1", transition: "watching_to_met" as const };
    const key = priceTargetEventIdempotencyKey(base);
    const second = new PriceRepository({ runtimeRoot });
    const outcomes = await Promise.all([
      repo.recordTargetEvent({ eventId: "event-a", ...base, occurredAt: "2026-08-27T02:00:00.000Z", idempotencyKey: key }),
      second.recordTargetEvent({ eventId: "event-b", ...base, occurredAt: "2026-08-27T02:01:00.000Z", idempotencyKey: key }),
    ]);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(await repo.listTargetEvents(target.targetId)).toHaveLength(1);
  });

  it("fences writes during maintenance and re-resolves active generation after pointer switch", async () => {
    const { repo, target } = await fixture();
    await repo.putTarget(target);
    const coordinator = repo.coordinator;
    const before = await coordinator.readState();
    const lease = await coordinator.acquireMaintenanceLease("price-test");
    await expect(repo.putTarget({ ...target, targetTotalCny: 900, revisionHash: digest("d"), updatedAt: "2026-08-27T03:00:00.000Z" })).rejects.toThrow(/fenced/);
    const staging = await coordinator.createStagingGeneration(lease.token);
    await cp(path.join(coordinator.activeRoot(before), "prices"), path.join(staging, "prices"), { recursive: true, force: true });
    await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token);
    expect((await repo.getTarget(target.targetId)).target.targetTotalCny).toBe(1000);
    await coordinator.releaseMaintenanceLease(lease.token);
  });

  it("fails closed on corrupt committed data while ignoring uncommitted partial files and exposes only closed references", async () => {
    const { repo, target } = await fixture();
    await repo.putTarget(target);
    const state = await repo.coordinator.readState();
    const root = repo.coordinator.activeRoot(state);
    await writeFile(path.join(root, "prices", "domain", "targets", "orphan.partial.tmp"), "{", { mode: 0o600 });
    const graph = await createConsistentReferenceGraph({ coordinator: repo.coordinator, providers: [repo] });
    expect(graph.edges).toEqual([]);
    const targetFile = path.join(root, "prices", "domain", "targets", "target-1.json");
    const damaged = JSON.parse(await readFile(targetFile, "utf8")) as { payload: { targetTotalCny: number } };
    damaged.payload.targetTotalCny = 1;
    await writeFile(targetFile, JSON.stringify(damaged), { mode: 0o600 });
    await expect(repo.getTarget(target.targetId)).rejects.toBeInstanceOf(PriceRepositoryError);
  });
});

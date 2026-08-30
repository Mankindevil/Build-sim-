import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAndWriteLatest } from "../scripts/price-server/store.mjs";
import { createBackup, restoreBackup } from "../src/backup/runtime.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { hashContent } from "../src/hash";
import type { ImmutableListingCapture, PriceHistoryPoint, PriceObservation } from "../src/price/contracts";
import { PriceRepository } from "../src/price/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { sha256Json } from "../src/runtime/fs.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-operations-")); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => "2026-08-29T12:00:00.000Z" });
  const prices = new PriceRepository({ coordinator, now: () => "2026-08-29T12:00:00.000Z" });
  await prices.initialize("price-operations-test");
  const snapshot = await buildAndWriteLatest("2026-08-29", "price operations fixture", {
    coordinator,
    catalog: { schemaVersion: "2.0.0", catalogVersion: "fixture", updatedAt: "2026-08-29", skus: [] },
    quotes: [{
      skuId: "gpu.fixture", platform: "jd", priceCny: 5_000, currency: "CNY", listingUrl: "https://item.jd.com/gpu.html",
      variantLabel: "claim.variant.gpu", evidence: "audited", priceKind: "variant", fetchedAt: "2026-08-29T00:00:00.000Z",
      provenanceId: "observation-gpu",
    }],
  });
  const raw: Omit<ImmutableListingCapture, "contentHash"> = {
    schemaVersion: "listing-capture-v1", listingCaptureId: "capture-gpu", skuId: "gpu.fixture", variantIdentityFactIds: ["claim.variant.gpu"],
    platform: "jd", sellerTier: "unknown", condition: "new", stockStatus: "in_stock", priceCny: 5_000, comparableTotalCny: 5_000,
    invoiceStatus: "unknown", warrantyStatus: "unknown", canonicalUrl: "https://item.jd.com/gpu.html", capturedAt: "2026-08-29T00:00:00.000Z",
  };
  const capture: ImmutableListingCapture = { ...raw, contentHash: await hashContent(raw, { domain: "listing-capture", schemaVersion: "listing-capture-v1" }) };
  const observation: PriceObservation = {
    observationId: "observation-gpu", skuId: capture.skuId, variantIdentityFactIds: capture.variantIdentityFactIds, platform: capture.platform,
    sellerTier: "unknown", sellerTierEvidenceRefs: [], condition: "new", stockStatus: "in_stock", priceCny: 5_000, comparableTotalCny: 5_000,
    invoiceStatus: "unknown", warrantyStatus: "unknown", canonicalUrl: capture.canonicalUrl, listingCaptureId: capture.listingCaptureId, capturedAt: capture.capturedAt,
  };
  const history: PriceHistoryPoint = {
    historyPointId: "history-gpu", skuId: capture.skuId, variantIdentityFactIds: capture.variantIdentityFactIds,
    bucketStart: "2026-08-29T00:00:00.000Z", bucketEnd: "2026-08-30T00:00:00.000Z", timeZone: "Asia/Shanghai",
    policyHash: "a".repeat(64), priceBasis: "comparable_total_cny", condition: "new", region: "CN", currency: "CNY",
    minCny: 5_000, maxCny: 5_000, medianCny: 5_000, sampleCount: 1, sellerCount: 0, platformCounts: { jd: 1 },
    observationIds: [observation.observationId], confidence: "low", snapshotId: snapshot.snapshotId,
  };
  await prices.putListingCapture(capture);
  await prices.putObservation(observation);
  await prices.putHistoryPoint(history);
  await prices.putSchedule({
    scheduleId: "official-refresh-gpu", jobType: "official_update_scan", subjectRef: `price-snapshot:${snapshot.snapshotId}`,
    cadenceSeconds: 86_400, nextRunAt: "2026-08-30T00:00:00.000Z", enabled: true,
  });
  return { root, coordinator, prices, snapshot, observation };
}

describe("U10 price production persistence closure", () => {
  it("keeps capture, observation, history, schedule and snapshot closed through Doctor, backup and restore", async () => {
    const { root, coordinator, snapshot } = await fixture();
    const graph = await createProductionReferenceGraph({ coordinator, now: () => "2026-08-29T12:00:00.000Z" });
    expect(graph.nodes).toEqual(expect.arrayContaining([
      "price-capture:capture-gpu", "price-observation:observation-gpu", "price-history:history-gpu",
      "price-schedule:official-refresh-gpu", `price-snapshot:${snapshot.snapshotId}`,
    ]));
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure"))
      .toMatchObject({ status: "pass" });
    const backup = path.join(root, "prices.backup");
    await createBackup({ coordinator, outputFile: backup, password: "price operations fixture password" });
    await restoreBackup({ coordinator, inputFile: backup, password: "price operations fixture password" });
    await expect(createProductionReferenceGraph({ coordinator, now: () => "2026-08-29T12:00:00.000Z" })).resolves.toMatchObject({ nodes: expect.arrayContaining(["price-history:history-gpu"]) });
  });

  it("rejects a checksum-consistent observation that no longer matches its immutable capture", async () => {
    const { root, coordinator } = await fixture();
    const state = await coordinator.readState();
    const file = path.join(coordinator.activeRoot(state), "prices", "domain", "observations", "observation-gpu.json");
    const original = await readFile(file, "utf8");
    const envelope = JSON.parse(original) as { schemaVersion: string; kind: string; revision: number; payloadHash: string; checksum: string; payload: PriceObservation };
    envelope.payload.priceCny = 4_999;
    envelope.payload.comparableTotalCny = 4_999;
    envelope.payloadHash = sha256Json(envelope.payload);
    envelope.checksum = sha256Json({ schemaVersion: envelope.schemaVersion, kind: envelope.kind, revision: envelope.revision, payloadHash: envelope.payloadHash, payload: envelope.payload });
    await writeFile(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await expect(createProductionReferenceGraph({ coordinator, now: () => "2026-08-29T12:00:00.000Z" })).rejects.toThrow(/observation\/listing capture closure/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.reference_closure"))
      .toMatchObject({ status: "fail" });
  });
});

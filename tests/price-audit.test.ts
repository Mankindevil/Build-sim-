import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuditedQuote, buildAuditedQuoteFromCapture } from "../scripts/price-server/price-audit.mjs";
import { buildAndWriteLatest, isAuditedRow, loadListingCapture, loadLocalQuotes, saveCandidates, upsertLocalQuote } from "../scripts/price-server/store.mjs";
import { restoreLatestRollback } from "../scripts/price-server/store.mjs";
import { applyPriceSnapshot } from "../src/price/merge";
import { isAuditedQuote } from "../src/price/types";
import type { PriceQuote, PriceSnapshotFile } from "../src/price/types";
import type { SkuCatalog } from "../src/sku/types";

const catalog: SkuCatalog = {
  schemaVersion: "2.0.0",
  catalogVersion: "2.0.1",
  updatedAt: "2026-08-23",
  skus: [{
    id: "memory.fixture",
    category: "memory",
    brand: "Fixture",
    model: "Memory G5",
    name: "Fixture Memory G5",
    mpn: "MEM-G5-001",
    dims: { evidence: "official" },
    power: { evidence: "official" },
    price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    provenance: [{
      provenanceId: "sku-prov-1",
      field: "mpn",
      value: "MEM-G5-001",
      evidence: "official",
      sourceUrl: "https://www.asus.com/example",
      sourceKind: "official-page",
      retrievedAt: "2026-08-23T00:00:00.000Z",
      extractor: "fixture",
    }],
  }],
};

function body(variantLabel = "32GB") {
  return {
    skuId: "memory.fixture",
    platform: "jd",
    priceCny: 529,
    priceAmount: 529,
    priceCurrency: "CNY",
    priceKind: "variant",
    variantLabel,
    listingUrl: "https://item.jd.com/g5-fixture.html",
    match: "mpn",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    sourceHash: "fixture-page-hash",
    title: "Fixture Memory G5 MEM-G5-001 32GB",
  };
}

describe("G5 price audit and snapshot provenance", () => {
  it("accepts only a server-issued capture and derives price, source and provenance hashes", () => {
    const capture = {
      schemaVersion: "1.0.0",
      candidateId: "price-candidate-1234567890abcdef1234",
      skuId: "memory.fixture",
      platform: "jd",
      title: "Fixture Memory G5 MEM-G5-001 32GB",
      canonicalUrl: "https://item.jd.com/g5-fixture.html",
      redirectChain: ["https://item.jd.com/g5-fixture.html"],
      fetchedAt: "2026-08-23T00:00:00.000Z",
      variants: [{ skuId: "g5", label: "32GB", amount: 529, currency: "CNY", stock: 1 }],
      source: { priceSource: "api", query: "MEM-G5-001" },
    };
    const request = { listingCaptureId: "listing-capture-1234567890abcdef1234", candidateId: capture.candidateId, skuId: "memory.fixture", variantLabel: "32GB" };
    const valid = buildAuditedQuoteFromCapture(request, catalog, capture);
    expect(valid.priceKind).toBe("variant");
    expect(valid.variantLabel).toBe("32GB");
    expect(valid.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildAuditedQuote()).toThrow(/direct price audit is disabled/);
    expect(() => buildAuditedQuoteFromCapture({ ...request, priceCny: 1 }, catalog, capture)).toThrow(/cannot self-report priceCny/);
    expect(() => buildAuditedQuoteFromCapture({ ...request, variantLabel: "64GB" }, catalog, capture)).toThrow(/selected captured variant/);
    expect(() => buildAuditedQuoteFromCapture(request, catalog, { ...capture, canonicalUrl: "http://item.jd.com/g5" })).toThrow(/HTTPS/);
    expect(() => buildAuditedQuoteFromCapture(request, catalog, { ...capture, canonicalUrl: "https://evil.example/g5", redirectChain: ["https://evil.example/g5"] })).toThrow(/domain/);
    expect(isAuditedRow({ ...valid, evidence: "audited" })).toBe(true);
    expect(isAuditedRow({ ...valid, priceKind: "from" })).toBe(false);
    expect(isAuditedRow({ ...valid, currency: "USD" })).toBe(false);
    expect(isAuditedRow({ ...valid, listingUrl: undefined })).toBe(false);
    expect(isAuditedQuote({ ...valid, priceKind: "from" } as unknown as PriceQuote)).toBe(false);
    expect(isAuditedQuote({ ...valid, currency: "USD" } as unknown as PriceQuote)).toBe(false);
  });

  it("keys local quotes by sku/platform/variant and writes an independently auditable snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-g5-"));
    const localPath = path.join(root, "local-quotes.json");
    const rollbackRoot = path.join(root, "rollback");
    const latestPath = path.join(root, "latest.json");
    const snapshotsDir = path.join(root, "snapshots");
    const auditRoot = path.join(root, "audit");
    const snapshotManifest = path.join(rollbackRoot, "snapshot-manifest.json");
    try {
      await writeFile(localPath, JSON.stringify({ schemaVersion: "1.0.0", quotes: [] }), "utf8");
      const quote = (variantLabel = "32GB") => buildAuditedQuoteFromCapture({ listingCaptureId: "listing-capture-1234567890abcdef1234", candidateId: "price-candidate-1234567890abcdef1234", skuId: "memory.fixture", variantLabel }, catalog, {
        schemaVersion: "1.0.0", candidateId: "price-candidate-1234567890abcdef1234", skuId: "memory.fixture", platform: "jd", title: "Fixture", canonicalUrl: "https://item.jd.com/g5-fixture.html", redirectChain: ["https://item.jd.com/g5-fixture.html"], fetchedAt: "2026-08-23T00:00:00.000Z", variants: [{ skuId: "g5-32", label: "32GB", amount: 529, currency: "CNY" }, { skuId: "g5-64", label: "64GB", amount: 529, currency: "CNY" }], source: {},
      });
      const first = await upsertLocalQuote(quote(), { localPath, rollbackRoot });
      await upsertLocalQuote(quote("64GB"), { localPath, rollbackRoot });
      await upsertLocalQuote(quote(), { localPath, rollbackRoot });
      const local = await loadLocalQuotes({ localPath });
      expect(local).toHaveLength(2);
      expect(local.map((quote: { variantLabel?: string }) => quote.variantLabel)).toEqual(["32GB", "64GB"]);
      expect(first.provenanceId).toMatch(/^price-prov-/);

      const snapshot = await buildAndWriteLatest("2026-08-23", "G5 fixture", {
        catalog,
        quotes: [...local, { ...local[0], priceKind: "from", variantLabel: "" }, { ...local[0], currency: "USD" }],
        latestPath,
        snapshotsDir,
        auditRoot,
        rollbackRoot,
        manifestPath: snapshotManifest,
        auditManifestPath: path.join(rollbackRoot, "audit-manifest.json"),
      }) as PriceSnapshotFile;
      expect(snapshot.schemaVersion).toBe("1.1.0");
      expect(snapshot.snapshotId).toMatch(/^price-snapshot-/);
      expect(snapshot.inputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.catalogVersion).toBe("2.0.1");
      expect(snapshot.quotes).toHaveLength(2);
      expect(snapshot.quotes.every((quote: { provenanceId?: string; variantLabel?: string }) => quote.provenanceId && quote.variantLabel)).toBe(true);
      expect(JSON.parse(await readFile(path.join(auditRoot, "2026-08-23.json"), "utf8")).events).toHaveLength(1);

      const repeated = await buildAndWriteLatest("2026-08-23", "G5 fixture", {
        catalog,
        quotes: local,
        latestPath,
        snapshotsDir,
        auditRoot,
        rollbackRoot,
        manifestPath: snapshotManifest,
        auditManifestPath: path.join(rollbackRoot, "audit-manifest.json"),
      }) as PriceSnapshotFile;
      expect(repeated.snapshotId).toBe(snapshot.snapshotId);
      expect(repeated.contentHash).toBe(snapshot.contentHash);
      expect(JSON.parse(await readFile(path.join(auditRoot, "2026-08-23.json"), "utf8")).events).toHaveLength(1);

      const merged = applyPriceSnapshot(catalog, snapshot);
      const mergedSku = merged.skus[0]!;
      expect(mergedSku.provenance?.[0]?.provenanceId).toBe("sku-prov-1");
      expect(mergedSku.price.provenance?.provenanceId).toBeTruthy();
      expect(mergedSku.price.snapshot?.snapshotId).toBe(snapshot.snapshotId);
      expect(mergedSku.price.snapshot?.variantLabel).toBe("32GB");

      const changed = await buildAndWriteLatest("2026-08-23", "G5 changed", {
        catalog,
        quotes: [{ ...quote(), priceCny: 599, priceAmount: 599 }],
        latestPath,
        snapshotsDir,
        auditRoot,
        rollbackRoot,
        manifestPath: snapshotManifest,
        auditManifestPath: path.join(rollbackRoot, "audit-manifest.json"),
      }) as PriceSnapshotFile;
      expect(changed.contentHash).not.toBe(snapshot.contentHash);
      await restoreLatestRollback(latestPath, { manifestPath: snapshotManifest });
      expect(JSON.parse(await readFile(latestPath, "utf8")).contentHash).toBe(snapshot.contentHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists immutable listing captures outside transient candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-price-capture-"));
    try {
      const saved = await saveCandidates({ candidates: [{ skuId: "memory.fixture", platform: "jd", channel: "jd", title: "Fixture", url: "https://item.jd.com/g5-fixture.html?utm_source=x", fetchedAt: "2026-08-23T00:00:00.000Z", variants: [{ skuId: "g5", label: "32GB", amount: 529, currency: "CNY" }] }] }, "2026-08-23", { runtimeRoot: root });
      const candidate = saved.candidates[0]!;
      const capture = await loadListingCapture(candidate.listingCaptureId, { runtimeRoot: root });
      expect(capture.candidateId).toBe(candidate.candidateId);
      expect(capture.canonicalUrl).not.toContain("utm_");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuditedQuote } from "../scripts/price-server/price-audit.mjs";
import { buildAndWriteLatest, isAuditedRow, loadLocalQuotes, upsertLocalQuote } from "../scripts/price-server/store.mjs";
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
  it("rejects from/foreign/unknown prices and retains variant provenance", () => {
    const valid = buildAuditedQuote(body(), catalog);
    expect(valid.priceKind).toBe("variant");
    expect(valid.variantLabel).toBe("32GB");
    expect(valid.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildAuditedQuote({ ...body(), priceKind: "from", variantLabel: "" }, catalog)).toThrow(/variantLabel/);
    expect(() => buildAuditedQuote({ ...body(), priceCurrency: "USD" }, catalog)).toThrow(/外币/);
    expect(() => buildAuditedQuote({ ...body(), fxAssumed: { rate: 7.2 } }, catalog)).toThrow(/汇率/);
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
      const first = await upsertLocalQuote(buildAuditedQuote(body(), catalog), { localPath, rollbackRoot });
      await upsertLocalQuote(buildAuditedQuote(body("64GB"), catalog), { localPath, rollbackRoot });
      await upsertLocalQuote(buildAuditedQuote(body(), catalog), { localPath, rollbackRoot });
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
        quotes: [buildAuditedQuote({ ...body(), priceCny: 599, priceAmount: 599 }, catalog)],
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
});

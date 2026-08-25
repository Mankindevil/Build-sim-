import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAutoEnrichment } from "../scripts/price-server/catalog/auto-enrichment.mjs";
import { rollbackCatalogAcceptance } from "../scripts/price-server/catalog/write.mjs";

function candidate(stamp: string): any {
  const url = `https://www.asus.com/c5/${stamp}`;
  const contentHash = crypto.createHash("sha256").update(stamp).digest("hex");
  const base = { sourceUrl: url, sourceKind: "official-page", retrievedAt: "2026-08-24T00:00:00.000Z", extractor: "fixture-c5-v1", evidence: "official", confidence: 1 };
  const values: Array<[string, string | number]> = [["brand", "ASUS"], ["model", `C5 ${stamp}`], ["mpn", `C5-${stamp}`], ["dims.lengthMm", 244], ["dims.widthMm", 244]];
  return {
    candidateId: `candidate-${stamp}`, query: { raw: `C5-${stamp}`, brand: "ASUS", mpn: `C5-${stamp}`, category: "motherboard" }, brand: "ASUS", model: `C5 ${stamp}`, mpn: `C5-${stamp}`, category: "motherboard", title: `ASUS C5 ${stamp}`, url, canonicalUrl: url,
    source: { kind: "official", domain: "www.asus.com", retrievedAt: base.retrievedAt, httpStatus: 200, finalUrl: url }, match: { score: 1, kind: "exact-mpn", reasons: ["fixture exact"] },
    extraction: { status: "ok", fieldsFound: values.length, fieldsMissing: 0, adapter: "fixture-c5-v1", contentHash },
    fields: values.map(([field, value], index) => ({ ...base, provenanceId: `prov-${stamp}-${index}`, field, value, locator: `fixture:${field}`, snippet: `${field}: ${value}` })), conflicts: [],
  };
}

describe("C5 trusted exact-MPN auto enrichment", () => {
  it("creates a draft while automatic acceptance is disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-draft-"));
    try {
      const value = candidate(String(Date.now()));
      const result = await runAutoEnrichment(value.candidateId, { candidate: value, autoEnrichTrustedOfficial: true, autoAcceptExactMpn: false, draftRoot: path.join(root, "drafts"), rollbackRoot: path.join(root, "rollback") });
      expect(result.status).toBe("draft");
      expect(result.reasons).toContain("automatic exact-MPN acceptance disabled");
      expect(result.registryVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(result.contentHash).toBe(value.extraction.contentHash);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts idempotently only with every policy/write gate and rolls back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-accept-"));
    const catalogPath = path.join(root, "catalog.json");
    const rollbackRoot = path.join(root, "rollback");
    const rollbackManifestPath = path.join(rollbackRoot, "catalog-manifest.json");
    const auditRoot = path.join(root, "audit");
    const value = candidate(String(Date.now()));
    const empty = { schemaVersion: "2.0.0", catalogVersion: "2.0.0", updatedAt: "2026-08-24", skus: [] };
    try {
      await writeFile(catalogPath, `${JSON.stringify(empty)}\n`, "utf8");
      const options = { candidate: value, autoEnrichTrustedOfficial: true, autoAcceptExactMpn: true, catalogWriteEnabled: true, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot };
      const first = await runAutoEnrichment(value.candidateId, options);
      const repeated = await runAutoEnrichment(value.candidateId, options);
      expect(first.status).toBe("accepted");
      expect(repeated.idempotencyKey).toBe(first.idempotencyKey);
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toHaveLength(1);
      await rollbackCatalogAcceptance(catalogPath, { rollbackManifestPath });
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps incomplete, conflicted and existing-value conflicts out of automatic acceptance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-blocked-"));
    const value = candidate(String(Date.now()));
    value.conflicts = [{ field: "mpn", values: [value.mpn, `${value.mpn}-OTHER`], reason: "fixture conflict" }];
    try {
      const result = await runAutoEnrichment(value.candidateId, { candidate: value, autoEnrichTrustedOfficial: true, autoAcceptExactMpn: true, catalogWriteEnabled: true, catalogPath: path.join(root, "catalog.json"), draftRoot: path.join(root, "drafts"), rollbackRoot: path.join(root, "rollback"), auditRoot: path.join(root, "audit") });
      expect(result.status).toBe("draft");
      expect(result.conflicts).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

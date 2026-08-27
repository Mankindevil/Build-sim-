import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAutoEnrichment } from "../scripts/price-server/catalog/auto-enrichment.mjs";
import { catalogCandidateInputHash } from "../scripts/price-server/catalog/contracts.mjs";
import { confirmDraft, rollbackCatalogAcceptance } from "../scripts/price-server/catalog/write.mjs";

function candidate(stamp: string): any {
  const url = `https://www.asus.com/c5/${stamp}`;
  const contentHash = crypto.createHash("sha256").update(stamp).digest("hex");
  const base = { sourceUrl: url, sourceKind: "official-page", retrievedAt: "2026-08-24T00:00:00.000Z", extractor: "fixture-c5-v1", evidence: "official", confidence: 1 };
  const values: Array<[string, string | number]> = [["brand", "ASUS"], ["model", `C5 ${stamp}`], ["mpn", `C5-${stamp}`], ["dims.lengthMm", 244], ["dims.widthMm", 244]];
  return {
    candidateId: `candidate-${stamp}`,
    query: { raw: `ASUS C5 ${stamp}`, brand: "ASUS", model: `C5 ${stamp}`, mpn: `C5-${stamp}`, category: "motherboard", locale: "zh-CN", tokens: ["asus", "c5", stamp] },
    brand: "ASUS", model: `C5 ${stamp}`, mpn: `C5-${stamp}`, category: "motherboard", title: `ASUS C5 ${stamp}`, url, canonicalUrl: url,
    source: { kind: "official", domain: "www.asus.com", retrievedAt: base.retrievedAt, httpStatus: 200, finalUrl: url },
    official: { trustStatus: "trusted", brand: "ASUS", pageKind: "product", reasons: [] },
    identity: { verdict: "exact", score: 1, criticalMatches: [], criticalConflicts: [], unknowns: [], reasons: ["official MPN exactly matches"], agentReviewRequired: false },
    match: { score: 1, kind: "exact-mpn", reasons: ["fixture exact"] },
    extraction: { status: "ok", fieldsFound: values.length, fieldsMissing: 0, adapter: "fixture-c5-v1", contentHash },
    fields: values.map(([field, value], index) => ({ ...base, provenanceId: `prov-${stamp}-${index}`, field, value, locator: `fixture:${field}`, snippet: `${field}: ${value}` })),
    conflicts: [],
  };
}

function optionsFor(value: any, root: string, extra: Record<string, unknown> = {}) {
  return {
    candidate: value,
    expectedHash: catalogCandidateInputHash(value),
    autoEnrichTrustedOfficial: true,
    draftRoot: path.join(root, "drafts"),
    rollbackRoot: path.join(root, "rollback"),
    ...extra,
  };
}

describe("C5 governed official enrichment", () => {
  it("returns the complete review draft and exposes the master write gate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-draft-"));
    try {
      const value = candidate(String(Date.now()));
      const result = await runAutoEnrichment(value.candidateId, optionsFor(value, root, { catalogWriteEnabled: false }));
      expect(result).toMatchObject({
        status: "draft",
        writeEnabled: false,
        proposed: { category: "motherboard", brand: "ASUS", model: value.model, mpn: value.mpn },
        fields: expect.any(Array),
        conflicts: [],
        missing: [],
        expectedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(result.expectedHash).toBe(result.inputHash);
      expect(result.candidateInputHash).toBe(catalogCandidateInputHash(value));
      expect(result.reasons.join(" ")).toContain("catalog write is disabled");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires the immutable candidate expected hash before creating a draft", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-hash-"));
    try {
      const value = candidate(String(Date.now()));
      const missing = await runAutoEnrichment(value.candidateId, { ...optionsFor(value, root), expectedHash: undefined });
      const mismatch = await runAutoEnrichment(value.candidateId, { ...optionsFor(value, root), expectedHash: "0".repeat(64) });
      expect(missing).toMatchObject({ status: "blocked", reasons: ["candidate expected hash is required"] });
      expect(mismatch).toMatchObject({ status: "blocked", reasons: ["candidate expected hash mismatch"] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("never bypasses review even when the legacy automatic-accept flag is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-confirm-"));
    const catalogPath = path.join(root, "catalog.json");
    const rollbackRoot = path.join(root, "rollback");
    const rollbackManifestPath = path.join(rollbackRoot, "catalog-manifest.json");
    const auditRoot = path.join(root, "audit");
    const value = candidate(String(Date.now()));
    const empty = { schemaVersion: "2.0.0", catalogVersion: "2.0.0", updatedAt: "2026-08-24", skus: [] };
    try {
      await writeFile(catalogPath, `${JSON.stringify(empty)}\n`, "utf8");
      const draft = await runAutoEnrichment(value.candidateId, optionsFor(value, root, { autoAcceptExactMpn: true, catalogWriteEnabled: true, catalogPath, rollbackRoot, rollbackManifestPath, auditRoot }));
      expect(draft.status).toBe("draft");
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toHaveLength(0);

      const confirmed = await confirmDraft(draft.draftId, { approved: true, expectedHash: draft.expectedHash, catalogWriteEnabled: true, catalogPath, draftRoot: path.join(root, "drafts"), rollbackRoot, rollbackManifestPath, auditRoot });
      const repeated = await confirmDraft(draft.draftId, { approved: true, expectedHash: draft.expectedHash, catalogWriteEnabled: true, catalogPath, draftRoot: path.join(root, "drafts"), rollbackRoot, rollbackManifestPath, auditRoot });
      expect(confirmed).toMatchObject({ status: "confirmed", skuId: expect.any(String), sku: { brand: "ASUS", model: value.model } });
      expect(repeated.idempotencyKey).toBe(confirmed.idempotencyKey);
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toHaveLength(1);
      await rollbackCatalogAcceptance(catalogPath, { rollbackManifestPath });
      expect(JSON.parse(await readFile(catalogPath, "utf8")).skus).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not create a draft from conflicting official fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-conflict-"));
    const catalogPath = path.join(root, "catalog.json");
    const value = candidate(String(Date.now()));
    value.conflicts = [{ field: "mpn", values: [value.mpn, `${value.mpn}-OTHER`], reason: "fixture conflict" }];
    try {
      await writeFile(catalogPath, JSON.stringify({ schemaVersion: "2.0.0", updatedAt: "2026-08-24", skus: [] }), "utf8");
      const result = await runAutoEnrichment(value.candidateId, optionsFor(value, root, { catalogWriteEnabled: true, catalogPath, auditRoot: path.join(root, "audit") }));
      expect(result).toMatchObject({ status: "blocked", conflicts: [expect.objectContaining({ field: "mpn" })] });
      expect(result.reasons).toContain("unresolved official field conflict");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not create a draft for non-exact identity or a non-product official page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "build-sim-auto-identity-"));
    try {
      const conflict = candidate(`${Date.now()}-conflict`);
      conflict.identity = { ...conflict.identity, verdict: "conflict", criticalConflicts: [{ field: "generation", input: "v5", candidate: "v4" }], reasons: ["generation conflicts: v5 != v4"] };
      const searchPage = candidate(`${Date.now()}-search`);
      searchPage.official = { ...searchPage.official, pageKind: "search" };
      const conflictResult = await runAutoEnrichment(conflict.candidateId, optionsFor(conflict, root));
      const searchResult = await runAutoEnrichment(searchPage.candidateId, optionsFor(searchPage, root));
      expect(conflictResult.status).toBe("blocked");
      expect(conflictResult.reasons.join(" ")).toContain("identity verdict is conflict");
      expect(searchResult.status).toBe("blocked");
      expect(searchResult.reasons.join(" ")).toContain("expected product/spec/datasheet/support");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

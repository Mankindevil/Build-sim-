import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CATALOG_CONTRACT_VERSION,
  assertDiscoveryResult,
  catalogCandidateInputHash,
  isOfficialFieldProvenance,
} from "../scripts/price-server/catalog/contracts.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/catalog/enrichment-contracts.json", import.meta.url), "utf8"));

describe("C0 official catalog enrichment contracts", () => {
  it("freezes discovery, proposal, renderer and conflict fixtures", () => {
    expect(fixture.schemaVersion).toBe(CATALOG_CONTRACT_VERSION);
    expect(Object.keys(fixture.cases)).toEqual([
      "trustedExactMpn",
      "proposedDomain",
      "misleadingSnippet",
      "dynamicMissingRequired",
      "redirectOutOfRegistry",
      "fieldConflict",
    ]);
  });

  it("keeps search title and snippet out of official fields", () => {
    const discovered = assertDiscoveryResult({
      ...fixture.cases.misleadingSnippet,
      provider: "searxng",
      engine: "fixture",
      retrievedAt: "2026-08-24T00:00:00.000Z",
      rank: 0,
    });
    expect(discovered.snippet).toContain("2000 W");
    expect(discovered).not.toHaveProperty("fields");
    expect(() => assertDiscoveryResult({ ...discovered, fields: [{ field: "power.tdpW", value: 2000 }] })).toThrow(/cannot contain official fields/);
  });

  it("rejects model text and discovery evidence as field provenance", () => {
    const base = { sourceUrl: "https://www.asus.com/example", retrievedAt: "2026-08-24T00:00:00.000Z", extractor: "fixture-v1", locator: "spec row", snippet: "MPN: ASUS-G4-001" };
    expect(isOfficialFieldProvenance({ ...base, sourceKind: "official-page" })).toBe(true);
    expect(isOfficialFieldProvenance({ ...base, sourceKind: "searxng" })).toBe(false);
    expect(isOfficialFieldProvenance({ ...base, sourceKind: "model-text" })).toBe(false);
    expect(isOfficialFieldProvenance({ ...base, sourceKind: "third-party-page" })).toBe(false);
  });

  it("hashes acceptance-relevant query identity as well as extracted evidence", () => {
    const candidate = { candidateId: "candidate-hash", query: { raw: "ASUS Board A", brand: "ASUS", model: "Board A", category: "motherboard" }, category: "motherboard", canonicalUrl: "https://www.asus.com/board-a", source: { kind: "official" }, official: { trustStatus: "trusted", pageKind: "product" }, identity: { verdict: "exact" }, match: { kind: "brand-model" }, extraction: { contentHash: "a".repeat(64) }, fields: [], conflicts: [] };
    expect(catalogCandidateInputHash({ ...candidate, query: { ...candidate.query, model: "Board B" } })).not.toBe(catalogCandidateInputHash(candidate));
    expect(catalogCandidateInputHash({ ...candidate, category: "gpu" })).not.toBe(catalogCandidateInputHash(candidate));
  });
});

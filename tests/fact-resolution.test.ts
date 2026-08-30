import { describe, expect, it } from "vitest";
import { createEvidenceClaim } from "../src/evidence/claims";
import { createConflictSet } from "../src/facts/conflicts";
import { createFactRecord } from "../src/facts/hash";
import { resolveClaimIdentity } from "../src/facts/identity";
import { resolveFactField } from "../src/facts/resolver";
import type { FactRecord } from "../src/facts/contracts";

const digest = (letter: string): string => letter.repeat(64);

async function sourceClaim(value: unknown, options: { authority?: "official" | "third_party"; scope?: "family" | "revision"; revision?: string; region?: string; skuId?: string } = {}) {
  const scope = options.scope ?? "revision";
  const subject = scope === "revision"
    ? { skuId: options.skuId ?? "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: options.revision ?? "A", region: options.region ?? "CN" }
    : { skuId: options.skuId ?? "psu.example", familyId: "psu-family" };
  return createEvidenceClaim({
    schemaVersion: "evidence-claim-v1", subject, scope, fieldId: "psu.pinout", value,
    authority: options.authority ?? "official",
    source: { documentId: `doc-sha256-${digest("a")}`, documentSha256: digest("a"), captureId: `capture-sha256-${digest("b")}`, locator: { page: 1 } },
    retrievedAt: "2026-08-28T00:00:00.000Z", status: "active",
  });
}

async function resolvedFact(id: string, value: unknown, authority: "official" | "third_party" = "official"): Promise<FactRecord> {
  const claim = await sourceClaim(value, { authority });
  return createFactRecord({
    schemaVersion: "fact-record-v1", factId: id,
    subject: { kind: "product", skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN" },
    field: "psu.pinout", value, scope: "revision", authority, safetyClass: "electrical_safety", status: "active",
    evidenceRefs: [claim.claimId], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:01:00.000Z",
  });
}

function context(factId: string, overrides: Record<string, unknown> = {}) {
  return {
    identityResolution: {
      identityResolutionId: "identity", subjectText: "PSU", status: "resolved" as const, scope: "revision" as const,
      resolvedSkuId: "psu.example", candidateSkuIds: ["psu.example"], identityClaimIds: ["claim"], unresolvedFieldIds: [], evaluatedAt: "2026-08-28T00:02:00.000Z",
      resolvedSubject: {
        kind: "product" as const, skuId: "psu.example", familyId: "psu-family", modelId: "psu-model",
        variantId: "psu-variant", revision: "A", region: "CN",
      },
    },
    activeConflictFactIds: new Set<string>(), contentHashVerified: true, evidenceClaimsVerified: true,
    ...overrides,
    factId,
  };
}

describe("U3 fact resolution", () => {
  it("resolves exact official safety facts only with verified identity/evidence/hash closure", async () => {
    const fact = await resolvedFact("fact-official", { connectorFamily: "vendor-12-pin", revision: "A", pinCount: 12, pinMapHash: digest("9") });
    const result = await resolveFactField({ subject: fact.subject, field: fact.field, facts: [fact], conflicts: [], passContextFor: () => context(fact.factId) });
    expect(result).toMatchObject({ status: "resolved", reason: "resolved_verified", value: { connectorFamily: "vendor-12-pin" } });
    const unverified = await resolveFactField({ subject: fact.subject, field: fact.field, facts: [fact], conflicts: [], passContextFor: () => context(fact.factId, { evidenceClaimsVerified: false }) });
    expect(unverified).toMatchObject({ status: "blocked", reason: "insufficient_authority_or_scope" });
  });

  it("never silently picks a value when authorities disagree or an open conflict exists", async () => {
    const official = await resolvedFact("fact-official", { connectorFamily: "official", revision: "A", pinCount: 12, pinMapHash: digest("8") });
    const measured = await resolvedFact("fact-measured", { connectorFamily: "measured", revision: "A", pinCount: 12, pinMapHash: digest("7") }, "third_party");
    const missingConflict = await resolveFactField({ subject: official.subject, field: official.field, facts: [official, measured], conflicts: [], passContextFor: (fact) => context(fact.factId) });
    expect(missingConflict).toMatchObject({ status: "blocked", reason: "conflict_set_required" });
    const conflict = await createConflictSet({
      schemaVersion: "fact-conflict-v1", conflictSetId: "conflict-pinout", subject: official.subject, field: official.field,
      factIds: [official.factId, measured.factId], reason: "official_vs_third_party", status: "open", resolutionFactIds: [], decisionIds: [],
      createdAt: "2026-08-28T00:02:00.000Z",
    });
    const blocked = await resolveFactField({ subject: official.subject, field: official.field, facts: [official, measured], conflicts: [conflict], passContextFor: (fact) => context(fact.factId) });
    expect(blocked).toMatchObject({ status: "blocked", reason: "open_conflict" });
  });

  it("does not let a family claim establish a revision identity or inherit across sibling revisions/regions", async () => {
    const family = await sourceClaim({ connectorFamily: "family", revision: "family", pinCount: 12, pinMapHash: digest("6") }, { scope: "family" });
    const exact = await sourceClaim({ connectorFamily: "revision-a", revision: "A", pinCount: 12, pinMapHash: digest("7") }, { scope: "revision", revision: "A" });
    const sibling = await sourceClaim({ connectorFamily: "revision-b", revision: "B", pinCount: 12, pinMapHash: digest("8") }, { scope: "revision", revision: "B" });
    const familyOnly = await resolveClaimIdentity({ subjectText: "PSU family", scope: "revision", claims: [family], expectedSkuId: "psu.example", expectedRevision: "A", expectedRegion: "CN", evaluatedAt: "2026-08-28T00:03:00.000Z" });
    expect(familyOnly.status).toBe("unresolved");
    const exactResolution = await resolveClaimIdentity({ subjectText: "PSU A", scope: "revision", claims: [family, exact, sibling], expectedSkuId: "psu.example", expectedRevision: "A", expectedRegion: "CN", evaluatedAt: "2026-08-28T00:03:00.000Z" });
    expect(exactResolution).toMatchObject({ status: "resolved", resolvedSkuId: "psu.example", scope: "revision" });
    expect(exactResolution.identityClaimIds).toEqual([exact.claimId]);
  });

  it("keeps same-SKU regional claims ambiguous until the region is selected", async () => {
    const cn = await sourceClaim({ connectorFamily: "cn", revision: "A", pinCount: 12, pinMapHash: digest("1") }, { revision: "A", region: "CN" });
    const us = await sourceClaim({ connectorFamily: "us", revision: "A", pinCount: 12, pinMapHash: digest("2") }, { revision: "A", region: "US" });
    const ambiguous = await resolveClaimIdentity({
      subjectText: "PSU revision A", scope: "revision", claims: [cn, us], expectedSkuId: "psu.example",
      expectedRevision: "A", evaluatedAt: "2026-08-28T00:03:00.000Z",
    });
    expect(ambiguous).toMatchObject({ status: "ambiguous", candidateSkuIds: ["psu.example"] });
    expect(ambiguous.unresolvedFieldIds).toContain("region");
  });

  it("resolves identity only from effective, non-superseded claims", async () => {
    const old = await sourceClaim({ connectorFamily: "old", revision: "A", pinCount: 12, pinMapHash: digest("3") }, { revision: "A", region: "CN" });
    const replacement = await createEvidenceClaim({
      ...old,
      claimId: undefined,
      contentHash: undefined,
      value: { connectorFamily: "new", revision: "A", pinCount: 12, pinMapHash: digest("4") },
      source: { ...old.source, locator: { page: 2, section: "Replacement" } },
      supersedesClaimId: old.claimId,
      supersededClaimHash: old.contentHash,
    } as never);
    const future = await createEvidenceClaim({
      ...old,
      claimId: undefined,
      contentHash: undefined,
      source: { ...old.source, locator: { page: 3, section: "Future" } },
      validFrom: "2026-08-28T02:00:00.000Z",
    } as never);
    const resolved = await resolveClaimIdentity({
      subjectText: "PSU revision A CN", scope: "revision", claims: [old, replacement, future], expectedSkuId: "psu.example",
      expectedRevision: "A", expectedRegion: "CN", evaluatedAt: "2026-08-28T01:00:00.000Z",
    });
    expect(resolved).toMatchObject({ status: "resolved", identityClaimIds: [replacement.claimId] });
    const unavailable = await resolveClaimIdentity({
      subjectText: "PSU revision A CN", scope: "revision", claims: [future], expectedSkuId: "psu.example",
      expectedRevision: "A", expectedRegion: "CN", evaluatedAt: "2026-08-28T01:00:00.000Z",
    });
    expect(unavailable).toMatchObject({ status: "unresolved", identityClaimIds: [] });
  });

  it("does not pretend a family shared by multiple SKUs identifies one variant", async () => {
    const first = await sourceClaim({ connectorFamily: "family", revision: "family", pinCount: 12, pinMapHash: digest("5") }, { scope: "family", skuId: "psu.variant-a" });
    const second = await sourceClaim({ connectorFamily: "family", revision: "family", pinCount: 12, pinMapHash: digest("6") }, { scope: "family", skuId: "psu.variant-b" });
    const resolution = await resolveClaimIdentity({
      subjectText: "PSU family", scope: "family", claims: [first, second], evaluatedAt: "2026-08-28T01:00:00.000Z",
    });
    expect(resolution).toMatchObject({ status: "ambiguous", candidateSkuIds: ["psu.variant-a", "psu.variant-b"] });
    expect(resolution.unresolvedFieldIds).toContain("skuId");
  });
});

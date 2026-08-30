import { describe, expect, it } from "vitest";
import { canFactAloneSupportSafetyPass, validateFactRecord, type FactRecord } from "../src/facts/contracts";
import { factFieldPolicy } from "../src/facts/field-registry";

const digest = (character: string): string => character.repeat(64);

function electricalFact(): FactRecord {
  return {
    schemaVersion: "fact-record-v1",
    factId: "fact-psu-pinout",
    subject: {
      kind: "product", skuId: "psu.example", familyId: "psu-family", modelId: "psu-model",
      variantId: "psu-variant", revision: "A", region: "CN",
    },
    field: "psu.pinout",
    value: { connectorFamily: "vendor-12-pin", revision: "A", pinCount: 12, pinMapHash: digest("9") },
    scope: "revision",
    authority: "official",
    safetyClass: "electrical_safety",
    status: "active",
    evidenceRefs: [`claim-sha256-${digest("b")}`],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-28T00:00:00.000Z",
    contentHash: digest("a"),
  };
}

const context = {
  identityResolution: {
    identityResolutionId: "identity-psu", subjectText: "Example PSU", status: "resolved" as const, scope: "revision" as const,
    resolvedSkuId: "psu.example", candidateSkuIds: ["psu.example"], identityClaimIds: ["claim"], unresolvedFieldIds: [],
    resolvedSubject: {
      kind: "product" as const, skuId: "psu.example", familyId: "psu-family", modelId: "psu-model",
      variantId: "psu-variant", revision: "A", region: "CN",
    },
    evaluatedAt: "2026-08-28T00:00:00.000Z",
  },
  activeConflictFactIds: new Set<string>(),
  contentHashVerified: true,
  evidenceClaimsVerified: true,
};

describe("U3 governed fact field policy", () => {
  it("derives electrical safety and source policy instead of trusting the caller", () => {
    expect(factFieldPolicy("psu.pinout")).toMatchObject({ safetyClass: "electrical_safety", sourcePolicy: "official_required" });
    expect(validateFactRecord(electricalFact())).toEqual([]);
    expect(validateFactRecord({ ...electricalFact(), safetyClass: "normal" })).toContain("fact safetyClass must be derived from field policy");
    expect(validateFactRecord({ ...electricalFact(), authority: "user_observation", subject: { kind: "plan_subject", planId: "plan", subjectRef: { kind: "instance", instanceId: "psu" } }, scope: "plan_subject", evidenceRefs: [`observation:psu@sha256:${digest("c")}`] })).toEqual(expect.arrayContaining([
      "fact scope is not allowed by field policy",
      "field policy forbids user observation authority",
    ]));
  });

  it("rejects ungoverned fields, wrong units/scopes, malformed time, and non-canonical values", () => {
    expect(validateFactRecord({ ...electricalFact(), field: "free.form" })).toContain("fact field is not governed");
    expect(validateFactRecord({ ...electricalFact(), unit: "mm" })).toContain("fact unit does not match field policy");
    expect(validateFactRecord({ ...electricalFact(), scope: "family" })).toContain("fact scope is not allowed by field policy");
    expect(validateFactRecord({ ...electricalFact(), retrievedAt: "today" })).toContain("fact retrievedAt invalid");
    expect(validateFactRecord({ ...electricalFact(), value: { connectorFamily: "cafe\u0301", revision: "A", pinCount: 12, pinMapHash: digest("9") } })).toContain("fact value must be finite canonical JSON");
    expect(validateFactRecord({ ...electricalFact(), value: "\ud800" })).toContain("fact value must be finite canonical JSON");
  });

  it("requires repository-verified hashes, evidence closure, exact identity, and no active conflict before a pass", () => {
    expect(canFactAloneSupportSafetyPass(electricalFact(), context)).toBe(true);
    expect(canFactAloneSupportSafetyPass(electricalFact(), { ...context, contentHashVerified: false })).toBe(false);
    expect(canFactAloneSupportSafetyPass(electricalFact(), { ...context, evidenceClaimsVerified: false })).toBe(false);
    expect(canFactAloneSupportSafetyPass(electricalFact(), { ...context, activeConflictFactIds: new Set([electricalFact().factId]) })).toBe(false);
    expect(canFactAloneSupportSafetyPass(electricalFact(), { ...context, identityResolution: { ...context.identityResolution, resolvedSkuId: "psu.sibling" } })).toBe(false);
    expect(canFactAloneSupportSafetyPass(electricalFact(), {
      ...context,
      identityResolution: { ...context.identityResolution, resolvedSubject: { ...context.identityResolution.resolvedSubject, revision: "B" } },
    })).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...electricalFact(), validUntil: "2026-08-27T23:59:59.000Z" }, context)).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...electricalFact(), validFrom: "2026-08-28T00:00:01.000Z" }, context)).toBe(false);
  });
});

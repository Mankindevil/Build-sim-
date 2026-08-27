import { describe, expect, it } from "vitest";
import {
  canFactAloneSupportSafetyPass,
  validateConflictSet,
  validateFactRecord,
  validateFactSnapshot,
  validateIdentityResolution,
  validateInferenceTrace,
  validateUpdateDecision,
  type FactRecord,
  type UpdateDecision,
} from "../src/facts/contracts";

const digest = (character = "a"): string => character.repeat(64);

const productFact = (): FactRecord => ({
  factId: "fact", subject: { kind: "product", skuId: "psu" }, field: "psu.pinout", value: "vendor-family-a", scope: "variant", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: ["manual"], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-27T00:00:00.000Z",
});
const exactContext = (conflicts: string[] = []) => ({
  identityResolution: {
    identityResolutionId: "identity", subjectText: "psu", status: "resolved" as const, scope: "variant" as const,
    resolvedSkuId: "psu", candidateSkuIds: ["psu"], identityClaimIds: ["claim"], unresolvedFieldIds: [], evaluatedAt: "2026-08-27T00:00:00.000Z",
  },
  activeConflictFactIds: new Set(conflicts),
});

describe("U0 fact resolution contracts", () => {
  it("prevents plan observations becoming global SKU facts or inference greening electrical safety", () => {
    expect(validateFactRecord(productFact())).toEqual([]);
    expect(validateFactRecord({ ...productFact(), authority: "user_observation" })).toContain("user observation cannot become a global product fact");
    const inferred = { ...productFact(), authority: "agent_inference" as const, derivedFromFactIds: ["input"], extractorOrRuleVersion: "model-1", assumptions: [] };
    expect(validateFactRecord(inferred)).toEqual([]);
    expect(canFactAloneSupportSafetyPass(inferred)).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), value: "unknown" })).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), evidenceRefs: [] })).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), scope: "family", safetyClass: "compatibility_critical" })).toBe(false);
    expect(canFactAloneSupportSafetyPass(productFact())).toBe(false);
    expect(canFactAloneSupportSafetyPass(productFact(), exactContext())).toBe(true);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), authority: "third_party" }, exactContext())).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), confidence: 0.94 }, exactContext())).toBe(false);
    expect(canFactAloneSupportSafetyPass(productFact(), exactContext(["fact"]))).toBe(false);
    expect(canFactAloneSupportSafetyPass(productFact(), { ...exactContext(), identityResolution: { ...exactContext().identityResolution, scope: "model" } })).toBe(false);
  });

  it("requires user observations to remain plan-subject scoped and rejects nested/unknown fields", () => {
    const planFact: FactRecord = {
      ...productFact(),
      factId: "plan-fact",
      subject: { kind: "plan_subject", planId: "plan-a", subjectRef: { kind: "port", instanceId: "board", portId: "eps" } },
      scope: "plan_subject",
      authority: "user_observation",
      safetyClass: "normal",
    };
    expect(validateFactRecord(planFact)).toEqual([]);
    expect(validateFactRecord({ ...planFact, scope: "variant" })).toEqual(expect.arrayContaining([
      "plan subject facts must use plan_subject scope",
      "user observation facts must be plan_subject scoped",
    ]));
    expect(validateFactRecord({ ...planFact, subject: { ...planFact.subject, leaked: true } })).toContain("plan subject invalid");
    expect(validateFactRecord({ ...planFact, unexpected: true })).toContain("fact contains unknown fields");
  });

  it("accepts family identity scope and enforces replacement direction", () => {
    expect(validateIdentityResolution({
      identityResolutionId: "family", subjectText: "Ryzen 7000", status: "resolved", scope: "family",
      resolvedSkuId: "family-am5", candidateSkuIds: ["family-am5"], identityClaimIds: ["claim"], unresolvedFieldIds: [], evaluatedAt: "2026-08-27T00:00:00.000Z",
    })).toEqual([]);
    expect(validateFactRecord({ ...productFact(), status: "superseded", supersedesFactId: "older" })).toContain("only an active replacement fact may declare supersedesFactId");
    expect(validateFactRecord({ ...productFact(), factId: "same", supersedesFactId: "same" })).toContain("fact cannot supersede itself");
    expect(validateFactRecord({ ...productFact(), supersedesFactId: "older" })).toEqual([]);
  });

  it("freezes accept/reject/defer/undo and strict snapshot hashes", () => {
    const decision: UpdateDecision = {
      updateDecisionId: "decision", subjectKey: "sku", claimKey: "field", revision: "2", oldFactIds: ["old"], newFactIds: ["new"],
      fieldDiffs: [{ field: "dimension", beforeFactIds: ["old"], afterFactIds: ["new"] }], affectedDomains: ["mechanical"],
      decision: "undo", decidedBy: "user", decidedAt: "2026-08-27T00:00:00.000Z", safetyWarningRetained: true,
    };
    expect(validateUpdateDecision(decision)).toEqual([]);
    expect(validateUpdateDecision({ ...decision, decision: "revoke" } as unknown as UpdateDecision)).toContain("update decision invalid");
    expect(validateUpdateDecision({ ...decision, fieldDiffs: [{ ...decision.fieldDiffs[0], executable: "true" }] })).toContain("update decision fieldDiffs.0 invalid");
    expect(validateFactSnapshot({ schemaVersion: "fact-snapshot-v1", snapshotId: "snapshot", factIds: ["fact"], conflictSetIds: [], createdAt: "2026-08-27T00:00:00.000Z", contentHash: digest() })).toEqual([]);
    expect(validateFactSnapshot({ schemaVersion: "fact-snapshot-v1", snapshotId: "snapshot", factIds: [], conflictSetIds: [], createdAt: "now", contentHash: "not-a-hash", injected: true })).toEqual(expect.arrayContaining([
      "fact snapshot contains unknown fields",
      "fact snapshot contentHash must be sha256",
    ]));
  });

  it("retains unresolved conflicts and replayable inference invalidation", () => {
    expect(validateConflictSet({ conflictSetId: "conflict", subject: { kind: "product", skuId: "disk" }, field: "recording", factIds: ["official", "measurement"], reason: "official_vs_third_party", status: "open", resolutionFactIds: [], decisionIds: [], createdAt: "2026-08-27T00:00:00.000Z" })).toEqual([]);
    expect(validateInferenceTrace({ inferenceTraceId: "inference", inputFactIds: ["dimension"], outputFactIds: ["clearance"], engine: "rule", ruleOrModelId: "clearance", ruleOrModelVersion: "1", assumptions: ["orthogonal"], confidence: 0.8, outputRange: { min: 2, max: 4, unit: "mm" }, invalidationConditions: ["placement changes"], createdAt: "2026-08-27T00:00:00.000Z" })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  canFactAloneSupportSafetyPass,
  validateConflictSet,
  validateFactRecord,
  validateLegacyFactRecord,
  validateFactSnapshot,
  validateLegacyFactSnapshot,
  validateIdentityResolution,
  validateInferenceTrace,
  validateUpdateDecision,
  type FactRecord,
  type UpdateDecision,
} from "../src/facts/contracts";
import { createFactRecord, verifyFactRecord } from "../src/facts/hash";

const digest = (character = "a"): string => character.repeat(64);

const productFact = (): FactRecord => ({
  schemaVersion: "fact-record-v1", factId: "fact", subject: {
    kind: "product", skuId: "psu", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN",
  }, field: "psu.pinout", value: { connectorFamily: "vendor-family-a", revision: "A", pinCount: 12, pinMapHash: digest("9") }, scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [`claim-sha256-${digest("b")}`], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-27T00:00:00.000Z", contentHash: digest(),
});
const exactContext = (conflicts: string[] = []) => ({
  identityResolution: {
    identityResolutionId: "identity", subjectText: "psu", status: "resolved" as const, scope: "revision" as const,
    resolvedSkuId: "psu", candidateSkuIds: ["psu"], identityClaimIds: ["claim"], unresolvedFieldIds: [], evaluatedAt: "2026-08-27T00:00:00.000Z",
    resolvedSubject: {
      kind: "product" as const, skuId: "psu", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN",
    },
  },
  activeConflictFactIds: new Set(conflicts),
  contentHashVerified: true,
  evidenceClaimsVerified: true,
});

describe("U0 fact resolution contracts", () => {
  it("prevents plan observations becoming global SKU facts or inference greening electrical safety", () => {
    expect(validateFactRecord(productFact())).toEqual([]);
    expect(validateFactRecord({ ...productFact(), authority: "user_observation" })).toContain("user observation cannot become a global product fact");
    const inferred = { ...productFact(), authority: "agent_inference" as const, evidenceRefs: [], derivedFromFactIds: ["input"], inferenceTraceId: `inference-sha256-${digest("c")}`, extractorOrRuleVersion: "model-1", assumptions: [] };
    expect(validateFactRecord(inferred)).toEqual([]);
    expect(canFactAloneSupportSafetyPass(inferred)).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), value: "unknown" })).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), evidenceRefs: [] })).toBe(false);
    expect(canFactAloneSupportSafetyPass({ ...productFact(), scope: "family" })).toBe(false);
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
      field: "physical.clearance",
      value: 4,
      unit: "mm",
      safetyClass: "compatibility_critical",
      evidenceRefs: [`observation:clearance@sha256:${digest("c")}`],
    };
    expect(validateFactRecord(planFact)).toEqual([]);
    expect(validateFactRecord({ ...planFact, scope: "variant" })).toEqual(expect.arrayContaining([
      "plan subject facts must use plan_subject scope",
      "fact scope is not allowed by field policy",
    ]));
    expect(validateFactRecord({ ...planFact, subject: { ...planFact.subject, leaked: true } })).toContain("plan subject invalid");
    expect(validateFactRecord({ ...planFact, unexpected: true })).toContain("fact contains unknown fields");
  });

  it("accepts family identity scope and enforces replacement direction", () => {
    expect(validateIdentityResolution({
      identityResolutionId: "family", subjectText: "Ryzen 7000", status: "resolved", scope: "family",
      resolvedSkuId: "family-am5", candidateSkuIds: ["family-am5"], identityClaimIds: ["claim"], unresolvedFieldIds: [], evaluatedAt: "2026-08-27T00:00:00.000Z",
      resolvedSubject: { kind: "product", skuId: "family-am5", familyId: "family-am5" },
    })).toEqual([]);
    expect(validateFactRecord({ ...productFact(), status: "superseded", supersedesFactId: "older", supersededFactHash: digest("d") })).toContain("only an active replacement fact may declare supersession");
    expect(validateFactRecord({ ...productFact(), factId: "same", supersedesFactId: "same", supersededFactHash: digest("d") })).toContain("fact cannot supersede itself");
    expect(validateFactRecord({ ...productFact(), supersedesFactId: "older" })).toContain("replacement fact requires old fact ID and hash");
    expect(validateFactRecord({ ...productFact(), supersedesFactId: "older", supersededFactHash: digest("d") })).toEqual([]);
  });

  it("keeps U0 records behind an explicit compatibility validator and hashes governed records", async () => {
    const legacy = {
      factId: "legacy", subject: { kind: "product", skuId: "sku" }, field: "identity", value: "legacy",
      scope: "variant", authority: "third_party", safetyClass: "normal", status: "active", evidenceRefs: ["fixture://legacy"],
      derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(validateLegacyFactRecord(legacy)).toEqual([]);
    expect(validateFactRecord(legacy)).toEqual(expect.arrayContaining(["fact schemaVersion invalid", "fact field is not governed", "fact contentHash invalid"]));

    const { contentHash: _contentHash, ...input } = productFact();
    const created = await createFactRecord(input);
    expect(await verifyFactRecord(created)).toBe(true);
    expect(await verifyFactRecord({ ...created, value: { family: "tampered" } })).toBe(false);
  });

  it("freezes accept/reject/defer/undo and strict snapshot hashes", () => {
    const decision: UpdateDecision = {
      schemaVersion: "fact-update-decision-v1", updateDecisionId: `update-decision-sha256-${digest("9")}`, subjectKey: "sku", claimKey: "field", revision: "2", memoryRevision: 1, planIds: ["plan-a"],
      oldSnapshotRef: { snapshotId: `fact-snapshot-sha256-${digest("1")}`, contentHash: digest("1") }, newSnapshotRef: { snapshotId: `fact-snapshot-sha256-${digest("2")}`, contentHash: digest("2") }, oldFactIds: ["old"], newFactIds: ["new"],
      fieldDiffs: [{ field: "dimension", beforeFactIds: ["old"], afterFactIds: ["new"] }], affectedDomains: ["mechanical"],
      decision: "undo", decidedBy: "user", decidedAt: "2026-08-27T00:00:00.000Z", supersedesDecisionId: `update-decision-sha256-${digest("8")}`, supersedesDecisionHash: digest("8"), safetyWarningRetained: true, contentHash: digest("9"),
    };
    expect(validateUpdateDecision(decision)).toEqual([]);
    expect(validateUpdateDecision({ ...decision, decision: "revoke" } as unknown as UpdateDecision)).toContain("update decision invalid");
    expect(validateUpdateDecision({ ...decision, fieldDiffs: [{ ...decision.fieldDiffs[0], executable: "true" }] })).toContain("update decision fieldDiffs.0 invalid");
    expect(validateLegacyFactSnapshot({ schemaVersion: "fact-snapshot-v1", snapshotId: "snapshot", factIds: ["fact"], conflictSetIds: [], createdAt: "2026-08-27T00:00:00.000Z", contentHash: digest() })).toEqual([]);
    expect(validateLegacyFactSnapshot({ schemaVersion: "fact-snapshot-v1", snapshotId: "snapshot", factIds: [], conflictSetIds: [], createdAt: "now", contentHash: "not-a-hash", injected: true })).toEqual(expect.arrayContaining([
      "fact snapshot contains unknown fields",
      "fact snapshot contentHash must be sha256",
    ]));
    expect(validateFactSnapshot({ schemaVersion: "fact-snapshot-v2", snapshotId: `fact-snapshot-sha256-${digest("e")}`, factRefs: [{ factId: "fact", contentHash: digest("a") }], conflictRefs: [], createdAt: "2026-08-27T00:00:00.000Z", contentHash: digest("e") })).toEqual([]);
  });

  it("retains unresolved conflicts and replayable inference invalidation", () => {
    expect(validateConflictSet({ schemaVersion: "fact-conflict-v1", conflictSetId: "conflict", subject: { kind: "product", skuId: "disk" }, field: "storage.recording_technology", factIds: ["official", "measurement"], reason: "official_vs_third_party", status: "open", resolutionFactIds: [], decisionIds: [], createdAt: "2026-08-27T00:00:00.000Z", contentHash: digest("f") })).toEqual([]);
    expect(validateInferenceTrace({ inferenceTraceId: "inference", inputFactIds: ["dimension"], outputFactIds: ["clearance"], engine: "rule", ruleOrModelId: "clearance", ruleOrModelVersion: "1", assumptions: ["orthogonal"], confidence: 0.8, outputRange: { min: 2, max: 4, unit: "mm" }, invalidationConditions: ["placement changes"], createdAt: "2026-08-27T00:00:00.000Z" })).toEqual([]);
  });
});

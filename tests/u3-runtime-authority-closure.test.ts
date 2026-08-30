import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { AttachmentRepository } from "../src/attachments/repository";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { EvidenceClaimRepository } from "../src/evidence/claim-repository";
import { createEvidenceClaim } from "../src/evidence/claims";
import type { EvidenceClaim } from "../src/evidence/contracts";
import { evidenceRepositoryChecksumRuntime, validateEvidenceClaimRuntime } from "../src/evidence/claim-runtime.mjs";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { createConflictSet } from "../src/facts/conflicts";
import { FACT_FIELD_POLICY_REGISTRY } from "../src/facts/field-registry";
import { createFactRecord } from "../src/facts/hash";
import type { FactRecord } from "../src/facts/contracts";
import { createReplayableInferenceTrace } from "../src/facts/inference-policy";
import { FactRepository, LEGACY_INFERENCE_IMPORT_CAPABILITY } from "../src/facts/repository";
import { factSubjectKey } from "../src/facts/resolver";
import { createFactSnapshot } from "../src/facts/snapshots";
import { UpdateDecisionRepository } from "../src/facts/update-decision-repository";
import { createUpdateDecision } from "../src/facts/update-decisions";
import { createFactUpdateEvaluationDiff } from "../src/facts/update-evaluation";
import { createFactUpdateNotice } from "../src/facts/update-notices";
import { FACT_FIELD_POLICY_RUNTIME, legacySha256Runtime, validateFactRecordRuntime } from "../src/facts/canonical-runtime.mjs";
import { ARTIFACT_LOCK_ROLES, createArtifactLockfile, createContentAddressedRef, createLockedArtifactRef, hashContent, type ArtifactLockEntries } from "../src/hash";
import { hashPlanConfig } from "../src/plans/canonical";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { authoritativeEvaluationHash } from "../src/plans/evaluation";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { EvaluationLockRepository } from "../src/plans/evaluation-lock-repository";
import { OBSERVATION_FIELD_REGISTRY } from "../src/contracts/registries";
import { ObservationRepository } from "../src/observations/repository";
import { OBSERVATION_FIELD_RUNTIME, validateUserObservationRuntime, validateUserObservationSnapshotRuntime } from "../src/observations/canonical-runtime.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, readJson, sha256Json } from "../src/runtime/fs.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { migrateFactsV1, planFactsV1Migration, rollbackFactsV1 } from "../scripts/migrations/migrate-facts-v1.mjs";

const roots: string[] = [];
const now = () => "2026-08-28T00:10:00.000Z";
const digest = (letter: string) => letter.repeat(64);

function withMigrationManifestHash(material: Record<string, unknown>) {
  return { ...material, manifestHash: sha256Json(material) };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function evidenceMetadata(identity: Record<string, string> = {}) {
  return {
    mediaType: "application/pdf", kind: "manufacturer-manual", title: "Runtime authority fixture",
    productIdentities: [{
      brand: "Fixture", model: "PSU", category: "psu", skuId: "psu.runtime", basis: "official-document-explicit",
      familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN", ...identity,
    }],
    capture: {
      acquisitionMethod: "official-fetch", requestedUrl: "https://fixture.example/psu", finalUrl: "https://fixture.example/psu.pdf",
      canonicalUrl: "https://fixture.example/psu.pdf", retrievedAt: now(), status: 200, redirects: [], officialBrand: "Fixture",
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-u3-runtime-authority-")); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now }); await coordinator.initialize("test");
  const plans = new FilePlanRepository({ coordinator, now, id: () => "plan-u3-runtime" });
  await plans.create({ name: "U3 runtime authority", config: createDefaultN6Config("draft", now()) });
  const evidence = new FileEvidenceRepository({ coordinator });
  const imported = await evidence.importBuffer(Buffer.from("official runtime authority bytes"), evidenceMetadata());
  const claims = new EvidenceClaimRepository({ coordinator, evidence });
  const subject = { skuId: "psu.runtime", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN" };
  const officialClaim = await createEvidenceClaim({
    schemaVersion: "evidence-claim-v1", subject, scope: "revision", fieldId: "psu.pinout", value: { connectorFamily: "vendor-12", revision: "A", pinCount: 12, pinMapHash: digest("c") }, authority: "official",
    source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 1, field: "fixture.psu.pinout", section: "Pinout" } },
    retrievedAt: now(), status: "active",
  });
  const secondOfficialClaim = await createEvidenceClaim({
    schemaVersion: "evidence-claim-v1", subject, scope: "revision", fieldId: "psu.pinout", value: { connectorFamily: "vendor-12-second-source", revision: "A", pinCount: 12, pinMapHash: digest("d") }, authority: "official",
    source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 2, field: "fixture.psu.pinout.second", section: "Independent measurement" } },
    retrievedAt: now(), status: "active",
  });
  const capacityOldClaim = await createEvidenceClaim({
    schemaVersion: "evidence-claim-v1", subject, scope: "revision", fieldId: "psu.capacity", value: 750, unit: "w", authority: "official",
    source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 1, field: "fixture.psu.capacity.old", section: "Rated power" } },
    retrievedAt: now(), status: "active",
  });
  const capacityNewClaim = await createEvidenceClaim({
    schemaVersion: "evidence-claim-v1", subject, scope: "revision", fieldId: "psu.capacity", value: 850, unit: "w", authority: "official",
    source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 1, field: "fixture.psu.capacity.new", section: "Rated power" } },
    retrievedAt: now(), status: "active",
  });

  const attachments = new AttachmentRepository({ coordinator, now });
  const observationContext = {
    planId: "plan-u3-runtime", subjectExists: true, currentConfigHash: digest("a"), currentSubjectRevisionHash: digest("b"),
  };
  const observations = new ObservationRepository({
    coordinator, now, attachments: {
      hasAvailable: (attachmentId, planId) => attachments.hasAvailable(attachmentId, planId),
      hasAvailableAtRoot: (activeRoot, attachmentId, planId) => attachments.hasAvailableAtRoot(activeRoot, attachmentId, planId),
    },
    projectionContextForObservation: () => observationContext,
  });
  const observationBase = {
    observationId: "observation-clearance", planId: observationContext.planId, subjectRef: { kind: "placement" as const, placementId: "gpu-slot" },
    fieldId: "physical.clearance" as const, value: 4, unit: "mm" as const, uncertainty: { plusMinus: 0.5 }, method: "measurement" as const,
    attachmentRefs: [], confirmedByUser: true, observedAgainstConfigHash: observationContext.currentConfigHash,
    subjectRevisionHash: observationContext.currentSubjectRevisionHash, capturedAt: "2026-08-28T00:00:00.000Z",
    validatedAt: "2026-08-28T00:01:00.000Z", status: "active" as const,
  };
  const observation = { ...observationBase, contentHash: legacySha256Runtime(observationBase)! };
  await observations.put({ observation });
  const observationSnapshot = await observations.createSnapshot(observation.planId);

  let decisions!: UpdateDecisionRepository;
  const facts = new FactRepository({
    coordinator, evidenceClaims: claims, observations,
    acceptedUpdateDecisions: {
      getActiveDecision: (decisionId) => decisions.getActiveDecision(decisionId),
      getActiveDecisionAtRoot: (activeRoot, decisionId) => decisions.getActiveDecisionAtRoot(activeRoot, decisionId),
    },
    currentInferenceArtifactHash: (trace) => trace.ruleOrModelArtifactHash,
  });
  const artifacts = new FileArtifactRepository({ coordinator, now });
  const inferenceArtifact = await artifacts.put({
    bytes: Buffer.from("u3-runtime-clearance-rule-v1"), mediaType: "application/json",
    privacyClass: "runtime_internal", kind: "inference-rule", references: [], createdAt: now(),
  });
  const factSubject = { kind: "product" as const, skuId: subject.skuId, familyId: subject.familyId, modelId: subject.modelId, variantId: subject.variantId, revision: subject.revision, region: subject.region };
  const officialFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-pinout-official", subject: factSubject, field: "psu.pinout", value: officialClaim.value,
    scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [officialClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(),
  });
  const secondOfficialFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-pinout-second-official", subject: factSubject, field: "psu.pinout", value: secondOfficialClaim.value,
    scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [secondOfficialClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(),
  });
  // Keep the two conflicting official sources current for the open
  // conflict fixture. The update-decision pair uses a separate governed field
  // so this open conflict remains an exact complete current group.
  const decisionOldFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-capacity-decision-old", subject: factSubject, field: "psu.capacity", value: capacityOldClaim.value, unit: "w",
    scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [capacityOldClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(),
  });
  const decisionNewFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-capacity-decision-new", subject: factSubject, field: "psu.capacity", value: capacityNewClaim.value, unit: "w",
    scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [capacityNewClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(), supersedesFactId: decisionOldFact.factId, supersededFactHash: decisionOldFact.contentHash,
  });
  const migratedClaims = [officialClaim, secondOfficialClaim, capacityOldClaim, capacityNewClaim];
  const migratedFacts = [officialFact, secondOfficialFact, decisionOldFact, decisionNewFact];
  const manuals = [{ file: "data/runtime-authority-fixture.pdf", sha256: imported.document.sha256 }];
  const formal = migratedClaims.map((claim) => ({
    constraintId: String(claim.source.locator.field),
    fieldId: claim.fieldId,
    ...(claim.unit === undefined ? {} : { unit: claim.unit }),
    valueHash: sha256Json(claim.value),
    sourceFile: "references/runtime-authority-fixture.pdf",
    page: Number(claim.source.locator.page),
    skuId: subject.skuId,
  }));
  const catalogHash = digest("f"); const constraintsHash = digest("e");
  const sourceHash = sha256Json({ catalogHash, constraintsHash, manuals });
  const planHash = sha256Json({
    schemaVersion: "catalog-facts-v1-plan", migrationId: "catalog-facts-v1", sourceHash, catalogHash, constraintsHash,
    manuals, formal, legacyUnverified: [],
  });
  const migrationManifest = withMigrationManifestHash({
    schemaVersion: "catalog-facts-v1-manifest", migrationId: "catalog-facts-v1", status: "applied",
    sourceHash, planHash, catalogHash, constraintsHash, manuals, formal, legacyUnverified: [],
    claims: migratedClaims.map((claim) => ({
      claimId: claim.claimId,
      contentHash: claim.contentHash,
      documentId: claim.source.documentId,
      captureId: claim.source.captureId,
    })).sort((left, right) => left.claimId.localeCompare(right.claimId)),
    facts: migratedFacts.map((fact, index) => ({
      factId: fact.factId,
      contentHash: fact.contentHash,
      claimId: migratedClaims[index]!.claimId,
    })).sort((left, right) => left.factId.localeCompare(right.factId)),
    appliedAt: now(),
  });
  const writeMigratedClaim = (activeRoot: string, claim: EvidenceClaim) => atomicWriteJson(
    confined(activeRoot, "evidence", "claims", claim.contentHash.slice(0, 2), `${claim.claimId}.json`),
    { schemaVersion: "evidence-claim-envelope-v1", kind: "evidence-claim", checksum: sha256Json(claim), payload: claim },
  );
  const writeMigratedFact = (activeRoot: string, fact: FactRecord) => {
    const payload = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(fact), fact };
    return atomicWriteJson(
      confined(activeRoot, "facts", "records", `${fact.factId}.json`),
      { schemaVersion: "fact-repository-envelope-v1", kind: "fact", checksum: sha256Json(payload), payload },
    );
  };
  await coordinator.withWrite(async ({ activeRoot: writeRoot }: { activeRoot: string }) => {
    for (const claim of migratedClaims) await writeMigratedClaim(writeRoot, claim);
    for (const fact of [officialFact, secondOfficialFact, decisionOldFact]) await writeMigratedFact(writeRoot, fact);
  });
  const observationFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-clearance-observation", subject: { kind: "plan_subject", planId: observation.planId, subjectRef: observation.subjectRef },
    field: "physical.clearance", value: 4, unit: "mm", scope: "plan_subject", authority: "user_observation", safetyClass: "compatibility_critical", status: "active",
    evidenceRefs: [`observation:${observation.observationId}@sha256:${observation.contentHash}`], derivedFromFactIds: [], confidence: 1, retrievedAt: now(),
  });
  const conflict = await createConflictSet({
    schemaVersion: "fact-conflict-v1", conflictSetId: "conflict-pinout-runtime", subject: factSubject, field: "psu.pinout",
    factIds: [officialFact.factId, secondOfficialFact.factId], reason: "official_internal", status: "open", resolutionFactIds: [], decisionIds: [], createdAt: now(),
  });
  await facts.putConflict({ conflict });
  const oldFactSnapshot = await facts.createSnapshot({ factIds: [decisionOldFact.factId] });
  await coordinator.withWrite(async ({ activeRoot: writeRoot }: { activeRoot: string }) => {
    await writeMigratedFact(writeRoot, decisionNewFact);
    await atomicWriteJson(confined(writeRoot, "migrations", "catalog-facts-v1", "manifest.json"), migrationManifest);
  });
  const decisionFactSnapshot = await facts.createSnapshot({ factIds: [decisionNewFact.factId] });
  decisions = new UpdateDecisionRepository({ coordinator, snapshots: facts, now });
  const updateDecision = await createUpdateDecision({
    schemaVersion: "fact-update-decision-v1", subjectKey: factSubjectKey(factSubject), claimKey: "psu.capacity", revision: "A", memoryRevision: 0,
    planIds: [observation.planId], oldSnapshotRef: { snapshotId: oldFactSnapshot.snapshotId, contentHash: oldFactSnapshot.contentHash },
    newSnapshotRef: { snapshotId: decisionFactSnapshot.snapshotId, contentHash: decisionFactSnapshot.contentHash }, oldFactIds: [decisionOldFact.factId], newFactIds: [decisionNewFact.factId],
    fieldDiffs: [{ field: "psu.capacity", beforeFactIds: [decisionOldFact.factId], afterFactIds: [decisionNewFact.factId] }], affectedDomains: ["electrical"],
    decision: "reject", decidedBy: "user", decidedAt: now(), safetyWarningRetained: true,
  });
  await decisions.putDecision({ decision: updateDecision, expectedMemoryRevision: -1 });
  await facts.putFact({ fact: observationFact });
  const inferenceTrace = await createReplayableInferenceTrace({
    schemaVersion: "fact-inference-v1", inputFactRefs: [{ factId: observationFact.factId, contentHash: observationFact.contentHash }], outputFactIds: ["fact-clearance-inference"],
    engine: "rule", ruleOrModelId: "clearance-runtime-rule", ruleOrModelVersion: "1.0.0", ruleOrModelArtifactHash: inferenceArtifact.record.sha256,
    assumptions: ["fixture placement fixed"], confidence: 0.9, invalidationConditions: ["input fact changes"], createdAt: now(),
  });
  const inferredFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-clearance-inference", subject: { kind: "plan_subject", planId: observation.planId, subjectRef: observation.subjectRef },
    field: "physical.clearance", value: 4, unit: "mm", scope: "plan_subject", authority: "agent_inference", safetyClass: "compatibility_critical", status: "active",
    evidenceRefs: [], derivedFromFactIds: [observationFact.factId], inferenceTraceId: inferenceTrace.inferenceTraceId,
    extractorOrRuleVersion: inferenceTrace.ruleOrModelVersion, assumptions: inferenceTrace.assumptions, confidence: 0.9, retrievedAt: now(),
  });
  const legacyInferenceLease = await coordinator.acquireMaintenanceLease("u3-legacy-inference-fixture");
  try {
    await facts.putInferenceTrace({
      trace: inferenceTrace,
      legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
      maintenanceLeaseToken: legacyInferenceLease.token,
    });
    await facts.putLegacyInferenceFact({
      fact: inferredFact,
      legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
      maintenanceLeaseToken: legacyInferenceLease.token,
    });
  } finally {
    await coordinator.releaseMaintenanceLease(legacyInferenceLease.token);
  }
  // This is the current authoritative snapshot used by the graph fixture. It
  // intentionally contains the complete pinned open conflict, unlike the
  // narrow before/after decision snapshots above.
  const factSnapshot = await facts.createSnapshot();
  const state = await coordinator.readState(); const activeRoot = coordinator.activeRoot(state);
  return {
    root, coordinator, activeRoot, officialFact, officialClaim, evidenceCapture: imported.capture, observation, observationSnapshot, factSnapshot,
    inferenceTrace, inferredFact, inferenceArtifact, updateDecision, migrationManifest, subject, facts, claims, observationFact, decisionNewFact,
  };
}

async function writeChecksumValidSiblingIdentityClaim(
  value: Awaited<ReturnType<typeof fixture>>,
  identity: Record<string, string>,
) {
  const evidence = new FileEvidenceRepository({ coordinator: value.coordinator, now });
  const imported = await evidence.importBuffer(Buffer.from(`sibling identity ${JSON.stringify(identity)}`), evidenceMetadata(identity));
  const claim = await createEvidenceClaim({
    schemaVersion: "evidence-claim-v1", subject: value.subject, scope: "revision", fieldId: "psu.pinout",
    value: { connectorFamily: "sibling-identity", revision: "A", pinCount: 12, pinMapHash: digest("a") }, authority: "official",
    source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 1, section: "Pinout" } },
    retrievedAt: now(), status: "active",
  });
  await value.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    await atomicWriteJson(confined(activeRoot, "evidence", "claims", claim.contentHash.slice(0, 2), `${claim.claimId}.json`), {
      schemaVersion: "evidence-claim-envelope-v1", kind: "evidence-claim", checksum: sha256Json(claim), payload: claim,
    });
  });
}

async function appendCatalogMigrationAuthority(
  value: Awaited<ReturnType<typeof fixture>>,
  claim: EvidenceClaim,
  fact: FactRecord,
) {
  await value.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    const manifestFile = confined(activeRoot, "migrations", "catalog-facts-v1", "manifest.json");
    const current = await readJson(manifestFile) as Record<string, unknown> & {
      formal: Array<Record<string, unknown>>;
      claims: Array<Record<string, unknown>>;
      facts: Array<Record<string, unknown>>;
      manuals: unknown[];
      legacyUnverified: unknown[];
      sourceHash: string;
      catalogHash: string;
      constraintsHash: string;
    };
    await atomicWriteJson(confined(activeRoot, "evidence", "claims", claim.contentHash.slice(0, 2), `${claim.claimId}.json`), {
      schemaVersion: "evidence-claim-envelope-v1",
      kind: "evidence-claim",
      checksum: sha256Json(claim),
      payload: claim,
    });
    const factPayload = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(fact), fact };
    await atomicWriteJson(confined(activeRoot, "facts", "records", `${fact.factId}.json`), {
      schemaVersion: "fact-repository-envelope-v1",
      kind: "fact",
      checksum: sha256Json(factPayload),
      payload: factPayload,
    });
    const formalEntry = {
      constraintId: String(claim.source.locator.field),
      fieldId: claim.fieldId,
      ...(claim.unit === undefined ? {} : { unit: claim.unit }),
      valueHash: sha256Json(claim.value),
      sourceFile: "references/runtime-authority-fixture.pdf",
      page: Number(claim.source.locator.page),
      skuId: claim.subject.skuId,
    };
    const formal = [...current.formal, formalEntry]
      .sort((left, right) => `${left.constraintId}\0${left.fieldId}`.localeCompare(`${right.constraintId}\0${right.fieldId}`));
    const claims = [...current.claims, {
      claimId: claim.claimId,
      contentHash: claim.contentHash,
      documentId: claim.source.documentId,
      captureId: claim.source.captureId,
    }].sort((left, right) => String(left.claimId).localeCompare(String(right.claimId)));
    const facts = [...current.facts, {
      factId: fact.factId,
      contentHash: fact.contentHash,
      claimId: claim.claimId,
    }].sort((left, right) => String(left.factId).localeCompare(String(right.factId)));
    const planHash = sha256Json({
      schemaVersion: "catalog-facts-v1-plan",
      migrationId: "catalog-facts-v1",
      sourceHash: current.sourceHash,
      catalogHash: current.catalogHash,
      constraintsHash: current.constraintsHash,
      manuals: current.manuals,
      formal,
      legacyUnverified: current.legacyUnverified,
    });
    const material = {
      ...current,
      planHash,
      formal,
      claims,
      facts,
    };
    delete (material as { manifestHash?: unknown }).manifestHash;
    await atomicWriteJson(manifestFile, { ...material, manifestHash: sha256Json(material) });
  });
}

async function writeChecksumValidForgedCapture(
  value: Awaited<ReturnType<typeof fixture>>,
  mutate: (capture: Record<string, unknown>) => void,
) {
  const source = confined(value.activeRoot, "evidence", "captures", value.evidenceCapture.id.slice("capture-sha256-".length, "capture-sha256-".length + 2), `${value.evidenceCapture.id}.json`);
  const envelope = await readJson(source);
  const capture = structuredClone(envelope.payload) as Record<string, unknown>;
  mutate(capture);
  const material = structuredClone(capture); delete material.id;
  const captureHash = evidenceRepositoryChecksumRuntime(material);
  if (!captureHash) throw new Error("fixture capture hash unexpectedly failed");
  capture.id = `capture-sha256-${captureHash}`;
  const checksum = evidenceRepositoryChecksumRuntime(capture);
  if (!checksum) throw new Error("fixture capture envelope checksum unexpectedly failed");
  await atomicWriteJson(confined(value.activeRoot, "evidence", "captures", captureHash.slice(0, 2), `${capture.id}.json`), {
    schemaVersion: "1.0.0", kind: "evidence-capture", checksum, payload: capture,
  });
}

async function writeChecksumValidDroppedRegionFact(value: Awaited<ReturnType<typeof fixture>>) {
  const subject = {
    kind: "product" as const, skuId: value.subject.skuId, familyId: value.subject.familyId,
    modelId: value.subject.modelId, variantId: value.subject.variantId, revision: value.subject.revision,
  };
  const fact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-pinout-dropped-region", subject, field: "psu.pinout", value: value.officialClaim.value,
    scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [value.officialClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(),
  });
  const stored = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(fact), fact };
  await atomicWriteJson(confined(value.activeRoot, "facts", "records", `${fact.factId}.json`), {
    schemaVersion: "fact-repository-envelope-v1", kind: "fact", checksum: sha256Json(stored), payload: stored,
  });
}

/**
 * A self-hashed snapshot can omit an otherwise valid open conflict.  The
 * repository writer prevents this; this helper models a checksum-correct
 * out-of-band tamper so the production graph, backup, Doctor and restore
 * staging gates all exercise their independent closure check.
 */
async function writeChecksumValidConflictOmissionSnapshot(
  value: Awaited<ReturnType<typeof fixture>>,
  activeRoot = value.activeRoot,
) {
  const source = value.factSnapshot;
  const forged = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2", factRefs: source.factRefs, conflictRefs: [], createdAt: source.createdAt,
  });
  await atomicWriteJson(confined(activeRoot, "facts", "snapshots", `${forged.snapshotId}.json`), {
    schemaVersion: "fact-repository-envelope-v1", kind: "snapshot", checksum: sha256Json(forged), payload: forged,
  });
  return forged;
}

async function writeChecksumValidPartialConflictMembershipSnapshot(value: Awaited<ReturnType<typeof fixture>>) {
  const duplicate = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-pinout-official-duplicate", subject: value.officialFact.subject,
    field: value.officialFact.field, value: value.officialFact.value, scope: value.officialFact.scope,
    authority: "official", safetyClass: value.officialFact.safetyClass, status: "active", evidenceRefs: [value.officialClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(),
  });
  const stored = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(duplicate), fact: duplicate };
  await atomicWriteJson(confined(value.activeRoot, "facts", "records", `${duplicate.factId}.json`), {
    schemaVersion: "fact-repository-envelope-v1", kind: "fact", checksum: sha256Json(stored), payload: stored,
  });
  const forged = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: [...value.factSnapshot.factRefs, { factId: duplicate.factId, contentHash: duplicate.contentHash }],
    conflictRefs: value.factSnapshot.conflictRefs, createdAt: value.factSnapshot.createdAt,
  });
  await atomicWriteJson(confined(value.activeRoot, "facts", "snapshots", `${forged.snapshotId}.json`), {
    schemaVersion: "fact-repository-envelope-v1", kind: "snapshot", checksum: sha256Json(forged), payload: forged,
  });
  return forged;
}

async function writeChecksumValidAttachmentObservation(
  value: Awaited<ReturnType<typeof fixture>>,
  attachmentId: string,
  observationId: string,
) {
  const base = {
    observationId, planId: value.observation.planId,
    subjectRef: { kind: "instance" as const, instanceId: "gpu-runtime-instance" },
    fieldId: "physical.component_length" as const, value: 300, unit: "mm" as const,
    uncertainty: { plusMinus: 1 }, method: "photo" as const, attachmentRefs: [attachmentId], confirmedByUser: true,
    observedAgainstConfigHash: digest("a"), subjectRevisionHash: digest("b"), capturedAt: "2026-08-28T00:00:00.000Z",
    validatedAt: "2026-08-28T00:01:00.000Z", status: "active" as const,
  };
  const observation = { ...base, contentHash: legacySha256Runtime(base)! };
  const stored = { schemaVersion: "observation-repository-v1", revision: 0, recordHash: legacySha256Runtime(observation)!, observation };
  await atomicWriteJson(confined(value.activeRoot, "observations", "plans", observation.planId, "records", `${observationId}.json`), {
    schemaVersion: "observation-repository-v1", kind: "observation", checksum: legacySha256Runtime(stored), payload: stored,
  });
  return observation;
}

async function writeResolvedConflict(
  value: Awaited<ReturnType<typeof fixture>>,
  options: { revision: number; resolutionFactIds: string[]; decisionIds: string[] },
) {
  const file = confined(value.activeRoot, "facts", "conflicts", "conflict-pinout-runtime.json");
  const envelope = await readJson(file);
  const { contentHash: _ignored, ...input } = envelope.payload.conflict;
  const conflict = await createConflictSet({
    ...input, status: "resolved", resolutionFactIds: options.resolutionFactIds, decisionIds: options.decisionIds, resolvedAt: now(),
  });
  const stored = { ...envelope.payload, revision: options.revision, recordHash: sha256Json(conflict), conflict };
  await atomicWriteJson(file, {
    schemaVersion: "fact-repository-envelope-v1", kind: "conflict", checksum: sha256Json(stored), payload: stored,
  });
  await atomicWriteJson(confined(value.activeRoot, "facts", "conflict-versions", `${conflict.contentHash}.json`), {
    schemaVersion: "fact-repository-envelope-v1", kind: "conflict", checksum: sha256Json(stored), payload: stored,
  });
}

async function writeFactUpdateNotice(value: Awaited<ReturnType<typeof fixture>>) {
  const oldFact = await value.facts.getFact(value.updateDecision.oldFactIds[0]!);
  const newFact = await value.facts.getFact(value.updateDecision.newFactIds[0]!);
  const notice = createFactUpdateNotice({
    planId: value.updateDecision.planIds[0]!,
    target: { kind: "draft", expectedDraftRevision: 0, expectedConfigHash: digest("a") },
    subjectKey: value.updateDecision.subjectKey,
    claimKey: value.updateDecision.claimKey,
    revision: value.updateDecision.revision,
    expectedMemoryRevision: 0,
    memoryRevision: 1,
    previousDecisionRef: {
      updateDecisionId: value.updateDecision.updateDecisionId,
      contentHash: value.updateDecision.contentHash,
    },
    oldSnapshotRef: value.updateDecision.oldSnapshotRef,
    newSnapshotRef: value.updateDecision.newSnapshotRef,
    oldFactRefs: [{ factId: oldFact.factId, contentHash: oldFact.contentHash }],
    newFactRefs: [{ factId: newFact.factId, contentHash: newFact.contentHash }],
    affectedDomains: ["electrical"],
    createdAt: now(),
  });
  const decisions = new UpdateDecisionRepository({ coordinator: value.coordinator, snapshots: value.facts, now });
  await decisions.putNotice(notice);
  return notice;
}

async function writeAcceptedPlanPointer(
  value: Awaited<ReturnType<typeof fixture>>,
  options: { crashAfterPointer?: boolean; lifecycleConflict?: boolean; crashAfterConflictPointer?: boolean } = {},
) {
  const planId = "plan-u3-accept";
  const plans = new FilePlanRepository({ coordinator: value.coordinator, now, id: () => planId });
  const plan = await plans.create({ name: "U3 accepted pointer", config: createDefaultN6Config("draft", now()) });
  const subject = { kind: "product" as const, ...value.subject };
  const claim = async (valueHash: string, section: string) => createEvidenceClaim({
    schemaVersion: "evidence-claim-v1", subject: value.subject, scope: "revision", fieldId: "psu.pinout",
    value: { connectorFamily: "accepted-vendor-12", revision: "A", pinCount: 12, pinMapHash: valueHash }, authority: "official",
    source: { ...value.officialClaim.source, locator: { page: 3, field: `fixture.psu.pinout.${valueHash.slice(0, 8)}`, section } }, retrievedAt: now(), status: "active",
  });
  const oldClaim = await claim(digest("1"), "Accepted old pinout");
  const newClaim = await claim(digest("2"), "Accepted new pinout");
  const oldFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-pinout-accept-old", subject, field: "psu.pinout", value: oldClaim.value,
    scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [oldClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(),
  });
  const newFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-pinout-accept-new", subject, field: "psu.pinout", value: newClaim.value,
    scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active", evidenceRefs: [newClaim.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: now(), supersedesFactId: oldFact.factId, supersededFactHash: oldFact.contentHash,
  });
  // Pin each decision side independently. The pre-existing pinout conflict
  // remains complete in the current snapshot, while neither narrow decision
  // snapshot selects a partial conflict group.
  await appendCatalogMigrationAuthority(value, oldClaim, oldFact);
  const oldSnapshot = await value.facts.createSnapshot({ factIds: [oldFact.factId] });
  await appendCatalogMigrationAuthority(value, newClaim, newFact);
  const newSnapshot = await value.facts.createSnapshot({ factIds: [newFact.factId] });
  const lifecycleConflict = options.lifecycleConflict ? await createConflictSet({
    schemaVersion: "fact-conflict-v1", conflictSetId: "conflict-update-lifecycle-runtime", subject, field: "psu.pinout",
    factIds: [oldFact.factId, newFact.factId], reason: "revision", status: "open", resolutionFactIds: [], decisionIds: [],
    createdAt: now(),
  }) : undefined;
  if (lifecycleConflict) await value.facts.putConflict({ conflict: lifecycleConflict });
  const decision = await createUpdateDecision({
    schemaVersion: "fact-update-decision-v1", subjectKey: factSubjectKey(subject), claimKey: "psu.pinout", revision: "A", memoryRevision: 0,
    planIds: [planId], oldSnapshotRef: { snapshotId: oldSnapshot.snapshotId, contentHash: oldSnapshot.contentHash },
    newSnapshotRef: { snapshotId: newSnapshot.snapshotId, contentHash: newSnapshot.contentHash }, oldFactIds: [oldFact.factId], newFactIds: [newFact.factId],
    fieldDiffs: [{ field: "psu.pinout", beforeFactIds: [oldFact.factId], afterFactIds: [newFact.factId] }], affectedDomains: ["electrical"],
    decision: "accept", decidedBy: "user", decidedAt: now(), safetyWarningRetained: false,
  });
  // Persist the same complete EvaluationLockRepository closure that production
  // accepts.  Update-diff receipts cannot manufacture a lock node: the graph
  // must resolve each lock, artifact payload, external snapshot, receipt and
  // current pointer from /snapshots.
  const acceptedObservations = new ObservationRepository({
    coordinator: value.coordinator, now,
    attachments: { hasAvailable: async () => true, hasAvailableAtRoot: async () => true },
  });
  const acceptedObservationSnapshot = await acceptedObservations.createSnapshot(planId);
  const locks = new EvaluationLockRepository({
    coordinator: value.coordinator, facts: value.facts, observations: acceptedObservations,
    verifyArtifact: () => false, verifyArtifactAtRoot: () => false,
    verifyExternalSnapshotHashes: () => false, verifyExternalSnapshotHashesAtRoot: () => false,
    verifyFactSnapshotClosureAtRoot: async (activeRoot, snapshotId, expectedHash) => {
      const closure = await value.facts.getSnapshotClosureAtRoot(activeRoot, snapshotId);
      return closure?.snapshot.contentHash === expectedHash;
    },
    verifyObservationSnapshotClosureAtRoot: async (activeRoot, ownerPlanId, snapshotId, expectedConfigHash, expectedHash) => {
      const snapshot = await acceptedObservations.getSnapshotAtRoot(activeRoot, ownerPlanId, snapshotId);
      return snapshot?.contentHash === expectedHash
        && await acceptedObservations.verifySnapshotClosureAtRoot(activeRoot, ownerPlanId, snapshotId, expectedConfigHash);
    },
  });
  const artifactInputs = Object.fromEntries(await Promise.all(ARTIFACT_LOCK_ROLES.map(async (role) => {
    const kebabRole = role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const payload = { schemaVersion: "u3-runtime-evaluation-artifact-v1", role, version: 1 };
    const ref = await createLockedArtifactRef(payload, role, `${role}-u3-runtime`, `application/vnd.buildsim.${kebabRole}+json`, {
      domain: `artifact.${kebabRole}`, schemaVersion: "1.0.0",
    });
    return [role, { ref, payload }] as const;
  }))) as Record<(typeof ARTIFACT_LOCK_ROLES)[number], { ref: Awaited<ReturnType<typeof createLockedArtifactRef>>; payload: unknown }>;
  const artifactLockfile = await createArtifactLockfile(Object.fromEntries(
    Object.entries(artifactInputs).map(([role, input]) => [role, input.ref]),
  ) as ArtifactLockEntries);
  const requirementPayload = { requirementSpecId: "u3-runtime-requirements", schemaVersion: "1.0.0", workloads: [], constraints: [] };
  const requirementSnapshot = {
    ref: await createContentAddressedRef(requirementPayload, { domain: "requirement-spec", schemaVersion: "1.0.0" }), payload: requirementPayload,
  };
  const artifactExternal = async (artifactId: string, mediaType: string) => {
    const base = { schemaVersion: "artifact-payload-v1" as const, artifactId, mediaType, payload: { fixture: "u3-runtime-authority" } };
    const contentHash = await hashContent(base, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
    const payload = { ...base, contentHash };
    return {
      ref: await createContentAddressedRef(payload, { domain: "artifact", schemaVersion: "artifact-payload-v1" }), payload,
    };
  };
  const priceSnapshot = await artifactExternal("u3-runtime-price", "application/vnd.buildsim.price-snapshot+json");
  const simulationInput = await artifactExternal("u3-runtime-simulation", "application/vnd.buildsim.sourced-simulation-input+json");
  const configHash = await hashPlanConfig(plan.draft.config);
  const issued = new Map<string, { evaluationHash: string; evaluationLock: Awaited<ReturnType<typeof createPlanEvaluationLock>> }>();
  await value.coordinator.withWrite(async ({ activeRoot, state }: { activeRoot: string; state: { runtimeGeneration: number } }) => {
    for (const input of Object.values(artifactInputs)) await locks.putArtifactPayloadAtRoot(activeRoot, input);
    await locks.putArtifactLockfileAtRoot(activeRoot, artifactLockfile);
    await locks.putExternalSnapshotAtRoot(activeRoot, "requirementSpec", requirementSnapshot);
    await locks.putExternalSnapshotAtRoot(activeRoot, "priceSnapshot", priceSnapshot);
    await locks.putExternalSnapshotAtRoot(activeRoot, "simulationInput", simulationInput);
    for (const [index, snapshot] of [oldSnapshot, newSnapshot].entries()) {
      const snapshotHashes = {
        configHash, requirementSpecHash: requirementSnapshot.ref.contentHash, factSnapshotHash: snapshot.contentHash,
        userObservationSnapshotHash: acceptedObservationSnapshot.contentHash, priceSnapshotHash: priceSnapshot.ref.contentHash,
        ruleSetHash: artifactLockfile.artifacts.ruleSet.contentHash, systemProfileHash: artifactLockfile.artifacts.systemProfile.contentHash,
        adapterSnapshotHash: artifactLockfile.artifacts.adapterSnapshot.contentHash, engineHash: artifactLockfile.artifacts.engine.contentHash,
        simulationModelHash: artifactLockfile.artifacts.simulationModel.contentHash, simulationInputHash: simulationInput.ref.contentHash,
      };
      const evaluationLock = await createPlanEvaluationLock({
        planId, snapshotHashes, factSnapshotId: snapshot.snapshotId, userObservationSnapshotId: acceptedObservationSnapshot.snapshotId,
        artifactLockfileHash: artifactLockfile.lockfileHash,
      });
      await locks.putEvaluationLockAtRoot(activeRoot, evaluationLock);
      const evaluation = { fixture: "u3-runtime-authority", factSnapshotId: snapshot.snapshotId } as never;
      const evaluationHash = await authoritativeEvaluationHash(evaluation, evaluationLock);
      await locks.commitAtRoot(activeRoot, {
        schemaVersion: "authoritative-evaluation-receipt-v1", planId, target: { kind: "draft", draftRevision: plan.draftRevision },
        runtimeGeneration: state.runtimeGeneration, preparedRevision: index, committedRevision: index + 1,
        configHash, evaluationHash, evaluationLock, evaluatedAt: now(), evaluation,
        catalogVersion: "u3-runtime-catalog", priceSnapshotVersion: "u3-runtime-price", cacheStatus: "miss",
      });
      issued.set(snapshot.snapshotId, { evaluationHash, evaluationLock });
    }
  });
  const receipt = (snapshot: typeof oldSnapshot, domainHash: string) => {
    const issuedSnapshot = issued.get(snapshot.snapshotId);
    if (!issuedSnapshot) throw new Error("fixture evaluation authority was not issued");
    return {
      schemaVersion: "fact-update-snapshot-evaluation-receipt-v1" as const, planId, target: { kind: "draft" as const, draftRevision: plan.draftRevision },
      runtimeGeneration: 1,
      configHash, factSnapshotId: snapshot.snapshotId, factSnapshotHash: snapshot.contentHash,
      evaluationHash: issuedSnapshot.evaluationHash, evaluationLock: issuedSnapshot.evaluationLock, domainHashes: { electrical: domainHash },
    };
  };
  const diff = await createFactUpdateEvaluationDiff({
    updateDecisionId: decision.updateDecisionId, updateDecisionHash: decision.contentHash, planId,
    before: receipt(oldSnapshot, digest("e")), after: receipt(newSnapshot, digest("0")),
    changedDomains: ["electrical"], fieldDiffs: [{ field: "psu.pinout", beforeFactIds: [oldFact.factId], afterFactIds: [newFact.factId] }],
  });
  const decisions = options.crashAfterPointer || options.crashAfterConflictPointer
    ? new UpdateDecisionRepository({ coordinator: value.coordinator, snapshots: value.facts, now, failureInjector: (point) => {
      if (options.crashAfterPointer && point === "after_plan_pointer") throw new Error("fixture crash after plan pointer");
      if (options.crashAfterConflictPointer && point === "after_conflict_pointer") throw new Error("fixture crash after conflict pointer");
    } })
    : new UpdateDecisionRepository({ coordinator: value.coordinator, snapshots: value.facts, now });
  const commit = decisions.putDecision({ decision, expectedMemoryRevision: -1, evaluationDiffs: [diff] });
  if (options.crashAfterPointer) await expect(commit).rejects.toThrow(/fixture crash after plan pointer/);
  else if (options.crashAfterConflictPointer) await expect(commit).rejects.toThrow(/fixture crash after conflict pointer/);
  else await commit;
  return { planId, decision, diff, oldSnapshot, newSnapshot, oldFact, newFact, lifecycleConflict };
}

describe("U3 runtime authority closure", () => {
  it("locks runtime mirrors to the TypeScript governed field registries", () => {
    expect(FACT_FIELD_POLICY_RUNTIME).toEqual(FACT_FIELD_POLICY_REGISTRY);
    expect(OBSERVATION_FIELD_RUNTIME).toEqual(OBSERVATION_FIELD_REGISTRY);
  });

  it("keeps hostile authority inputs total and rejects unknown fields without a throw", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const cases: Array<[string, (value: unknown) => string[], unknown]> = [
      ["fact", validateFactRecordRuntime, { schemaVersion: "fact-record-v1", self: cyclic }],
      ["claim", validateEvidenceClaimRuntime, { schemaVersion: "evidence-claim-v1", forged: true }],
      ["observation", validateUserObservationRuntime, ["not-an-observation"]],
      ["observation snapshot", validateUserObservationSnapshotRuntime, { schemaVersion: "user-observation-snapshot-v1", forged: true }],
    ];
    for (const [label, validate, value] of cases) {
      expect(() => validate(value), label).not.toThrow();
      expect(validate(value), label).not.toHaveLength(0);
    }
  });

  it("creates graph edges from facts and snapshots through claims, observations, and conflicts", async () => {
    const value = await fixture();
    const graph = await createProductionReferenceGraph({ coordinator: value.coordinator, now });
    const conflictVersionRef = `fact-conflict-version:conflict-pinout-runtime@sha256:${value.factSnapshot.conflictRefs[0]!.contentHash}`;
    expect(graph.edges).toEqual(expect.arrayContaining([
      { fromRef: `fact:${value.officialFact.factId}`, toRef: `evidence-claim:${value.officialClaim.claimId}`, necessity: "required_for_replay" },
      { fromRef: "fact:fact-clearance-observation", toRef: `observation:${value.observation.observationId}`, necessity: "required_for_replay" },
      { fromRef: `fact-snapshot:${value.factSnapshot.snapshotId}`, toRef: `fact:${value.officialFact.factId}`, necessity: "required_for_replay" },
      { fromRef: `fact-snapshot:${value.factSnapshot.snapshotId}`, toRef: conflictVersionRef, necessity: "required_for_replay" },
      { fromRef: "fact-conflict:conflict-pinout-runtime", toRef: conflictVersionRef, necessity: "required_for_replay" },
      { fromRef: `observation-snapshot:${value.observationSnapshot.snapshotId}`, toRef: `observation:${value.observation.observationId}`, necessity: "required_for_replay" },
      { fromRef: `fact:${value.inferredFact.factId}`, toRef: `fact-inference:${value.inferenceTrace.inferenceTraceId}`, necessity: "required_for_replay" },
      { fromRef: `fact-inference:${value.inferenceTrace.inferenceTraceId}`, toRef: "fact:fact-clearance-observation", necessity: "required_for_replay" },
      { fromRef: `fact-inference:${value.inferenceTrace.inferenceTraceId}`, toRef: value.inferenceArtifact.record.ref, necessity: "required_for_replay" },
      { fromRef: `fact-update-decision:${value.updateDecision.updateDecisionId}`, toRef: `fact-snapshot:${value.updateDecision.newSnapshotRef.snapshotId}`, necessity: "required_for_replay" },
      { fromRef: "migration:catalog-facts-v1", toRef: `fact:${value.officialFact.factId}`, necessity: "required_for_replay" },
      { fromRef: "migration:catalog-facts-v1", toRef: `evidence-claim:${value.officialClaim.claimId}`, necessity: "required_for_replay" },
    ]));
  });

  it("accepts the exact catalog-facts migration writer output as production authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-u3-catalog-facts-migration-")); roots.push(root);
    const plan = await planFactsV1Migration();
    const applied = await migrateFactsV1({ dryRun: false, expectedSourceHash: plan.sourceHash, runtimeRoot: root, now });
    const coordinator = new RuntimeCoordinator({ root, now });
    const graph = await createProductionReferenceGraph({ coordinator, now });
    expect(graph.nodes).toEqual(expect.arrayContaining([
      "migration:catalog-facts-v1",
      ...applied.manifest.facts.map((fact: { factId: string }) => `fact:${fact.factId}`),
      ...applied.manifest.claims.map((claim: { claimId: string }) => `evidence-claim:${claim.claimId}`),
    ]));
    await rollbackFactsV1({ runtimeRoot: root, factGraphEnabled: false, now });
    const rolledBackGraph = await createProductionReferenceGraph({ coordinator, now });
    expect(rolledBackGraph.edges).toEqual(expect.arrayContaining([
      { fromRef: "migration:catalog-facts-v1", toRef: `fact:${applied.manifest.facts[0]!.factId}`, necessity: "optional_for_audit" },
    ]));
  });

  it("fails closed on checksum-correct malformed or unknown Fact, claim, and observation snapshot authorities", async () => {
    const cases: Array<{ name: string; mutate: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>; error: RegExp }> = [
      {
        name: "fact", error: /fact authority payload/, mutate: async ({ activeRoot }) => {
          const file = confined(activeRoot, "facts", "records", "fact-pinout-official.json"); const envelope = await readJson(file);
          envelope.payload.fact.forged = true; envelope.payload.recordHash = sha256Json(envelope.payload.fact); envelope.checksum = sha256Json(envelope.payload);
          await atomicWriteJson(file, envelope);
        },
      },
      {
        name: "claim", error: /(evidence claim authority payload|fact evidence claim closure)/, mutate: async ({ activeRoot, officialClaim }) => {
          const file = confined(activeRoot, "evidence", "claims", officialClaim.contentHash.slice(0, 2), `${officialClaim.claimId}.json`); const envelope = await readJson(file);
          envelope.payload.forged = true; envelope.checksum = sha256Json(envelope.payload); await atomicWriteJson(file, envelope);
        },
      },
      {
        name: "capture identity unknown field", error: /evidence capture authority payload/, mutate: (value) => writeChecksumValidForgedCapture(value, (capture) => {
          ((capture.productIdentities as Array<Record<string, unknown>>)[0]!).forged = true;
        }),
      },
      {
        name: "capture identity bogus basis", error: /evidence capture authority payload/, mutate: (value) => writeChecksumValidForgedCapture(value, (capture) => {
          ((capture.productIdentities as Array<Record<string, unknown>>)[0]!).basis = "self-reported";
        }),
      },
      {
        name: "fact dropped governed region", error: /fact evidence claim closure is missing or semantically mismatched/,
        mutate: writeChecksumValidDroppedRegionFact,
      },
      {
        name: "observation snapshot", error: /observation snapshot authority payload/, mutate: async ({ activeRoot, observationSnapshot }) => {
          const file = confined(activeRoot, "observations", "plans", "plan-u3-runtime", "snapshots", `${observationSnapshot.snapshotId}.json`); const envelope = await readJson(file);
          envelope.payload.forged = true; envelope.checksum = legacySha256Runtime(envelope.payload); await atomicWriteJson(file, envelope);
        },
      },
      {
        name: "inference trace", error: /fact inference authority payload/, mutate: async ({ activeRoot, inferenceTrace }) => {
          const file = confined(activeRoot, "facts", "inferences", `${inferenceTrace.inferenceTraceId}.json`); const envelope = await readJson(file);
          envelope.payload.forged = true; envelope.checksum = sha256Json(envelope.payload); await atomicWriteJson(file, envelope);
        },
      },
      {
        name: "update decision", error: /fact update decision authority payload/, mutate: async ({ activeRoot, updateDecision }) => {
          const file = confined(activeRoot, "facts", "update-decisions", "records", `${updateDecision.updateDecisionId}.json`); const envelope = await readJson(file);
          envelope.payload.forged = true; envelope.checksum = sha256Json(envelope.payload); await atomicWriteJson(file, envelope);
        },
      },
      {
        name: "catalog facts migration manifest", error: /catalog facts migration manifest has unknown or missing fields/, mutate: async ({ activeRoot }) => {
          const file = confined(activeRoot, "migrations", "catalog-facts-v1", "manifest.json"); const manifest = await readJson(file);
          manifest.forged = true; const { manifestHash: _ignored, ...material } = manifest;
          manifest.manifestHash = sha256Json(material); await atomicWriteJson(file, manifest);
        },
      },
      {
        name: "sibling revision capture identity", error: /evidence claim exact governed product identity is unavailable/,
        mutate: (value) => writeChecksumValidSiblingIdentityClaim(value, { revision: "B" }),
      },
      {
        name: "sibling region capture identity", error: /evidence claim exact governed product identity is unavailable/,
        mutate: (value) => writeChecksumValidSiblingIdentityClaim(value, { region: "US" }),
      },
    ];
    for (const testCase of cases) {
      const value = await fixture(); await testCase.mutate(value);
      await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).rejects.toThrow(testCase.error);
    }
    const value = await fixture();
    await atomicWriteJson(confined(value.activeRoot, "facts", "unknown.json"), { schemaVersion: "forged" });
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).rejects.toThrow(/facts repository contains an unrecognized JSON authority/);
    const claimSidecar = await fixture();
    await atomicWriteJson(confined(claimSidecar.activeRoot, "evidence", "claims", "unknown.txt"), { schemaVersion: "forged" });
    await expect(createProductionReferenceGraph({ coordinator: claimSidecar.coordinator, now })).rejects.toThrow(/evidence claims contain an unrecognized authority path/);
    const migration = await fixture();
    await atomicWriteJson(confined(migration.activeRoot, "migrations", "catalog-facts-v1", "unknown.json"), { schemaVersion: "forged" });
    await expect(createProductionReferenceGraph({ coordinator: migration.coordinator, now })).rejects.toThrow(/catalog facts migration contains an unrecognized authority path/);
    const migrationSidecar = await fixture();
    await atomicWriteJson(confined(migrationSidecar.activeRoot, "migrations", "catalog-facts-v1", "unknown.txt"), { schemaVersion: "forged" });
    await expect(createProductionReferenceGraph({ coordinator: migrationSidecar.coordinator, now })).rejects.toThrow(/catalog facts migration contains an unrecognized authority path/);
  });

  it("rejects a self-hashed selected-value conflict omission in graph, backup, Doctor, and restore staging", async () => {
    const corrupted = await fixture();
    await writeChecksumValidConflictOmissionSnapshot(corrupted);
    await expect(createProductionReferenceGraph({ coordinator: corrupted.coordinator, now })).rejects.toThrow(
      /fact snapshot contains conflicting selected values without a complete open ConflictSet closure/,
    );
    await expect(createBackup({
      coordinator: corrupted.coordinator, outputFile: path.join(corrupted.root, "missing-conflict.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/fact snapshot contains conflicting selected values without a complete open ConflictSet closure/);
    expect((await runDoctor({ coordinator: corrupted.coordinator, now })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });

    const partialMembership = await fixture();
    await writeChecksumValidPartialConflictMembershipSnapshot(partialMembership);
    await expect(createProductionReferenceGraph({ coordinator: partialMembership.coordinator, now })).rejects.toThrow(
      /fact snapshot contains conflicting selected values without a complete open ConflictSet closure/,
    );

    const clean = await fixture(); const backup = path.join(clean.root, "clean-conflict.backup");
    await createBackup({ coordinator: clean.coordinator, outputFile: backup, password: "a sufficiently long password" });
    const before = await clean.coordinator.readState();
    await expect(restoreBackup({
      coordinator: clean.coordinator, inputFile: backup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        await writeChecksumValidConflictOmissionSnapshot(clean, staging);
      },
    })).rejects.toThrow(/fact snapshot contains conflicting selected values without a complete open ConflictSet closure/);
    expect(await clean.coordinator.readState()).toEqual(before);
  });

  it("requires active observation attachments to remain available and owned by the same plan", async () => {
    const crossPlan = await fixture();
    const attachments = new AttachmentRepository({ coordinator: crossPlan.coordinator, now });
    const foreign = await attachments.put({
      attachmentId: "attachment-u3-foreign", planId: "plan-u3-other", content: Buffer.from("foreign private attachment"),
      mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes",
    });
    await writeChecksumValidAttachmentObservation(crossPlan, foreign.attachmentId, "observation-u3-cross-plan-attachment");
    await expect(createProductionReferenceGraph({ coordinator: crossPlan.coordinator, now })).rejects.toThrow(
      /observation attachment closure is missing, tombstoned, or cross-plan/,
    );

    const tombstoned = await fixture();
    const tombstoneAttachments = new AttachmentRepository({ coordinator: tombstoned.coordinator, now });
    const owned = await tombstoneAttachments.put({
      attachmentId: "attachment-u3-tombstoned", planId: tombstoned.observation.planId, content: Buffer.from("owned private attachment"),
      mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes",
    });
    await writeChecksumValidAttachmentObservation(tombstoned, owned.attachmentId, "observation-u3-tombstoned-attachment");
    await tombstoneAttachments.delete(owned.attachmentId, { expectedRevision: owned.revision, expectedHash: owned.metadataHash });
    await expect(createProductionReferenceGraph({ coordinator: tombstoned.coordinator, now })).rejects.toThrow(
      /observation attachment closure is missing, tombstoned, or cross-plan/,
    );
    await expect(createBackup({
      coordinator: tombstoned.coordinator, outputFile: path.join(tombstoned.root, "tombstoned-observation.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/observation attachment closure is missing, tombstoned, or cross-plan/);

    const unknown = await fixture();
    await atomicWriteJson(confined(unknown.activeRoot, "attachments", "unknown.json"), { schemaVersion: "forged" });
    await expect(createProductionReferenceGraph({ coordinator: unknown.coordinator, now })).rejects.toThrow(
      /attachments repository contains an unrecognized JSON authority/,
    );
  });

  it("requires persisted inference artifact bytes and metadata for every replay trace", async () => {
    const missing = await fixture();
    await new FileArtifactRepository({ coordinator: missing.coordinator, now }).quarantine(missing.inferenceArtifact.record.ref);
    await expect(createProductionReferenceGraph({ coordinator: missing.coordinator, now })).rejects.toThrow(/reference graph edge .*dangling/);
    await expect(createBackup({
      coordinator: missing.coordinator, outputFile: path.join(missing.root, "missing-inference-artifact.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/reference graph edge .*dangling/);
    expect((await runDoctor({ coordinator: missing.coordinator, now })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });

    const swapped = await fixture();
    const trace = await createReplayableInferenceTrace({
      schemaVersion: "fact-inference-v1", inputFactRefs: [{ factId: swapped.observationFact.factId, contentHash: swapped.observationFact.contentHash }], outputFactIds: ["fact-clearance-swapped-artifact"],
      engine: "rule", ruleOrModelId: "clearance-runtime-rule", ruleOrModelVersion: "1.0.0", ruleOrModelArtifactHash: digest("f"),
      assumptions: ["fixture placement fixed"], confidence: 0.9, invalidationConditions: ["input fact changes"], createdAt: now(),
    });
    const fact = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-clearance-swapped-artifact", subject: { kind: "plan_subject", planId: swapped.observation.planId, subjectRef: swapped.observation.subjectRef },
      field: "physical.clearance", value: 4, unit: "mm", scope: "plan_subject", authority: "agent_inference", safetyClass: "compatibility_critical", status: "active",
      evidenceRefs: [], derivedFromFactIds: [swapped.observationFact.factId], inferenceTraceId: trace.inferenceTraceId,
      extractorOrRuleVersion: trace.ruleOrModelVersion, assumptions: trace.assumptions, confidence: 0.9, retrievedAt: now(),
    });
    const legacyInferenceLease = await swapped.coordinator.acquireMaintenanceLease("u3-swapped-legacy-inference");
    try {
      await swapped.facts.putInferenceTrace({
        trace,
        legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
        maintenanceLeaseToken: legacyInferenceLease.token,
      });
      await swapped.facts.putLegacyInferenceFact({
        fact,
        legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
        maintenanceLeaseToken: legacyInferenceLease.token,
      });
    } finally {
      await swapped.coordinator.releaseMaintenanceLease(legacyInferenceLease.token);
    }
    await expect(createProductionReferenceGraph({ coordinator: swapped.coordinator, now })).rejects.toThrow(/reference graph edge .*dangling/);
  });

  it("closes committed and crash-prepared accepted plan snapshot pointers", async () => {
    const committed = await fixture(); const accepted = await writeAcceptedPlanPointer(committed);
    const graph = await createProductionReferenceGraph({ coordinator: committed.coordinator, now });
    expect(graph.edges).toEqual(expect.arrayContaining([
      { fromRef: `fact-update-plan-pointer:${accepted.planId}`, toRef: `plan:${accepted.planId}`, necessity: "required_for_replay" },
      { fromRef: `fact-update-plan-pointer:${accepted.planId}`, toRef: `fact-update-decision:${accepted.decision.updateDecisionId}`, necessity: "required_for_replay" },
      { fromRef: `fact-update-plan-pointer:${accepted.planId}`, toRef: `fact-snapshot:${accepted.newSnapshot.snapshotId}`, necessity: "required_for_replay" },
    ]));
    const pointerFile = confined(committed.activeRoot, "facts", "update-decisions", "plan-pointers", `${sha256Json({ planId: accepted.planId })}.json`);
    const forged = await readJson(pointerFile);
    forged.payload.selectedSnapshotRef = { snapshotId: `fact-snapshot-sha256-${digest("f")}`, contentHash: digest("f") };
    forged.checksum = sha256Json(forged.payload); await atomicWriteJson(pointerFile, forged);
    await expect(createProductionReferenceGraph({ coordinator: committed.coordinator, now })).rejects.toThrow(/fact update plan pointer decision\/snapshot closure/);

    const prepared = await fixture(); const pending = await writeAcceptedPlanPointer(prepared, { crashAfterPointer: true });
    await expect(createProductionReferenceGraph({ coordinator: prepared.coordinator, now })).resolves.toMatchObject({
      nodes: expect.arrayContaining([`fact-update-plan-pointer:${pending.planId}`, `fact-update-decision:${pending.decision.updateDecisionId}`]),
    });
  });

  it("recovers decision-bound conflict resolution through accept, restart, undo, backup, Doctor, and restore", async () => {
    const value = await fixture();
    const accepted = await writeAcceptedPlanPointer(value, { lifecycleConflict: true });
    const open = accepted.lifecycleConflict!;
    const restart = () => {
      let decisions!: UpdateDecisionRepository;
      const facts = new FactRepository({
        coordinator: value.coordinator,
        evidenceClaims: value.claims,
        observations: new ObservationRepository({
          coordinator: value.coordinator, now,
          attachments: { hasAvailable: async () => true, hasAvailableAtRoot: async () => true },
        }),
        acceptedUpdateDecisions: {
          getActiveDecision: (decisionId) => decisions.getActiveDecision(decisionId),
          getActiveDecisionAtRoot: (activeRoot, decisionId) => decisions.getActiveDecisionAtRoot(activeRoot, decisionId),
        },
        currentInferenceArtifactHash: (trace) => trace.ruleOrModelArtifactHash,
      });
      decisions = new UpdateDecisionRepository({ coordinator: value.coordinator, snapshots: facts, now });
      return { facts, decisions };
    };

    let repositories = restart();
    const resolved = await repositories.facts.getConflict(open.conflictSetId);
    expect(resolved).toMatchObject({
      status: "resolved", resolutionFactIds: [accepted.newFact.factId], decisionIds: [accepted.decision.updateDecisionId],
    });
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).resolves.toMatchObject({
      edges: expect.arrayContaining([{
        fromRef: `fact-conflict:${open.conflictSetId}`,
        toRef: `fact-conflict-version:${open.conflictSetId}@sha256:${resolved.contentHash}`,
        necessity: "required_for_replay",
      }]),
    });

    const undo = await createUpdateDecision({
      ...accepted.decision,
      updateDecisionId: undefined,
      contentHash: undefined,
      memoryRevision: 1,
      decision: "undo",
      supersedesDecisionId: accepted.decision.updateDecisionId,
      supersedesDecisionHash: accepted.decision.contentHash,
      safetyWarningRetained: true,
    } as never);
    const undoDiff = await createFactUpdateEvaluationDiff({
      updateDecisionId: undo.updateDecisionId,
      updateDecisionHash: undo.contentHash,
      planId: accepted.planId,
      before: accepted.diff.after,
      after: accepted.diff.before,
      changedDomains: ["electrical"],
      fieldDiffs: [{
        field: "psu.pinout",
        beforeFactIds: [accepted.newFact.factId],
        afterFactIds: [accepted.oldFact.factId],
      }],
    });
    await repositories.decisions.putDecision({ decision: undo, expectedMemoryRevision: 0, evaluationDiffs: [undoDiff] });
    repositories = restart();
    await expect(repositories.facts.getConflict(open.conflictSetId)).resolves.toEqual(open);
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).resolves.toMatchObject({
      edges: expect.arrayContaining([{
        fromRef: `fact-conflict:${open.conflictSetId}`,
        toRef: `fact-conflict-version:${open.conflictSetId}@sha256:${open.contentHash}`,
        necessity: "required_for_replay",
      }]),
    });

    const doctor = await runDoctor({ coordinator: value.coordinator, now });
    expect(doctor.report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "pass" });
    const backup = path.join(value.root, "conflict-lifecycle.backup");
    await createBackup({ coordinator: value.coordinator, outputFile: backup, password: "a sufficiently long password" });
    await expect(verifyBackup({ inputFile: backup, password: "a sufficiently long password" })).resolves.toMatchObject({ valid: true });
    await restoreBackup({ coordinator: value.coordinator, inputFile: backup, password: "a sufficiently long password" });
    repositories = restart();
    await expect(repositories.facts.getConflict(open.conflictSetId)).resolves.toEqual(open);
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).resolves.toBeDefined();
  });

  it("keeps the prior effective conflict state across accept and undo crashes before memory", async () => {
    const value = await fixture();
    const pendingAccept = await writeAcceptedPlanPointer(value, {
      lifecycleConflict: true,
      crashAfterConflictPointer: true,
    });
    const open = pendingAccept.lifecycleConflict!;
    await expect(value.facts.getConflict(open.conflictSetId)).resolves.toEqual(open);
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).resolves.toBeDefined();

    const recovered = new UpdateDecisionRepository({ coordinator: value.coordinator, snapshots: value.facts, now });
    await recovered.putDecision({
      decision: pendingAccept.decision,
      expectedMemoryRevision: -1,
      evaluationDiffs: [pendingAccept.diff],
    });
    const resolved = await value.facts.getConflict(open.conflictSetId);
    expect(resolved.status).toBe("resolved");

    const undo = await createUpdateDecision({
      ...pendingAccept.decision,
      updateDecisionId: undefined,
      contentHash: undefined,
      memoryRevision: 1,
      decision: "undo",
      supersedesDecisionId: pendingAccept.decision.updateDecisionId,
      supersedesDecisionHash: pendingAccept.decision.contentHash,
      safetyWarningRetained: true,
    } as never);
    const undoDiff = await createFactUpdateEvaluationDiff({
      updateDecisionId: undo.updateDecisionId, updateDecisionHash: undo.contentHash, planId: pendingAccept.planId,
      before: pendingAccept.diff.after, after: pendingAccept.diff.before, changedDomains: ["electrical"],
      fieldDiffs: [{ field: "psu.pinout", beforeFactIds: [pendingAccept.newFact.factId], afterFactIds: [pendingAccept.oldFact.factId] }],
    });
    const crashingUndo = new UpdateDecisionRepository({
      coordinator: value.coordinator, snapshots: value.facts, now,
      failureInjector: (point) => { if (point === "after_conflict_pointer") throw new Error("undo crash before memory"); },
    });
    await expect(crashingUndo.putDecision({ decision: undo, expectedMemoryRevision: 0, evaluationDiffs: [undoDiff] }))
      .rejects.toThrow("undo crash before memory");
    await expect(value.facts.getConflict(open.conflictSetId)).resolves.toEqual(resolved);
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).resolves.toBeDefined();
    await recovered.putDecision({ decision: undo, expectedMemoryRevision: 0, evaluationDiffs: [undoDiff] });
    await expect(value.facts.getConflict(open.conflictSetId)).resolves.toEqual(open);
  });

  it("fails closed on unknown, forged lock/receipt/current snapshot authority and restore staging pointers", async () => {
    const unknown = await fixture(); await writeAcceptedPlanPointer(unknown);
    await atomicWriteJson(confined(unknown.activeRoot, "snapshots", "unknown.json"), { schemaVersion: "forged" });
    await expect(createProductionReferenceGraph({ coordinator: unknown.coordinator, now })).rejects.toThrow(
      /evaluation snapshot repository contains an unrecognized JSON authority/,
    );

    const forgedLock = await fixture(); const lockAccepted = await writeAcceptedPlanPointer(forgedLock);
    const lockFile = confined(
      forgedLock.activeRoot, "snapshots", "evaluation-locks", `${lockAccepted.diff.after.evaluationLock.contentHash}.json`,
    );
    const lockEnvelope = await readJson(lockFile);
    lockEnvelope.payload.forged = true; lockEnvelope.checksum = sha256Json(lockEnvelope.payload); await atomicWriteJson(lockFile, lockEnvelope);
    await expect(createProductionReferenceGraph({ coordinator: forgedLock.coordinator, now })).rejects.toThrow(/evaluation lock authority payload is invalid/);

    const forgedReceipt = await fixture(); const receiptAccepted = await writeAcceptedPlanPointer(forgedReceipt);
    const currentFile = confined(forgedReceipt.activeRoot, "snapshots", "evaluation-current", receiptAccepted.planId, "draft-0.json");
    const currentEnvelope = await readJson(currentFile);
    const receiptFile = confined(
      forgedReceipt.activeRoot, "snapshots", "evaluation-receipts", receiptAccepted.planId, "draft-0", `${currentEnvelope.payload.receiptHash}.json`,
    );
    const receiptEnvelope = await readJson(receiptFile);
    receiptEnvelope.payload.catalogVersion = ""; receiptEnvelope.checksum = sha256Json(receiptEnvelope.payload); await atomicWriteJson(receiptFile, receiptEnvelope);
    await expect(createProductionReferenceGraph({ coordinator: forgedReceipt.coordinator, now })).rejects.toThrow(/authoritative evaluation receipt payload is invalid/);

    const forgedCurrent = await fixture(); const currentAccepted = await writeAcceptedPlanPointer(forgedCurrent);
    const forgedCurrentFile = confined(forgedCurrent.activeRoot, "snapshots", "evaluation-current", currentAccepted.planId, "draft-0.json");
    const forgedCurrentEnvelope = await readJson(forgedCurrentFile);
    forgedCurrentEnvelope.payload.evaluationLockHash = digest("f"); forgedCurrentEnvelope.checksum = sha256Json(forgedCurrentEnvelope.payload);
    await atomicWriteJson(forgedCurrentFile, forgedCurrentEnvelope);
    await expect(createProductionReferenceGraph({ coordinator: forgedCurrent.coordinator, now })).rejects.toThrow(/evaluation current pointer receipt\/lock closure is missing or mismatched/);

    const clean = await fixture(); const accepted = await writeAcceptedPlanPointer(clean); const backup = path.join(clean.root, "snapshot-authority.backup");
    await createBackup({ coordinator: clean.coordinator, outputFile: backup, password: "a sufficiently long password" });
    const before = await clean.coordinator.readState();
    await expect(restoreBackup({
      coordinator: clean.coordinator, inputFile: backup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        const pointer = confined(staging, "snapshots", "evaluation-current", accepted.planId, "draft-0.json");
        const envelope = await readJson(pointer);
        envelope.payload.evaluationLockHash = digest("f"); envelope.checksum = sha256Json(envelope.payload);
        await atomicWriteJson(pointer, envelope);
      },
    })).rejects.toThrow(/evaluation current pointer receipt\/lock closure is missing or mismatched/);
    expect(await clean.coordinator.readState()).toEqual(before);
  });

  it("requires every accept/undo diff receipt to be issued by the persisted evaluation authority", async () => {
    const value = await fixture(); const accepted = await writeAcceptedPlanPointer(value);
    const receiptRoot = confined(value.activeRoot, "snapshots", "evaluation-receipts", accepted.planId, "draft-0");
    let removed = false;
    for (const entry of await readdir(receiptRoot)) {
      const file = path.join(receiptRoot, entry); const envelope = await readJson(file);
      if (envelope.payload?.evaluationLock?.contentHash !== accepted.diff.before.evaluationLock.contentHash) continue;
      await rm(file); removed = true; break;
    }
    expect(removed).toBe(true);
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).rejects.toThrow(
      /fact update evaluation diff has no matching issued evaluation receipt authority/,
    );
  });

  it("rejects forged resolved-conflict history, resolution ownership, and decision ownership", async () => {
    const initialResolved = await fixture();
    await writeResolvedConflict(initialResolved, {
      revision: 0, resolutionFactIds: [initialResolved.officialFact.factId], decisionIds: [initialResolved.updateDecision.updateDecisionId],
    });
    await expect(createProductionReferenceGraph({ coordinator: initialResolved.coordinator, now })).rejects.toThrow(/immutable version ownership|open-to-resolved history/);

    const missingDecision = await fixture();
    await writeResolvedConflict(missingDecision, {
      revision: 1, resolutionFactIds: [missingDecision.officialFact.factId], decisionIds: [`update-decision-sha256-${digest("f")}`],
    });
    await expect(createProductionReferenceGraph({ coordinator: missingDecision.coordinator, now })).rejects.toThrow(/fact conflict update decision is missing/);

    const foreignResolution = await fixture();
    await writeResolvedConflict(foreignResolution, {
      revision: 1, resolutionFactIds: [foreignResolution.observationFact.factId], decisionIds: [foreignResolution.updateDecision.updateDecisionId],
    });
    await expect(createProductionReferenceGraph({ coordinator: foreignResolution.coordinator, now })).rejects.toThrow(/resolution fact is missing or does not share subject and field ownership/);

    const foreignDecision = await fixture();
    await writeResolvedConflict(foreignDecision, {
      revision: 1, resolutionFactIds: [foreignDecision.officialFact.factId], decisionIds: [foreignDecision.updateDecision.updateDecisionId],
    });
    await expect(createProductionReferenceGraph({ coordinator: foreignDecision.coordinator, now })).rejects.toThrow(/does not own the resolved subject\/field closure/);
  });

  it("closes immutable fact update notices and rejects checksum-valid notice tampering in graph, backup, Doctor, and restore staging", async () => {
    const value = await fixture();
    const notice = await writeFactUpdateNotice(value);
    const graph = await createProductionReferenceGraph({ coordinator: value.coordinator, now });
    expect(graph.edges).toEqual(expect.arrayContaining([
      { fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `plan:${notice.planId}`, necessity: "required_for_replay" },
      { fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `fact-snapshot:${notice.oldSnapshotRef.snapshotId}`, necessity: "required_for_replay" },
      { fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `fact-update-decision:${notice.previousDecisionRef!.updateDecisionId}`, necessity: "required_for_replay" },
    ]));

    const state = await value.coordinator.readState();
    const file = confined(value.coordinator.activeRoot(state), "facts", "update-decisions", "notices", `${notice.updateNoticeId}.json`);
    const envelope = await readJson(file);
    envelope.payload.affectedDomains = [];
    envelope.checksum = sha256Json(envelope.payload);
    await atomicWriteJson(file, envelope);
    await expect(createProductionReferenceGraph({ coordinator: value.coordinator, now })).rejects.toThrow(/fact update notice authority payload/);
    await expect(createBackup({
      coordinator: value.coordinator,
      outputFile: path.join(value.root, "forged-notice.backup"),
      password: "a sufficiently long password",
    })).rejects.toThrow(/fact update notice authority payload/);
    expect((await runDoctor({ coordinator: value.coordinator, now })).report.checks
      .find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });

    const clean = await fixture();
    const cleanNotice = await writeFactUpdateNotice(clean);
    const backup = path.join(clean.root, "clean-notice.backup");
    await createBackup({ coordinator: clean.coordinator, outputFile: backup, password: "a sufficiently long password" });
    const before = await clean.coordinator.readState();
    await expect(restoreBackup({
      coordinator: clean.coordinator,
      inputFile: backup,
      password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        const noticeFile = confined(staging, "facts", "update-decisions", "notices", `${cleanNotice.updateNoticeId}.json`);
        const staged = await readJson(noticeFile);
        staged.payload.affectedDomains = [];
        staged.checksum = sha256Json(staged.payload);
        await atomicWriteJson(noticeFile, staged);
      },
    })).rejects.toThrow(/fact update notice authority payload/);
    expect(await clean.coordinator.readState()).toEqual(before);
  });

  it("blocks backup and Doctor, while restore staging rejects checksum-correct U3 authority tampering", async () => {
    const value = await fixture();
    const factFile = confined(value.activeRoot, "facts", "records", "fact-pinout-official.json"); const forged = await readJson(factFile);
    forged.payload.fact.forged = true; forged.payload.recordHash = sha256Json(forged.payload.fact); forged.checksum = sha256Json(forged.payload);
    await atomicWriteJson(factFile, forged);
    await expect(createBackup({ coordinator: value.coordinator, outputFile: path.join(value.root, "forged.backup"), password: "a sufficiently long password" })).rejects.toThrow(/fact authority payload/);
    expect((await runDoctor({ coordinator: value.coordinator, now })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });

    const siblingIdentity = await fixture();
    await writeChecksumValidSiblingIdentityClaim(siblingIdentity, { revision: "B" });
    await expect(createBackup({
      coordinator: siblingIdentity.coordinator, outputFile: path.join(siblingIdentity.root, "sibling-identity.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/evidence claim exact governed product identity is unavailable/);
    expect((await runDoctor({ coordinator: siblingIdentity.coordinator, now })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });

    const clean = await fixture(); const backup = path.join(clean.root, "clean.backup");
    await createBackup({ coordinator: clean.coordinator, outputFile: backup, password: "a sufficiently long password" });
    await expect(verifyBackup({ inputFile: backup, password: "a sufficiently long password" })).resolves.toMatchObject({ valid: true });
    const before = await clean.coordinator.readState();
    await expect(restoreBackup({
      coordinator: clean.coordinator, inputFile: backup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        const file = confined(staging, "migrations", "catalog-facts-v1", "manifest.json"); const manifest = await readJson(file);
        manifest.sourceHash = digest("b"); const { manifestHash: _ignored, ...material } = manifest;
        manifest.manifestHash = sha256Json(material); await atomicWriteJson(file, manifest);
      },
    })).rejects.toThrow(/catalog facts migration source hash is invalid/);
    expect(await clean.coordinator.readState()).toEqual(before);
  });
});

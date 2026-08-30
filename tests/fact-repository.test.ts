import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceClaim } from "../src/evidence/claims";
import type { EvidenceClaim } from "../src/evidence/contracts";
import { createConflictSet } from "../src/facts/conflicts";
import { createFactRecord } from "../src/facts/hash";
import { FactRepository, LEGACY_INFERENCE_IMPORT_CAPABILITY } from "../src/facts/repository";
import type { FactRecord } from "../src/facts/contracts";
import { factSubjectKey, resolveFactField } from "../src/facts/resolver";
import { createUpdateDecision } from "../src/facts/update-decisions";
import { canonicalJson } from "../src/plans/canonical";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import type { UserObservation } from "../src/observations/contracts";
import { createReplayableInferenceTrace } from "../src/facts/inference-policy";

const roots: string[] = [];
const digest = (letter: string): string => letter.repeat(64);
const legacyHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

async function claim(value: unknown, authority: "official" | "third_party" = "official"): Promise<EvidenceClaim> {
  return createEvidenceClaim({
    schemaVersion: "evidence-claim-v1",
    subject: { skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN" },
    scope: "revision",
    fieldId: "psu.pinout",
    value,
    authority,
    source: {
      documentId: `doc-sha256-${digest(authority === "official" ? "a" : "d")}`,
      documentSha256: digest(authority === "official" ? "a" : "d"),
      captureId: `capture-sha256-${digest(authority === "official" ? "b" : "e")}`,
      locator: { page: 12, section: "Pinout" },
    },
    retrievedAt: "2026-08-28T00:00:00.000Z",
    status: "active",
  });
}

async function fact(id: string, evidence: EvidenceClaim, value = evidence.value, supersedes?: FactRecord): Promise<FactRecord> {
  return createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: id,
    subject: { kind: "product", skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN" },
    field: "psu.pinout",
    value,
    scope: "revision",
    authority: evidence.authority,
    safetyClass: "electrical_safety",
    status: "active",
    evidenceRefs: [evidence.claimId],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-28T00:01:00.000Z",
    ...(supersedes ? { supersedesFactId: supersedes.factId, supersededFactHash: supersedes.contentHash } : {}),
  });
}

function evidenceLookup(claims: EvidenceClaim[]) {
  const records = new Map<string, EvidenceClaim>(claims.map((item) => [item.claimId, item]));
  return {
    getClaim: async (id: string) => structuredClone(records.get(id) ?? null),
    getClaimAtRoot: async (_activeRoot: string, id: string) => structuredClone(records.get(id) ?? null),
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "build-sim-facts-"));
  roots.push(value);
  return value;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

describe("U3 FactRepository", () => {
  it("persists immutable source facts only with matching verified claim closure", async () => {
    const repositoryRoot = await root();
    const official = await claim({ connectorFamily: "vendor-12-pin", revision: "A", pinCount: 12, pinMapHash: digest("9") });
    const repository = new FactRepository({ root: path.join(repositoryRoot, "facts"), evidenceClaims: evidenceLookup([official]) });
    const record = await fact("fact-pinout-a", official);
    await expect(repository.putFact({ fact: record })).resolves.toEqual(record);
    await expect(repository.putFact({ fact: record, expectedHash: record.contentHash })).resolves.toEqual(record);

    const restarted = new FactRepository({ root: path.join(repositoryRoot, "facts"), evidenceClaims: evidenceLookup([official]) });
    await expect(restarted.getFact(record.factId)).resolves.toEqual(record);
    const mismatched = await fact("fact-pinout-wrong", official, { connectorFamily: "different", revision: "A", pinCount: 12, pinMapHash: digest("6") });
    await expect(restarted.putFact({ fact: mismatched })).rejects.toMatchObject({ code: "invalid_input" });
    const regionWasDropped = await createFactRecord({
      ...record,
      factId: "fact-pinout-region-dropped",
      subject: {
        kind: "product", skuId: "psu.example", familyId: "psu-family", modelId: "psu-model",
        variantId: "psu-variant", revision: "A",
      },
      contentHash: undefined,
    } as never);
    await expect(restarted.putFact({ fact: regionWasDropped })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("requires every Agent inference fact to close over a replayable trace and exact input hashes", async () => {
    const repositoryRoot = await root();
    const official = await claim({ connectorFamily: "vendor-12-pin", revision: "A", pinCount: 12, pinMapHash: digest("9") });
    let currentArtifactHash = digest("5");
    const coordinator = new RuntimeCoordinator({ root: repositoryRoot });
    await coordinator.initialize("fact-repository-inference-migration-test");
    const repository = new FactRepository({
      coordinator, runtimeRoot: repositoryRoot, evidenceClaims: evidenceLookup([official]),
      currentInferenceArtifactHash: () => currentArtifactHash,
    });
    const input = await fact("fact-pinout-input", official);
    await repository.putFact({ fact: input });
    const trace = await createReplayableInferenceTrace({
      schemaVersion: "fact-inference-v1", inputFactRefs: [{ factId: input.factId, contentHash: input.contentHash }],
      outputFactIds: ["fact-pinout-inferred"], engine: "rule", ruleOrModelId: "pinout-normalizer", ruleOrModelVersion: "v1",
      ruleOrModelArtifactHash: digest("5"), assumptions: ["official pin map is authoritative"], confidence: 0.8,
      invalidationConditions: ["input fact hash changes", "rule artifact changes"], createdAt: "2026-08-28T00:02:00.000Z",
    });
    await expect(repository.putInferenceTrace({ trace })).rejects.toThrow(/legacy inference import capability/);
    await expect(repository.getInferenceTrace(trace.inferenceTraceId)).rejects.toThrow();
    const direct = new FactRepository({
      root: path.join(repositoryRoot, "uncoordinated-facts"),
      evidenceClaims: evidenceLookup([official]),
      currentInferenceArtifactHash: () => currentArtifactHash,
    });
    await direct.putFact({ fact: input });
    await expect(direct.putInferenceTrace({
      trace,
      legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
    })).rejects.toThrow(/coordinated migration authority/);
    await expect(direct.getInferenceTrace(trace.inferenceTraceId)).rejects.toThrow();
    const maintenance = await coordinator.acquireMaintenanceLease("fact-repository-inference-migration-test");
    await repository.putInferenceTrace({
      trace,
      legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
      maintenanceLeaseToken: maintenance.token,
    });
    const inferred = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-pinout-inferred", subject: input.subject, field: input.field, value: input.value,
      scope: input.scope, authority: "agent_inference", safetyClass: input.safetyClass, status: "active", evidenceRefs: [],
      derivedFromFactIds: [input.factId], inferenceTraceId: trace.inferenceTraceId, extractorOrRuleVersion: trace.ruleOrModelVersion,
      assumptions: trace.assumptions, confidence: trace.confidence, retrievedAt: "2026-08-28T00:03:00.000Z",
    });
    await expect(repository.putFact({ fact: inferred })).rejects.toThrow(/server-owned immutable candidate approval/);
    await expect(direct.putLegacyInferenceFact({
      fact: inferred,
      legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
    })).rejects.toThrow(/coordinated migration authority/);
    await expect(direct.getFact(inferred.factId)).rejects.toThrow();
    await expect(repository.putLegacyInferenceFact({
      fact: inferred,
      legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
      maintenanceLeaseToken: maintenance.token,
    })).resolves.toEqual(inferred);
    await expect(repository.createSnapshot({ maintenanceLeaseToken: maintenance.token })).resolves.toMatchObject({ factRefs: expect.arrayContaining([
      { factId: input.factId, contentHash: input.contentHash }, { factId: inferred.factId, contentHash: inferred.contentHash },
    ]) });
    currentArtifactHash = digest("6");
    await expect(repository.createSnapshot({ maintenanceLeaseToken: maintenance.token })).resolves.toMatchObject({ factRefs: [{ factId: input.factId, contentHash: input.contentHash }] });
    const forged = await createReplayableInferenceTrace({
      ...trace, inputFactRefs: [{ factId: input.factId, contentHash: digest("4") }], inferenceTraceId: undefined, contentHash: undefined,
    } as never);
    await expect(repository.putInferenceTrace({
      trace: forged,
      legacyImportCapability: LEGACY_INFERENCE_IMPORT_CAPABILITY,
      maintenanceLeaseToken: maintenance.token,
    })).rejects.toThrow(/input fact hash mismatch/);
    await coordinator.releaseMaintenanceLease(maintenance.token);
  });

  it("requires old fact hash and single-writer replacement ownership", async () => {
    const repositoryRoot = await root();
    const oldClaim = await claim({ connectorFamily: "vendor-12-pin", revision: "A", pinCount: 12, pinMapHash: digest("7") });
    const newClaim = await claim({ connectorFamily: "vendor-12-pin-v2", revision: "A", pinCount: 12, pinMapHash: digest("8") });
    const thirdClaim = await claim({ connectorFamily: "vendor-12-pin-v3", revision: "A", pinCount: 12, pinMapHash: digest("9") });
    const repository = new FactRepository({ root: path.join(repositoryRoot, "facts"), evidenceClaims: evidenceLookup([oldClaim, newClaim, thirdClaim]) });
    const old = await fact("fact-pinout-old", oldClaim);
    await repository.putFact({ fact: old });
    const replacement = await fact("fact-pinout-new", newClaim, newClaim.value, old);
    await repository.putFact({ fact: replacement });
    expect((await repository.listCurrentFacts()).map((item) => item.factId)).toEqual([replacement.factId]);

    const second = await fact("fact-pinout-second", thirdClaim, thirdClaim.value, old);
    await expect(repository.putFact({ fact: second })).rejects.toMatchObject({ code: "conflict" });
    const wrongHash = await createFactRecord({ ...second, factId: "fact-pinout-wrong-hash", supersededFactHash: digest("f"), contentHash: undefined } as never);
    await expect(repository.putFact({ fact: wrongHash })).rejects.toMatchObject({ code: "conflict" });
  });

  it("records open conflicts and creates closure-bound content-addressed snapshots", async () => {
    const repositoryRoot = await root();
    const official = await claim({ connectorFamily: "official", revision: "A", pinCount: 12, pinMapHash: digest("7") });
    const thirdParty = await claim({ connectorFamily: "measured", revision: "A", pinCount: 12, pinMapHash: digest("8") }, "third_party");
    const repository = new FactRepository({ root: path.join(repositoryRoot, "facts"), evidenceClaims: evidenceLookup([official, thirdParty]), now: () => "2026-08-28T01:00:00.000Z" });
    const first = await fact("fact-official", official);
    const second = await fact("fact-third-party", thirdParty);
    await repository.putFact({ fact: first });
    await repository.putFact({ fact: second });
    const conflict = await createConflictSet({
      schemaVersion: "fact-conflict-v1", conflictSetId: "conflict-pinout", subject: first.subject, field: first.field,
      factIds: [first.factId, second.factId], reason: "official_vs_third_party", status: "open", resolutionFactIds: [], decisionIds: [],
      createdAt: "2026-08-28T00:30:00.000Z",
    });
    await repository.putConflict({ conflict });
    const snapshot = await repository.createSnapshot();
    expect(snapshot.snapshotId).toBe(`fact-snapshot-sha256-${snapshot.contentHash}`);
    expect(snapshot.factRefs).toEqual(expect.arrayContaining([
      { factId: first.factId, contentHash: first.contentHash },
      { factId: second.factId, contentHash: second.contentHash },
    ]));
    expect(snapshot.conflictRefs).toEqual([{ conflictSetId: conflict.conflictSetId, contentHash: conflict.contentHash }]);
    await expect(repository.getSnapshot(snapshot.snapshotId)).resolves.toEqual(snapshot);

    const refs = await repository.snapshotReferences(repositoryRoot);
    expect(refs.snapshotPointers).toEqual([`fact-snapshot:${snapshot.snapshotId}`]);
    const conflictVersionRef = `fact-conflict-version:${conflict.conflictSetId}@sha256:${conflict.contentHash}`;
    expect(refs.edges).toEqual(expect.arrayContaining([
      { fromRef: `fact-snapshot:${snapshot.snapshotId}`, toRef: `fact:${first.factId}`, necessity: "required_for_replay" },
      { fromRef: `fact-snapshot:${snapshot.snapshotId}`, toRef: conflictVersionRef, necessity: "required_for_replay" },
      { fromRef: conflictVersionRef, toRef: `fact:${second.factId}`, necessity: "required_for_replay" },
    ]));

    const file = path.join(repositoryRoot, "facts", "records", `${first.factId}.json`);
    const forged = JSON.parse(await readFile(file, "utf8"));
    forged.payload.fact.value = { connectorFamily: "forged", revision: "A", pinCount: 12, pinMapHash: digest("5") };
    await writeFile(file, JSON.stringify(forged));
    await expect(repository.getSnapshot(snapshot.snapshotId)).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("refuses divergent current snapshots until one complete open conflict is retained", async () => {
    for (const variant of ["official_internal", "official_vs_third_party"] as const) {
      const repositoryRoot = await root();
      const firstClaim = await claim({ connectorFamily: `${variant}-a`, revision: "A", pinCount: 12, pinMapHash: digest("7") });
      const secondClaim = await claim(
        { connectorFamily: `${variant}-b`, revision: "A", pinCount: 12, pinMapHash: digest("8") },
        variant === "official_internal" ? "official" : "third_party",
      );
      const repository = new FactRepository({
        root: path.join(repositoryRoot, "facts"),
        evidenceClaims: evidenceLookup([firstClaim, secondClaim]),
      });
      const first = await fact(`fact-${variant}-a`, firstClaim);
      const second = await fact(`fact-${variant}-b`, secondClaim);
      await repository.putFact({ fact: first });
      await repository.putFact({ fact: second });
      await expect(repository.createSnapshot()).rejects.toMatchObject({ code: "invalid_input" });
      const conflict = await createConflictSet({
        schemaVersion: "fact-conflict-v1",
        conflictSetId: `conflict-${variant}`,
        subject: first.subject,
        field: first.field,
        factIds: [first.factId, second.factId],
        reason: variant,
        status: "open",
        resolutionFactIds: [],
        decisionIds: [],
        createdAt: "2026-08-28T00:30:00.000Z",
      });
      await repository.putConflict({ conflict });
      const snapshot = await repository.createSnapshot();
      expect(snapshot.conflictRefs).toEqual([{ conflictSetId: conflict.conflictSetId, contentHash: conflict.contentHash }]);
      await expect(resolveFactField({
        subject: first.subject,
        field: first.field,
        facts: [first, second],
        conflicts: [conflict],
        passContextFor: () => undefined,
      })).resolves.toMatchObject({ status: "blocked", reason: "open_conflict" });
    }
  });

  it("requires an ownership-preserving open-to-resolved conflict transition", async () => {
    const repositoryRoot = await root();
    const official = await claim({ connectorFamily: "official", revision: "A", pinCount: 12, pinMapHash: digest("7") });
    const measured = await claim({ connectorFamily: "measured", revision: "A", pinCount: 12, pinMapHash: digest("8") }, "third_party");
    const activeDecisions = new Map<string, Awaited<ReturnType<typeof createUpdateDecision>>>();
    const repository = new FactRepository({
      root: path.join(repositoryRoot, "facts"),
      evidenceClaims: evidenceLookup([official, measured]),
      acceptedUpdateDecisions: {
        getActiveDecision: async (decisionId) => structuredClone(activeDecisions.get(decisionId) ?? null),
      },
    });
    const first = await fact("fact-conflict-first", official);
    const second = await fact("fact-conflict-second", measured);
    await repository.putFact({ fact: first });
    await repository.putFact({ fact: second });

    const directResolved = await createConflictSet({
      schemaVersion: "fact-conflict-v1", conflictSetId: "conflict-direct-resolved", subject: first.subject, field: first.field,
      factIds: [first.factId, second.factId], reason: "official_vs_third_party", status: "resolved",
      resolutionFactIds: [first.factId], decisionIds: [`update-decision-sha256-${digest("9")}`],
      createdAt: "2026-08-28T00:30:00.000Z", resolvedAt: "2026-08-28T00:31:00.000Z",
    });
    await expect(repository.putConflict({ conflict: directResolved })).rejects.toMatchObject({ code: "conflict" });

    const open = await createConflictSet({
      schemaVersion: "fact-conflict-v1", conflictSetId: "conflict-transition", subject: first.subject, field: first.field,
      factIds: [first.factId, second.factId], reason: "official_vs_third_party", status: "open", resolutionFactIds: [], decisionIds: [],
      createdAt: "2026-08-28T00:30:00.000Z",
    });
    await repository.putConflict({ conflict: open });
    const historicalOpenSnapshot = await repository.createSnapshot();

    const accepted = await createUpdateDecision({
      schemaVersion: "fact-update-decision-v1",
      subjectKey: factSubjectKey(first.subject),
      claimKey: first.field,
      revision: "A",
      memoryRevision: 0,
      planIds: ["plan-a"],
      oldSnapshotRef: { snapshotId: `fact-snapshot-sha256-${digest("1")}`, contentHash: digest("1") },
      newSnapshotRef: { snapshotId: `fact-snapshot-sha256-${digest("2")}`, contentHash: digest("2") },
      oldFactIds: [second.factId],
      newFactIds: [first.factId],
      fieldDiffs: [{ field: first.field, beforeFactIds: [second.factId], afterFactIds: [first.factId] }],
      affectedDomains: ["electrical"],
      decision: "accept",
      decidedBy: "user",
      decidedAt: "2026-08-28T00:30:30.000Z",
      safetyWarningRetained: true,
    });
    activeDecisions.set(accepted.updateDecisionId, accepted);

    const unrelatedClaim = await createEvidenceClaim({
      ...official,
      claimId: undefined,
      contentHash: undefined,
      fieldId: "storage.recording_technology",
      value: "cmr",
      source: { ...official.source, locator: { page: 13, section: "Recording" } },
    } as never);
    const unrelated = await createFactRecord({
      ...first,
      factId: "fact-unrelated-resolution",
      field: unrelatedClaim.fieldId,
      value: unrelatedClaim.value,
      safetyClass: "compatibility_critical",
      evidenceRefs: [unrelatedClaim.claimId],
      contentHash: undefined,
    } as never);
    const repositoryWithUnrelated = new FactRepository({ root: path.join(repositoryRoot, "facts"), evidenceClaims: evidenceLookup([official, measured, unrelatedClaim]) });
    await repositoryWithUnrelated.putFact({ fact: unrelated });
    const wrongResolution = await createConflictSet({ ...open, status: "resolved", resolutionFactIds: [unrelated.factId], decisionIds: [`update-decision-sha256-${digest("9")}`], resolvedAt: "2026-08-28T00:31:00.000Z", contentHash: undefined } as never);
    await expect(repositoryWithUnrelated.putConflict({ conflict: wrongResolution, expectedHash: open.contentHash })).rejects.toMatchObject({ code: "invalid_input" });

    const syntacticOnly = await createConflictSet({
      ...open,
      status: "resolved",
      resolutionFactIds: [first.factId],
      decisionIds: [`update-decision-sha256-${digest("9")}`],
      resolvedAt: "2026-08-28T00:31:00.000Z",
      contentHash: undefined,
    } as never);
    await expect(repository.putConflict({ conflict: syntacticOnly, expectedHash: open.contentHash }))
      .rejects.toMatchObject({ code: "invalid_input" });

    const resolved = await createConflictSet({ ...open, status: "resolved", resolutionFactIds: [first.factId], decisionIds: [accepted.updateDecisionId], resolvedAt: "2026-08-28T00:31:00.000Z", contentHash: undefined } as never);
    await expect(repository.putConflict({ conflict: resolved, expectedHash: open.contentHash })).resolves.toEqual(resolved);
    await expect(repository.getConflict(open.conflictSetId)).resolves.toEqual(resolved);
    await expect(repository.getSnapshot(historicalOpenSnapshot.snapshotId)).resolves.toEqual(historicalOpenSnapshot);
    await expect(repository.getSnapshotClosureAtRoot(repositoryRoot, historicalOpenSnapshot.snapshotId)).resolves.toMatchObject({
      conflicts: [open],
    });
  });

  it("excludes facts and claims outside their validity window from current snapshots", async () => {
    const repositoryRoot = await root();
    const baseClaim = await claim({ connectorFamily: "dated", revision: "A", pinCount: 12, pinMapHash: digest("7") });
    const expiredClaim = await createEvidenceClaim({
      ...baseClaim,
      claimId: undefined,
      contentHash: undefined,
      validFrom: "2026-08-28T00:00:00.000Z",
      validUntil: "2026-08-28T01:00:00.000Z",
    } as never);
    const futureClaim = await createEvidenceClaim({
      ...baseClaim,
      claimId: undefined,
      contentHash: undefined,
      source: { ...baseClaim.source, locator: { page: 14, section: "Future pinout" } },
      validFrom: "2026-08-28T04:00:00.000Z",
      validUntil: "2026-08-28T05:00:00.000Z",
    } as never);
    const activeClaim = await createEvidenceClaim({
      ...baseClaim,
      claimId: undefined,
      contentHash: undefined,
      source: { ...baseClaim.source, locator: { page: 15, section: "Current pinout" } },
      validFrom: "2026-08-28T02:00:00.000Z",
      validUntil: "2026-08-28T04:00:00.000Z",
    } as never);
    const repository = new FactRepository({
      root: path.join(repositoryRoot, "facts"),
      evidenceClaims: evidenceLookup([expiredClaim, futureClaim, activeClaim]),
      now: () => "2026-08-28T03:00:00.000Z",
    });
    const expired = await fact("fact-expired", expiredClaim);
    const future = await fact("fact-future", futureClaim);
    const active = await fact("fact-current", activeClaim);
    await repository.putFact({ fact: expired });
    await repository.putFact({ fact: future });
    await repository.putFact({ fact: active });

    expect((await repository.listCurrentFacts()).map((item) => item.factId)).toEqual([active.factId]);
    await expect(repository.createSnapshot({ factIds: [expired.factId] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repository.createSnapshot()).resolves.toMatchObject({ factRefs: [{ factId: active.factId, contentHash: active.contentHash }] });
  });

  it("projects plan-scoped observations by exact plan/subject/hash closure without invalidating unrelated config changes", async () => {
    const repositoryRoot = await root();
    const observationBase = {
      observationId: "measurement-clearance", planId: "plan-a", subjectRef: { kind: "placement" as const, placementId: "gpu-slot" },
      fieldId: "physical.clearance" as const, value: 4, unit: "mm" as const, uncertainty: { plusMinus: 0.5 }, method: "measurement" as const,
      attachmentRefs: [], confirmedByUser: true, observedAgainstConfigHash: digest("a"), subjectRevisionHash: digest("b"),
      capturedAt: "2026-08-28T00:00:00.000Z", validatedAt: "2026-08-28T00:01:00.000Z", status: "active" as const,
    };
    const observation: UserObservation = { ...observationBase, contentHash: legacyHash(observationBase) };
    let currentConfigHash = digest("a"); let currentSubjectRevisionHash = digest("b");
    const observations = {
      resolveForFact: async () => ({ observation, context: { planId: "plan-a", subjectExists: true, currentConfigHash, currentSubjectRevisionHash } }),
      resolveForFactAtRoot: async () => ({ observation, context: { planId: "plan-a", subjectExists: true, currentConfigHash, currentSubjectRevisionHash } }),
    };
    const repository = new FactRepository({ root: path.join(repositoryRoot, "facts"), observations });
    const record = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-clearance", subject: { kind: "plan_subject", planId: "plan-a", subjectRef: observation.subjectRef },
      field: "physical.clearance", value: 4, unit: "mm", scope: "plan_subject", authority: "user_observation",
      safetyClass: "compatibility_critical", status: "active", evidenceRefs: [`observation:${observation.observationId}@sha256:${observation.contentHash}`],
      derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:02:00.000Z",
    });
    await expect(repository.putFact({ fact: record })).resolves.toEqual(record);
    currentConfigHash = digest("c");
    const configCurrent = await createFactRecord({ ...record, factId: "fact-clearance-config-current", contentHash: undefined } as never);
    await expect(repository.putFact({ fact: configCurrent })).resolves.toEqual(configCurrent);
    currentSubjectRevisionHash = digest("d");
    const stale = await createFactRecord({ ...record, factId: "fact-clearance-stale", contentHash: undefined } as never);
    await expect(repository.putFact({ fact: stale })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("writes under the active runtime generation and fences maintenance", async () => {
    const runtimeRoot = await root();
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => "2026-08-28T00:00:00.000Z" });
    const official = await claim({ connectorFamily: "vendor-12-pin", revision: "A", pinCount: 12, pinMapHash: digest("9") });
    const repository = new FactRepository({ coordinator, evidenceClaims: evidenceLookup([official]) });
    const record = await fact("fact-runtime", official);
    await repository.putFact({ fact: record });
    await expect(readFile(path.join(runtimeRoot, "generations", "1", "facts", "records", `${record.factId}.json`), "utf8")).resolves.toContain(record.factId);
    const lease = await coordinator.acquireMaintenanceLease("restore", { ttlMs: 10_000 });
    const next = await fact("fact-fenced", official);
    await expect(repository.putFact({ fact: next })).rejects.toThrow(/maintenance lease/i);
    await expect(repository.putFact({ fact: next, maintenanceLeaseToken: lease.token })).resolves.toEqual(next);
  });
});

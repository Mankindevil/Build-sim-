import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotHashes } from "../src/hash";
import type { FactRecord, FactSnapshot, UpdateDecision } from "../src/facts/contracts";
import { createFactRecord } from "../src/facts/hash";
import { factSubjectKey } from "../src/facts/resolver";
import { createFactSnapshot } from "../src/facts/snapshots";
import { UpdateDecisionRepository, type FactSnapshotLookup } from "../src/facts/update-decision-repository";
import { createUpdateDecision } from "../src/facts/update-decisions";
import {
  createFactUpdateEvaluationDiff,
  type FactUpdateEvaluationDomain,
  type SnapshotEvaluationReceipt,
} from "../src/facts/update-evaluation";
import { FactUpdateService } from "../src/facts/update-service";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { readJson, sha256Json } from "../src/runtime/fs.mjs";
import {
  transactionContentHashRuntime,
  validateFactUpdateDecisionTransactionRuntime,
  validateFactUpdatePlanPointerClosureRuntime,
  verifyFactUpdateDecisionTransactionRuntime,
  verifyFactUpdateEvaluationDiffRuntime,
} from "../src/facts/update-evaluation-runtime.mjs";

const roots: string[] = [];
const digest = (letter: string): string => letter.repeat(64);
const subject = {
  kind: "product" as const,
  skuId: "psu.fixture",
  familyId: "psu-family",
  modelId: "psu-model",
  variantId: "psu-variant",
  revision: "A",
  region: "CN",
};

interface SnapshotFixture {
  oldFact: FactRecord;
  newFact: FactRecord;
  oldSnapshot: FactSnapshot;
  newSnapshot: FactSnapshot;
  lookup: FactSnapshotLookup;
}

async function snapshots(): Promise<SnapshotFixture> {
  const oldFact = await createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: "fact-pinout-old",
    subject,
    field: "psu.pinout",
    value: { connectorFamily: "vendor-12", revision: "A", pinCount: 12, pinMapHash: digest("a") },
    scope: "revision",
    authority: "official",
    safetyClass: "electrical_safety",
    status: "active",
    evidenceRefs: [`claim-sha256-${digest("1")}`],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-28T00:00:00.000Z",
  });
  const newFact = await createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: "fact-pinout-new",
    subject,
    field: "psu.pinout",
    value: { connectorFamily: "vendor-12-revised", revision: "A", pinCount: 12, pinMapHash: digest("b") },
    scope: "revision",
    authority: "third_party",
    safetyClass: "electrical_safety",
    status: "active",
    evidenceRefs: [`claim-sha256-${digest("2")}`],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-28T00:01:00.000Z",
  });
  const oldSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: [{ factId: oldFact.factId, contentHash: oldFact.contentHash }],
    conflictRefs: [],
    createdAt: "2026-08-28T00:00:00.000Z",
  });
  const newSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: [{ factId: newFact.factId, contentHash: newFact.contentHash }],
    conflictRefs: [],
    createdAt: "2026-08-28T00:01:00.000Z",
  });
  const snapshotValues = new Map([[oldSnapshot.snapshotId, oldSnapshot], [newSnapshot.snapshotId, newSnapshot]]);
  const factValues = new Map([[oldFact.factId, oldFact], [newFact.factId, newFact]]);
  return {
    oldFact,
    newFact,
    oldSnapshot,
    newSnapshot,
    lookup: {
      getSnapshot: async (id) => {
        const value = snapshotValues.get(id);
        if (!value) throw new Error("missing snapshot");
        return structuredClone(value);
      },
      getSnapshotAtRoot: async (_root, id) => structuredClone(snapshotValues.get(id) ?? null),
      getFact: async (id) => {
        const value = factValues.get(id);
        if (!value) throw new Error("missing fact");
        return structuredClone(value);
      },
      getFactAtRoot: async (_root, id) => structuredClone(factValues.get(id) ?? null),
    },
  };
}

function snapshotHashes(snapshot: FactSnapshot, planSalt = "c"): SnapshotHashes {
  return {
    configHash: digest(planSalt),
    requirementSpecHash: digest("3"),
    factSnapshotHash: snapshot.contentHash,
    userObservationSnapshotHash: digest("4"),
    priceSnapshotHash: digest("5"),
    ruleSetHash: digest("6"),
    systemProfileHash: digest("7"),
    adapterSnapshotHash: digest("8"),
    engineHash: digest("9"),
    simulationModelHash: digest("a"),
    simulationInputHash: digest("b"),
  };
}

async function evaluationReceipt(
  planId: string,
  snapshot: FactSnapshot,
  evaluationHash: string,
  domain: FactUpdateEvaluationDomain,
  domainHash: string,
): Promise<SnapshotEvaluationReceipt> {
  const hashes = snapshotHashes(snapshot, planId === "plan-a" ? "c" : "d");
  const evaluationLock = await createPlanEvaluationLock({
    planId,
    snapshotHashes: hashes,
    factSnapshotId: snapshot.snapshotId,
    userObservationSnapshotId: "observation-snapshot-fixture",
    artifactLockfileHash: digest("e"),
  });
  return {
    schemaVersion: "fact-update-snapshot-evaluation-receipt-v1",
    planId,
    target: { kind: "draft", draftRevision: 4 },
    runtimeGeneration: 1,
    configHash: hashes.configHash,
    factSnapshotId: snapshot.snapshotId,
    factSnapshotHash: snapshot.contentHash,
    evaluationHash,
    evaluationLock,
    domainHashes: { [domain]: domainHash },
  };
}

async function decisionFor(
  value: SnapshotFixture,
  overrides: Partial<Omit<UpdateDecision, "updateDecisionId" | "contentHash">> = {},
): Promise<UpdateDecision> {
  return createUpdateDecision({
    schemaVersion: "fact-update-decision-v1",
    subjectKey: factSubjectKey(subject),
    claimKey: "psu.pinout",
    revision: "A",
    memoryRevision: 0,
    planIds: ["plan-a"],
    oldSnapshotRef: { snapshotId: value.oldSnapshot.snapshotId, contentHash: value.oldSnapshot.contentHash },
    newSnapshotRef: { snapshotId: value.newSnapshot.snapshotId, contentHash: value.newSnapshot.contentHash },
    oldFactIds: [value.oldFact.factId],
    newFactIds: [value.newFact.factId],
    fieldDiffs: [{ field: "psu.pinout", beforeFactIds: [value.oldFact.factId], afterFactIds: [value.newFact.factId] }],
    affectedDomains: ["electrical"],
    decision: "accept",
    decidedBy: "user",
    decidedAt: "2026-08-28T00:02:00.000Z",
    safetyWarningRetained: false,
    ...overrides,
  });
}

async function evaluationDiff(
  decision: UpdateDecision,
  oldSnapshot: FactSnapshot,
  newSnapshot: FactSnapshot,
  planId = "plan-a",
) {
  const oldReceipt = await evaluationReceipt(planId, oldSnapshot, digest("1"), "electrical", digest("3"));
  const newReceipt = await evaluationReceipt(planId, newSnapshot, digest("2"), "electrical", digest("4"));
  const undo = decision.decision === "undo";
  return createFactUpdateEvaluationDiff({
    updateDecisionId: decision.updateDecisionId,
    updateDecisionHash: decision.contentHash,
    planId,
    before: undo ? newReceipt : oldReceipt,
    after: undo ? oldReceipt : newReceipt,
    changedDomains: ["electrical"],
    fieldDiffs: undo
      ? [{ field: "psu.pinout", beforeFactIds: ["fact-pinout-new"], afterFactIds: ["fact-pinout-old"] }]
      : [{ field: "psu.pinout", beforeFactIds: ["fact-pinout-old"], afterFactIds: ["fact-pinout-new"] }],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 update decision memory", () => {
  it("persists accept and undo with exact diff, snapshot, fact, and revision/hash CAS closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-decisions-")); roots.push(root);
    const value = await snapshots();
    const repository = new UpdateDecisionRepository({
      root: path.join(root, "facts"), snapshots: value.lookup, now: () => "2026-08-28T00:02:00.000Z",
    });
    const accept = await decisionFor(value);
    const acceptDiff = await evaluationDiff(accept, value.oldSnapshot, value.newSnapshot);
    await expect(repository.putDecision({ decision: accept, expectedMemoryRevision: -1, evaluationDiffs: [acceptDiff] }))
      .resolves.toMatchObject({ selectedSnapshotRef: { snapshotId: value.newSnapshot.snapshotId }, evaluationDiff: { evaluationDiffId: acceptDiff.evaluationDiffId } });
    await expect(repository.getSelectedSnapshotForPlan("plan-a")).resolves.toEqual(accept.newSnapshotRef);
    expect(verifyFactUpdateEvaluationDiffRuntime(acceptDiff)).toBe(true);
    const transactionEnvelope = await readJson(path.join(root, "facts", "update-decisions", "transactions", `${accept.updateDecisionId}.json`));
    expect(validateFactUpdateDecisionTransactionRuntime(transactionEnvelope.payload)).toEqual([]);
    expect(verifyFactUpdateDecisionTransactionRuntime(transactionEnvelope.payload)).toBe(true);
    expect(transactionContentHashRuntime(transactionEnvelope.payload)).toBe(transactionEnvelope.payload.contentHash);
    const planKey = sha256Json({ planId: "plan-a" });
    const pointerEnvelope = await readJson(path.join(root, "facts", "update-decisions", "plan-pointers", `${planKey}.json`));
    expect(validateFactUpdatePlanPointerClosureRuntime(pointerEnvelope.payload, accept)).toEqual([]);

    const undo = await decisionFor(value, {
      memoryRevision: 1,
      decision: "undo",
      decidedAt: "2026-08-28T00:03:00.000Z",
      supersedesDecisionId: accept.updateDecisionId,
      supersedesDecisionHash: accept.contentHash,
      safetyWarningRetained: true,
    });
    const undoDiff = await evaluationDiff(undo, value.oldSnapshot, value.newSnapshot);
    await expect(repository.putDecision({ decision: undo, expectedMemoryRevision: 0, evaluationDiffs: [undoDiff] }))
      .resolves.toMatchObject({ selectedSnapshotRef: { snapshotId: value.oldSnapshot.snapshotId } });
    await expect(repository.getSelectedSnapshotForPlan("plan-a")).resolves.toEqual(undo.oldSnapshotRef);
    await expect(repository.getMemory({
      subjectKey: accept.subjectKey, claimKey: accept.claimKey, revision: accept.revision, planIds: accept.planIds,
    })).resolves.toMatchObject({
      revision: 1,
      decision: { decision: "undo" },
      selectedSnapshotRef: { snapshotId: value.oldSnapshot.snapshotId },
      evaluationDiffs: [{ evaluationDiffId: undoDiff.evaluationDiffId }],
    });
    await expect(repository.listEvaluationDiffs(accept.updateDecisionId)).resolves.toEqual([acceptDiff]);
    await expect(new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: value.lookup }).getDecision(undo.updateDecisionId))
      .resolves.toEqual(undo);
  });

  it("rejects missing accept diffs, stale CAS, forged memory identity, and undo of a non-accepted decision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-decisions-")); roots.push(root);
    const value = await snapshots();
    const repository = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: value.lookup });
    const accept = await decisionFor(value);
    await expect(repository.putDecision({ decision: accept, expectedMemoryRevision: -1 }))
      .rejects.toMatchObject({ code: "invalid_input" });

    const deferred = await decisionFor(value, { decision: "defer", safetyWarningRetained: true });
    await repository.putDecision({ decision: deferred, expectedMemoryRevision: -1 });
    await expect(repository.putDecision({ decision: deferred, expectedMemoryRevision: -1 })).resolves.toMatchObject({ decision: deferred });

    const invalidUndo = await decisionFor(value, {
      memoryRevision: 1,
      decision: "undo",
      decidedAt: "2026-08-28T00:03:00.000Z",
      supersedesDecisionId: deferred.updateDecisionId,
      supersedesDecisionHash: deferred.contentHash,
      safetyWarningRetained: true,
    });
    const undoDiff = await evaluationDiff(invalidUndo, value.oldSnapshot, value.newSnapshot);
    await expect(repository.putDecision({ decision: invalidUndo, expectedMemoryRevision: 0, evaluationDiffs: [undoDiff] }))
      .rejects.toMatchObject({ code: "conflict" });

    const forged = await decisionFor(value, { subjectKey: "caller-controlled-subject" });
    await expect(repository.putDecision({ decision: forged, expectedMemoryRevision: -1, evaluationDiffs: [
      await evaluationDiff(forged, value.oldSnapshot, value.newSnapshot),
    ] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("derives required evaluation domains from the governed field instead of trusting the caller", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-domains-")); roots.push(root);
    const value = await snapshots();
    const repository = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: value.lookup });
    for (const affectedDomains of [[], ["procurement"]] as const) {
      const decision = await decisionFor(value, { affectedDomains: [...affectedDomains] });
      const beforeBase = await evaluationReceipt("plan-a", value.oldSnapshot, digest("1"), "electrical", digest("3"));
      const afterBase = await evaluationReceipt("plan-a", value.newSnapshot, digest("2"), "electrical", digest("4"));
      const domainHashes = Object.fromEntries(affectedDomains.map((domain, index) => [domain, digest(index ? "6" : "5")])) as SnapshotEvaluationReceipt["domainHashes"];
      const afterDomainHashes = Object.fromEntries(affectedDomains.map((domain, index) => [domain, digest(index ? "8" : "7")])) as SnapshotEvaluationReceipt["domainHashes"];
      const diff = await createFactUpdateEvaluationDiff({
        updateDecisionId: decision.updateDecisionId,
        updateDecisionHash: decision.contentHash,
        planId: "plan-a",
        before: { ...beforeBase, domainHashes },
        after: { ...afterBase, domainHashes: afterDomainHashes },
        changedDomains: [...affectedDomains],
        fieldDiffs: decision.fieldDiffs,
      });
      await expect(repository.putDecision({ decision, expectedMemoryRevision: -1, evaluationDiffs: [diff] }))
        .rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("rejects whole-snapshot changes not declared by the single governed field", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-snapshot-delta-")); roots.push(root);
    const value = await snapshots();
    const extraFact = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-width-smuggled", subject, field: "physical.width", value: 155, unit: "mm",
      scope: "revision", authority: "official", safetyClass: "compatibility_critical", status: "active",
      evidenceRefs: [`claim-sha256-${digest("6")}`], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:01:30.000Z",
    });
    const smuggledFactSnapshot = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: [
        { factId: value.newFact.factId, contentHash: value.newFact.contentHash },
        { factId: extraFact.factId, contentHash: extraFact.contentHash },
      ],
      conflictRefs: [],
      createdAt: "2026-08-28T00:01:30.000Z",
    });
    const smuggledConflictSnapshot = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: [{ factId: value.newFact.factId, contentHash: value.newFact.contentHash }],
      conflictRefs: [{ conflictSetId: "conflict-smuggled", contentHash: digest("7") }],
      createdAt: "2026-08-28T00:01:31.000Z",
    });
    const extraSnapshots = new Map([
      [smuggledFactSnapshot.snapshotId, smuggledFactSnapshot],
      [smuggledConflictSnapshot.snapshotId, smuggledConflictSnapshot],
    ]);
    const lookup: FactSnapshotLookup = {
      getSnapshot: async (id) => structuredClone(extraSnapshots.get(id) ?? await value.lookup.getSnapshot(id)),
      getSnapshotAtRoot: async (_activeRoot, id) => structuredClone(extraSnapshots.get(id) ?? await value.lookup.getSnapshot(id)),
      getFact: async (id) => id === extraFact.factId ? structuredClone(extraFact) : value.lookup.getFact(id),
      getFactAtRoot: async (_activeRoot, id) => id === extraFact.factId ? structuredClone(extraFact) : value.lookup.getFact(id),
    };
    const repository = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: lookup });
    const service = new FactUpdateService({
      decisions: repository,
      snapshots: lookup,
      evaluate: async (planId, snapshot) => evaluationReceipt(
        planId, snapshot, snapshot.snapshotId === value.oldSnapshot.snapshotId ? digest("1") : digest("2"),
        "electrical", snapshot.snapshotId === value.oldSnapshot.snapshotId ? digest("3") : digest("4"),
      ),
    });
    for (const newSnapshot of [smuggledFactSnapshot, smuggledConflictSnapshot]) {
      const decision = await decisionFor(value, {
        newSnapshotRef: { snapshotId: newSnapshot.snapshotId, contentHash: newSnapshot.contentHash },
      });
      await expect(service.decide({ decision, expectedMemoryRevision: -1 })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(repository.getMemory(decision)).resolves.toBeNull();
    }
  });

  it("prevents independent field memories from branching one plan from the same stale whole snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-plan-cas-")); roots.push(root);
    const value = await snapshots();
    const firmwareOld = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-file-old", subject, field: "firmware.file_hash", value: digest("1"),
      scope: "revision", authority: "official", safetyClass: "compatibility_critical", status: "active",
      evidenceRefs: [`claim-sha256-${digest("8")}`], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:00:00.000Z",
    });
    const firmwareNew = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-file-new", subject, field: "firmware.file_hash", value: digest("2"),
      scope: "revision", authority: "official", safetyClass: "compatibility_critical", status: "active",
      evidenceRefs: [`claim-sha256-${digest("9")}`], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:01:00.000Z",
    });
    const initial = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: [
        { factId: value.oldFact.factId, contentHash: value.oldFact.contentHash },
        { factId: firmwareOld.factId, contentHash: firmwareOld.contentHash },
      ],
      conflictRefs: [], createdAt: "2026-08-28T00:00:00.000Z",
    });
    const afterPinout = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: [
        { factId: value.newFact.factId, contentHash: value.newFact.contentHash },
        { factId: firmwareOld.factId, contentHash: firmwareOld.contentHash },
      ],
      conflictRefs: [], createdAt: "2026-08-28T00:01:00.000Z",
    });
    const staleAfterFirmware = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: [
        { factId: value.oldFact.factId, contentHash: value.oldFact.contentHash },
        { factId: firmwareNew.factId, contentHash: firmwareNew.contentHash },
      ],
      conflictRefs: [], createdAt: "2026-08-28T00:01:01.000Z",
    });
    const snapshotValues = new Map([initial, afterPinout, staleAfterFirmware].map((snapshot) => [snapshot.snapshotId, snapshot]));
    const factValues = new Map([value.oldFact, value.newFact, firmwareOld, firmwareNew].map((fact) => [fact.factId, fact]));
    const lookup: FactSnapshotLookup = {
      getSnapshot: async (id) => structuredClone(snapshotValues.get(id)!),
      getSnapshotAtRoot: async (_root, id) => structuredClone(snapshotValues.get(id) ?? null),
      getFact: async (id) => structuredClone(factValues.get(id)!),
      getFactAtRoot: async (_root, id) => structuredClone(factValues.get(id) ?? null),
    };
    const repository = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: lookup });
    const pinout = await createUpdateDecision({
      schemaVersion: "fact-update-decision-v1", subjectKey: factSubjectKey(subject), claimKey: "psu.pinout", revision: "A",
      memoryRevision: 0, planIds: ["plan-a"], oldSnapshotRef: { snapshotId: initial.snapshotId, contentHash: initial.contentHash },
      newSnapshotRef: { snapshotId: afterPinout.snapshotId, contentHash: afterPinout.contentHash }, oldFactIds: [value.oldFact.factId],
      newFactIds: [value.newFact.factId], fieldDiffs: [{ field: "psu.pinout", beforeFactIds: [value.oldFact.factId], afterFactIds: [value.newFact.factId] }],
      affectedDomains: ["electrical"], decision: "accept", decidedBy: "user", decidedAt: "2026-08-28T00:02:00.000Z", safetyWarningRetained: false,
    });
    const pinoutDiff = await createFactUpdateEvaluationDiff({
      updateDecisionId: pinout.updateDecisionId, updateDecisionHash: pinout.contentHash, planId: "plan-a",
      before: await evaluationReceipt("plan-a", initial, digest("1"), "electrical", digest("3")),
      after: await evaluationReceipt("plan-a", afterPinout, digest("2"), "electrical", digest("4")),
      changedDomains: ["electrical"], fieldDiffs: pinout.fieldDiffs,
    });
    await repository.putDecision({ decision: pinout, expectedMemoryRevision: -1, evaluationDiffs: [pinoutDiff] });

    const firmware = await createUpdateDecision({
      schemaVersion: "fact-update-decision-v1", subjectKey: factSubjectKey(subject), claimKey: "firmware.file_hash", revision: "A",
      memoryRevision: 0, planIds: ["plan-a"], oldSnapshotRef: { snapshotId: initial.snapshotId, contentHash: initial.contentHash },
      newSnapshotRef: { snapshotId: staleAfterFirmware.snapshotId, contentHash: staleAfterFirmware.contentHash }, oldFactIds: [firmwareOld.factId],
      newFactIds: [firmwareNew.factId], fieldDiffs: [{ field: "firmware.file_hash", beforeFactIds: [firmwareOld.factId], afterFactIds: [firmwareNew.factId] }],
      affectedDomains: ["firmware"], decision: "accept", decidedBy: "user", decidedAt: "2026-08-28T00:03:00.000Z", safetyWarningRetained: false,
    });
    const firmwareDiff = await createFactUpdateEvaluationDiff({
      updateDecisionId: firmware.updateDecisionId, updateDecisionHash: firmware.contentHash, planId: "plan-a",
      before: await evaluationReceipt("plan-a", initial, digest("5"), "firmware", digest("6")),
      after: await evaluationReceipt("plan-a", staleAfterFirmware, digest("7"), "firmware", digest("8")),
      changedDomains: ["firmware"], fieldDiffs: firmware.fieldDiffs,
    });
    await expect(repository.putDecision({ decision: firmware, expectedMemoryRevision: -1, evaluationDiffs: [firmwareDiff] }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(repository.getSelectedSnapshotForPlan("plan-a")).resolves.toEqual(pinout.newSnapshotRef);
  });

  it("evaluates accepted updates and undo before committing, against the two exact immutable snapshots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-evaluation-")); roots.push(root);
    const value = await snapshots();
    const decisions = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: value.lookup });
    const service = new FactUpdateService({
      decisions,
      snapshots: value.lookup,
      evaluate: async (planId, snapshot) => evaluationReceipt(
        planId,
        snapshot,
        snapshot.snapshotId === value.oldSnapshot.snapshotId ? digest("1") : digest("2"),
        "electrical",
        snapshot.snapshotId === value.oldSnapshot.snapshotId ? digest("3") : digest("4"),
      ),
    });
    const accept = await decisionFor(value);
    const accepted = await service.decide({ decision: accept, expectedMemoryRevision: -1 });
    expect(accepted).toMatchObject({
      selectedSnapshotRef: { snapshotId: value.newSnapshot.snapshotId },
      evaluationDiff: {
        before: { factSnapshotId: value.oldSnapshot.snapshotId },
        after: { factSnapshotId: value.newSnapshot.snapshotId },
        changedDomains: ["electrical"],
      },
    });
    const undo = await decisionFor(value, {
      memoryRevision: 1,
      decision: "undo",
      decidedAt: "2026-08-28T00:03:00.000Z",
      supersedesDecisionId: accept.updateDecisionId,
      supersedesDecisionHash: accept.contentHash,
      safetyWarningRetained: true,
    });
    const undone = await service.decide({ decision: undo, expectedMemoryRevision: 0 });
    expect(undone).toMatchObject({
      selectedSnapshotRef: { snapshotId: value.oldSnapshot.snapshotId },
      evaluationDiff: {
        before: { factSnapshotId: value.newSnapshot.snapshotId },
        after: { factSnapshotId: value.oldSnapshot.snapshotId },
        changedDomains: ["electrical"],
        fieldDiffs: [{ beforeFactIds: [value.newFact.factId], afterFactIds: [value.oldFact.factId] }],
      },
    });
  });

  it("creates a separate content-addressed receipt for every affected plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-multi-plan-")); roots.push(root);
    const value = await snapshots();
    const decisions = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: value.lookup });
    const evaluated: string[] = [];
    const service = new FactUpdateService({
      decisions,
      snapshots: value.lookup,
      evaluate: async (planId, snapshot) => {
        evaluated.push(`${planId}:${snapshot.snapshotId}`);
        const old = snapshot.snapshotId === value.oldSnapshot.snapshotId;
        return evaluationReceipt(planId, snapshot, digest(old ? (planId === "plan-a" ? "1" : "2") : (planId === "plan-a" ? "3" : "4")),
          "electrical", digest(old ? (planId === "plan-a" ? "5" : "6") : (planId === "plan-a" ? "7" : "8")));
      },
    });
    const accept = await decisionFor(value, { planIds: ["plan-b", "plan-a"] });
    const result = await service.decide({ decision: accept, expectedMemoryRevision: -1 });
    expect(result.evaluationDiff).toBeUndefined();
    expect(result.evaluationDiffs.map((diff) => diff.planId)).toEqual(["plan-a", "plan-b"]);
    expect(new Set(result.evaluationDiffs.map((diff) => diff.evaluationDiffId)).size).toBe(2);
    expect(evaluated).toEqual(expect.arrayContaining([
      `plan-a:${value.oldSnapshot.snapshotId}`, `plan-a:${value.newSnapshot.snapshotId}`,
      `plan-b:${value.oldSnapshot.snapshotId}`, `plan-b:${value.newSnapshot.snapshotId}`,
    ]));
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotHashes } from "../src/hash";
import type { FactRecord, FactSnapshot } from "../src/facts/contracts";
import { createFactRecord } from "../src/facts/hash";
import { factSubjectKey } from "../src/facts/resolver";
import { createFactSnapshot } from "../src/facts/snapshots";
import {
  UpdateDecisionRepository,
  type FactSnapshotLookup,
  type UpdateDecisionWriteFailurePoint,
} from "../src/facts/update-decision-repository";
import { createUpdateDecision } from "../src/facts/update-decisions";
import { FactUpdateService, type SnapshotEvaluationReceipt } from "../src/facts/update-service";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";

const roots: string[] = [];
const digest = (letter: string) => letter.repeat(64);
const product = {
  kind: "product" as const,
  skuId: "board.crash-fixture",
  familyId: "board-family",
  modelId: "board-model",
  variantId: "board-variant",
  revision: "R1",
  region: "CN",
};

async function fixture(): Promise<{
  lookup: FactSnapshotLookup;
  oldSnapshot: FactSnapshot;
  newSnapshot: FactSnapshot;
  oldFact: FactRecord;
  newFact: FactRecord;
  decision: Awaited<ReturnType<typeof createUpdateDecision>>;
}> {
  const oldFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-firmware-old", subject: product, field: "firmware.file_hash", value: digest("1"),
    scope: "revision", authority: "official", safetyClass: "compatibility_critical", status: "active",
    evidenceRefs: [`claim-sha256-${digest("2")}`], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:00:00.000Z",
  });
  const newFact = await createFactRecord({
    schemaVersion: "fact-record-v1", factId: "fact-firmware-new", subject: product, field: "firmware.file_hash", value: digest("3"),
    scope: "revision", authority: "official", safetyClass: "compatibility_critical", status: "active",
    evidenceRefs: [`claim-sha256-${digest("4")}`], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:01:00.000Z",
  });
  const oldSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2", factRefs: [{ factId: oldFact.factId, contentHash: oldFact.contentHash }], conflictRefs: [],
    createdAt: "2026-08-28T00:00:00.000Z",
  });
  const newSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2", factRefs: [{ factId: newFact.factId, contentHash: newFact.contentHash }], conflictRefs: [],
    createdAt: "2026-08-28T00:01:00.000Z",
  });
  const snapshots = new Map([[oldSnapshot.snapshotId, oldSnapshot], [newSnapshot.snapshotId, newSnapshot]]);
  const facts = new Map([[oldFact.factId, oldFact], [newFact.factId, newFact]]);
  const lookup: FactSnapshotLookup = {
    getSnapshot: async (id) => {
      const value = snapshots.get(id);
      if (!value) throw new Error("snapshot missing");
      return structuredClone(value);
    },
    getSnapshotAtRoot: async (_root, id) => structuredClone(snapshots.get(id) ?? null),
    getFact: async (id) => {
      const value = facts.get(id);
      if (!value) throw new Error("fact missing");
      return structuredClone(value);
    },
    getFactAtRoot: async (_root, id) => structuredClone(facts.get(id) ?? null),
  };
  const decision = await createUpdateDecision({
    schemaVersion: "fact-update-decision-v1", subjectKey: factSubjectKey(product), claimKey: "firmware.file_hash", revision: "R1",
    memoryRevision: 0, planIds: ["plan-crash"],
    oldSnapshotRef: { snapshotId: oldSnapshot.snapshotId, contentHash: oldSnapshot.contentHash },
    newSnapshotRef: { snapshotId: newSnapshot.snapshotId, contentHash: newSnapshot.contentHash },
    oldFactIds: [oldFact.factId], newFactIds: [newFact.factId],
    fieldDiffs: [{ field: "firmware.file_hash", beforeFactIds: [oldFact.factId], afterFactIds: [newFact.factId] }],
    affectedDomains: ["firmware"], decision: "accept", decidedBy: "user", decidedAt: "2026-08-28T00:02:00.000Z",
    safetyWarningRetained: false,
  });
  return { lookup, oldSnapshot, newSnapshot, oldFact, newFact, decision };
}

function hashes(snapshot: FactSnapshot): SnapshotHashes {
  return {
    configHash: digest("5"), requirementSpecHash: digest("6"), factSnapshotHash: snapshot.contentHash,
    userObservationSnapshotHash: digest("7"), priceSnapshotHash: digest("8"), ruleSetHash: digest("9"),
    systemProfileHash: digest("a"), adapterSnapshotHash: digest("b"), engineHash: digest("c"),
    simulationModelHash: digest("d"), simulationInputHash: digest("e"),
  };
}

async function receipt(snapshot: FactSnapshot): Promise<SnapshotEvaluationReceipt> {
  const snapshotHashClosure = hashes(snapshot);
  return {
    schemaVersion: "fact-update-snapshot-evaluation-receipt-v1",
    planId: "plan-crash",
    target: { kind: "version", versionId: "version-crash" },
    runtimeGeneration: 1,
    configHash: snapshotHashClosure.configHash,
    factSnapshotId: snapshot.snapshotId,
    factSnapshotHash: snapshot.contentHash,
    evaluationHash: snapshot.snapshotId.includes(snapshot.contentHash) && snapshot.factRefs[0]?.factId.endsWith("old") ? digest("1") : digest("2"),
    evaluationLock: await createPlanEvaluationLock({
      planId: "plan-crash", snapshotHashes: snapshotHashClosure, factSnapshotId: snapshot.snapshotId,
      userObservationSnapshotId: "observation-snapshot-crash", artifactLockfileHash: digest("f"),
    }),
    domainHashes: { firmware: snapshot.factRefs[0]?.factId.endsWith("old") ? digest("3") : digest("4") },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 crash-safe update evaluation publication", () => {
  it("leaves no prepared transaction or active memory when evaluation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-eval-failure-")); roots.push(root);
    const value = await fixture();
    const repository = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: value.lookup });
    const service = new FactUpdateService({
      decisions: repository,
      snapshots: value.lookup,
      evaluate: async (_planId, snapshot) => {
        if (snapshot.snapshotId === value.newSnapshot.snapshotId) throw new Error("evaluator unavailable");
        return receipt(snapshot);
      },
    });
    await expect(service.decide({ decision: value.decision, expectedMemoryRevision: -1 })).rejects.toThrow("evaluator unavailable");
    await expect(repository.getPreparedDecision(value.decision.updateDecisionId)).resolves.toBeNull();
    await expect(repository.getMemory(value.decision)).resolves.toBeNull();
  });

  for (const failurePoint of ["after_prepare", "after_decision", "after_evaluation_diff", "after_plan_pointer", "before_memory"] as const) {
    it(`recovers the original immutable receipts after a crash at ${failurePoint}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `build-sim-update-${failurePoint}-`)); roots.push(root);
      const value = await fixture();
      let fail = true;
      const crashingRepository = new UpdateDecisionRepository({
        root: path.join(root, "facts"),
        snapshots: value.lookup,
        failureInjector: (point: UpdateDecisionWriteFailurePoint) => {
          if (fail && point === failurePoint) { fail = false; throw new Error(`simulated crash ${point}`); }
        },
      });
      const first = new FactUpdateService({ decisions: crashingRepository, snapshots: value.lookup, evaluate: async (_planId, snapshot) => receipt(snapshot) });
      await expect(first.decide({ decision: value.decision, expectedMemoryRevision: -1 })).rejects.toThrow(`simulated crash ${failurePoint}`);
      await expect(crashingRepository.getMemory(value.decision)).resolves.toBeNull();
      if (failurePoint === "after_plan_pointer" || failurePoint === "before_memory") {
        await expect(crashingRepository.getSelectedSnapshotForPlan("plan-crash")).resolves.toEqual(value.decision.oldSnapshotRef);
      }
      const prepared = await crashingRepository.getPreparedDecision(value.decision.updateDecisionId);
      expect(prepared?.evaluationDiffs).toHaveLength(1);
      const originalDiff = prepared!.evaluationDiffs[0]!;

      const recoveredRepository = new UpdateDecisionRepository({ root: path.join(root, "facts"), snapshots: value.lookup });
      const recovered = new FactUpdateService({
        decisions: recoveredRepository,
        snapshots: value.lookup,
        evaluate: async () => { throw new Error("retry must not recompute"); },
      });
      const result = await recovered.decide({ decision: value.decision, expectedMemoryRevision: -1 });
      expect(result.evaluationDiff).toEqual(originalDiff);
      await expect(recoveredRepository.getSelectedSnapshotForPlan("plan-crash")).resolves.toEqual(value.decision.newSnapshotRef);
      await expect(recoveredRepository.getMemory(value.decision)).resolves.toMatchObject({
        revision: 0,
        decision: { updateDecisionId: value.decision.updateDecisionId },
        evaluationDiffs: [{ evaluationDiffId: originalDiff.evaluationDiffId }],
      });
      await expect(recovered.decide({ decision: value.decision, expectedMemoryRevision: -1 }))
        .resolves.toMatchObject({ evaluationDiff: { evaluationDiffId: originalDiff.evaluationDiffId } });
    });
  }

  it("treats an error after the last pointer write as committed and replays without evaluation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-after-memory-")); roots.push(root);
    const value = await fixture();
    let fail = true;
    const repository = new UpdateDecisionRepository({
      root: path.join(root, "facts"), snapshots: value.lookup,
      failureInjector: (point) => {
        if (fail && point === "after_memory") { fail = false; throw new Error("lost acknowledgement"); }
      },
    });
    const first = new FactUpdateService({ decisions: repository, snapshots: value.lookup, evaluate: async (_planId, snapshot) => receipt(snapshot) });
    await expect(first.decide({ decision: value.decision, expectedMemoryRevision: -1 })).rejects.toThrow("lost acknowledgement");
    await expect(repository.getMemory(value.decision)).resolves.toMatchObject({ revision: 0 });
    const replay = new FactUpdateService({
      decisions: repository,
      snapshots: value.lookup,
      evaluate: async () => { throw new Error("committed retry must not recompute"); },
    });
    await expect(replay.decide({ decision: value.decision, expectedMemoryRevision: -1 }))
      .resolves.toMatchObject({ evaluationDiff: { updateDecisionId: value.decision.updateDecisionId } });
  });
});

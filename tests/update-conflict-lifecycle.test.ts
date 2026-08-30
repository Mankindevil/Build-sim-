import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceClaim } from "../src/evidence/claims";
import type { EvidenceClaim } from "../src/evidence/contracts";
import { createConflictSet } from "../src/facts/conflicts";
import type { FactSnapshot, UpdateDecision } from "../src/facts/contracts";
import { createFactRecord } from "../src/facts/hash";
import { FactRepository } from "../src/facts/repository";
import { factSubjectKey } from "../src/facts/resolver";
import { UpdateDecisionRepository } from "../src/facts/update-decision-repository";
import { createUpdateDecision } from "../src/facts/update-decisions";
import { createFactUpdateEvaluationDiff } from "../src/facts/update-evaluation";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = [];
const digest = (letter: string) => letter.repeat(64);
const now = () => "2026-08-28T00:02:00.000Z";
const subject = {
  skuId: "psu.conflict-lifecycle",
  familyId: "psu-family",
  modelId: "psu-model",
  variantId: "psu-variant",
  revision: "A",
  region: "CN",
};

async function claim(value: unknown, authority: "official" | "third_party"): Promise<EvidenceClaim> {
  return createEvidenceClaim({
    schemaVersion: "evidence-claim-v1",
    subject,
    scope: "revision",
    fieldId: "psu.pinout",
    value,
    authority,
    source: {
      documentId: `doc-sha256-${digest(authority === "official" ? "1" : "2")}`,
      documentSha256: digest(authority === "official" ? "1" : "2"),
      captureId: `capture-sha256-${digest(authority === "official" ? "3" : "4")}`,
      locator: { page: 1, section: authority },
    },
    retrievedAt: "2026-08-28T00:00:00.000Z",
    status: "active",
  });
}

async function receipt(planId: string, snapshot: FactSnapshot, evaluationHash: string) {
  const snapshotHashes = {
    configHash: digest("5"), requirementSpecHash: digest("6"), factSnapshotHash: snapshot.contentHash,
    userObservationSnapshotHash: digest("7"), priceSnapshotHash: digest("8"), ruleSetHash: digest("9"),
    systemProfileHash: digest("a"), adapterSnapshotHash: digest("b"), engineHash: digest("c"),
    simulationModelHash: digest("d"), simulationInputHash: digest("e"),
  };
  return {
    schemaVersion: "fact-update-snapshot-evaluation-receipt-v1" as const,
    planId,
    target: { kind: "draft" as const, draftRevision: 0 },
    runtimeGeneration: 1,
    configHash: snapshotHashes.configHash,
    factSnapshotId: snapshot.snapshotId,
    factSnapshotHash: snapshot.contentHash,
    evaluationHash,
    evaluationLock: await createPlanEvaluationLock({
      planId,
      snapshotHashes,
      factSnapshotId: snapshot.snapshotId,
      userObservationSnapshotId: "observation-snapshot-conflict-lifecycle",
      artifactLockfileHash: digest("f"),
    }),
    domainHashes: { electrical: evaluationHash },
  };
}

async function diff(decision: UpdateDecision, oldSnapshot: FactSnapshot, newSnapshot: FactSnapshot) {
  const before = await receipt("plan-conflict-lifecycle", oldSnapshot, digest("1"));
  const after = await receipt("plan-conflict-lifecycle", newSnapshot, digest("2"));
  return createFactUpdateEvaluationDiff({
    updateDecisionId: decision.updateDecisionId,
    updateDecisionHash: decision.contentHash,
    planId: "plan-conflict-lifecycle",
    before: decision.decision === "undo" ? after : before,
    after: decision.decision === "undo" ? before : after,
    changedDomains: ["electrical"],
    fieldDiffs: decision.decision === "undo"
      ? [{ field: "psu.pinout", beforeFactIds: ["fact-conflict-new"], afterFactIds: ["fact-conflict-old"] }]
      : [{ field: "psu.pinout", beforeFactIds: ["fact-conflict-old"], afterFactIds: ["fact-conflict-new"] }],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 decision-bound conflict lifecycle", () => {
  it("commits accept as resolved and undo as the exact immutable prior open state across restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-update-conflict-lifecycle-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now });
    const official = await claim({ connectorFamily: "vendor-12", revision: "A", pinCount: 12, pinMapHash: digest("a") }, "official");
    const measured = await claim({ connectorFamily: "vendor-12", revision: "A", pinCount: 12, pinMapHash: digest("b") }, "third_party");
    const claims = new Map<string, EvidenceClaim>([[official.claimId, official], [measured.claimId, measured]]);
    let decisions!: UpdateDecisionRepository;
    const createRepositories = () => {
      const facts = new FactRepository({
        coordinator,
        now,
        evidenceClaims: {
          getClaim: async (id) => structuredClone(claims.get(id) ?? null),
          getClaimAtRoot: async (_activeRoot, id) => structuredClone(claims.get(id) ?? null),
        },
        acceptedUpdateDecisions: {
          getActiveDecision: (id) => decisions.getActiveDecision(id),
          getActiveDecisionAtRoot: (activeRoot, id) => decisions.getActiveDecisionAtRoot(activeRoot, id),
        },
      });
      decisions = new UpdateDecisionRepository({ coordinator, snapshots: facts, now });
      return { facts, decisions };
    };
    let repositories = createRepositories();
    const product = { kind: "product" as const, ...subject };
    const oldFact = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-conflict-old", subject: product, field: "psu.pinout", value: official.value,
      scope: "revision", authority: "official", safetyClass: "electrical_safety", status: "active",
      evidenceRefs: [official.claimId], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:00:00.000Z",
    });
    const newFact = await createFactRecord({
      schemaVersion: "fact-record-v1", factId: "fact-conflict-new", subject: product, field: "psu.pinout", value: measured.value,
      scope: "revision", authority: "third_party", safetyClass: "electrical_safety", status: "active",
      evidenceRefs: [measured.claimId], derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:00:00.000Z",
    });
    await repositories.facts.putFact({ fact: oldFact });
    const oldSnapshot = await repositories.facts.createSnapshot({ factIds: [oldFact.factId] });
    await repositories.facts.putFact({ fact: newFact });
    const newSnapshot = await repositories.facts.createSnapshot({ factIds: [newFact.factId] });
    const open = await createConflictSet({
      schemaVersion: "fact-conflict-v1", conflictSetId: "conflict-update-lifecycle", subject: product, field: "psu.pinout",
      factIds: [oldFact.factId, newFact.factId], reason: "official_vs_third_party", status: "open",
      resolutionFactIds: [], decisionIds: [], createdAt: "2026-08-28T00:01:00.000Z",
    });
    await repositories.facts.putConflict({ conflict: open });
    const accept = await createUpdateDecision({
      schemaVersion: "fact-update-decision-v1", subjectKey: factSubjectKey(product), claimKey: "psu.pinout", revision: "A",
      memoryRevision: 0, planIds: ["plan-conflict-lifecycle"],
      oldSnapshotRef: { snapshotId: oldSnapshot.snapshotId, contentHash: oldSnapshot.contentHash },
      newSnapshotRef: { snapshotId: newSnapshot.snapshotId, contentHash: newSnapshot.contentHash },
      oldFactIds: [oldFact.factId], newFactIds: [newFact.factId],
      fieldDiffs: [{ field: "psu.pinout", beforeFactIds: [oldFact.factId], afterFactIds: [newFact.factId] }],
      affectedDomains: ["electrical"], decision: "accept", decidedBy: "user", decidedAt: now(), safetyWarningRetained: false,
    });
    await repositories.decisions.putDecision({
      decision: accept,
      expectedMemoryRevision: -1,
      evaluationDiffs: [await diff(accept, oldSnapshot, newSnapshot)],
    });
    await expect(repositories.facts.getConflict(open.conflictSetId)).resolves.toMatchObject({
      status: "resolved", resolutionFactIds: [newFact.factId], decisionIds: [accept.updateDecisionId],
    });

    repositories = createRepositories();
    const resolved = await repositories.facts.getConflict(open.conflictSetId);
    expect(resolved.status).toBe("resolved");
    const undo = await createUpdateDecision({
      ...accept,
      updateDecisionId: undefined,
      contentHash: undefined,
      memoryRevision: 1,
      decision: "undo",
      decidedAt: "2026-08-28T00:03:00.000Z",
      supersedesDecisionId: accept.updateDecisionId,
      supersedesDecisionHash: accept.contentHash,
      safetyWarningRetained: true,
    } as never);
    await repositories.decisions.putDecision({
      decision: undo,
      expectedMemoryRevision: 0,
      evaluationDiffs: [await diff(undo, oldSnapshot, newSnapshot)],
    });
    await expect(repositories.facts.getConflict(open.conflictSetId)).resolves.toEqual(open);

    repositories = createRepositories();
    await expect(repositories.facts.getConflict(open.conflictSetId)).resolves.toEqual(open);
  });
});

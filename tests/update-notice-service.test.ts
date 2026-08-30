import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceClaim } from "../src/evidence/claims";
import type { EvidenceClaim } from "../src/evidence/contracts";
import type { SnapshotHashes } from "../src/hash";
import type { FactRecord, FactSnapshot } from "../src/facts/contracts";
import { createFactRecord } from "../src/facts/hash";
import {
  FactUpdateNoticeService,
  type FactUpdateAuthorizedTarget,
  type FactUpdateNoticeServiceOptions,
} from "../src/facts/update-notice-service";
import { verifyFactUpdateNotice, type FactUpdateNoticePlanTarget } from "../src/facts/update-notices";
import { FactRepository } from "../src/facts/repository";
import { UpdateDecisionRepository } from "../src/facts/update-decision-repository";
import type { SnapshotEvaluationReceipt } from "../src/facts/update-evaluation";
import type { UserObservation } from "../src/observations/contracts";
import { canonicalJson } from "../src/plans/canonical";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { sha256Json } from "../src/runtime/fs.mjs";
import {
  factUpdateNoticeContentHashRuntime,
  verifyFactUpdateNoticeRuntime,
} from "../src/facts/update-notice-runtime.mjs";

const roots: string[] = [];
const digest = (letter: string): string => letter.repeat(64);
const now = "2026-08-28T08:00:00.000Z";
const product = {
  kind: "product" as const,
  skuId: "board.notice",
  familyId: "board-family",
  modelId: "board-model",
  variantId: "board-variant",
  revision: "R1",
  region: "CN",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function legacyHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function evidence(fieldId: string, value: unknown, marker: string): Promise<EvidenceClaim> {
  return createEvidenceClaim({
    schemaVersion: "evidence-claim-v1",
    subject: {
      skuId: product.skuId,
      familyId: product.familyId,
      modelId: product.modelId,
      variantId: product.variantId,
      revision: product.revision,
      region: product.region,
    },
    scope: "revision",
    fieldId,
    value,
    authority: "official",
    source: {
      documentId: `doc-sha256-${digest(marker)}`,
      documentSha256: digest(marker),
      captureId: `capture-sha256-${digest(marker === "1" ? "a" : marker === "2" ? "b" : marker === "3" ? "c" : "d")}`,
      locator: { page: Number(marker), section: fieldId },
    },
    retrievedAt: "2026-08-28T06:00:00.000Z",
    status: "active",
  });
}

async function sourceFact(
  factId: string,
  claim: EvidenceClaim,
  supersedes?: FactRecord,
): Promise<FactRecord> {
  return createFactRecord({
    schemaVersion: "fact-record-v1",
    factId,
    subject: product,
    field: claim.fieldId,
    value: claim.value,
    scope: "revision",
    authority: "official",
    safetyClass: claim.fieldId === "psu.pinout" ? "electrical_safety" : "compatibility_critical",
    status: "active",
    evidenceRefs: [claim.claimId],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-28T06:30:00.000Z",
    ...(supersedes ? { supersedesFactId: supersedes.factId, supersededFactHash: supersedes.contentHash } : {}),
  });
}

function observation(planId: string, marker: string, value: number): UserObservation {
  const material = {
    observationId: `measurement-${planId}-${marker}`,
    planId,
    subjectRef: { kind: "placement" as const, placementId: "gpu-slot" },
    fieldId: "physical.clearance" as const,
    value,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "measurement" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: digest("e"),
    subjectRevisionHash: digest("f"),
    capturedAt: "2026-08-28T06:00:00.000Z",
    validatedAt: "2026-08-28T06:01:00.000Z",
    status: "active" as const,
  };
  return { ...material, contentHash: legacyHash(material) };
}

async function observationFact(value: UserObservation, supersedes?: FactRecord): Promise<FactRecord> {
  return createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: `fact-${value.observationId}`,
    subject: { kind: "plan_subject", planId: value.planId, subjectRef: value.subjectRef },
    field: value.fieldId,
    value: value.value,
    ...(value.unit !== undefined ? { unit: value.unit } : {}),
    scope: "plan_subject",
    authority: "user_observation",
    safetyClass: "compatibility_critical",
    status: "active",
    evidenceRefs: [`observation:${value.observationId}@sha256:${value.contentHash}`],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-28T06:30:00.000Z",
    ...(supersedes ? { supersedesFactId: supersedes.factId, supersededFactHash: supersedes.contentHash } : {}),
  });
}

function hashes(snapshot: FactSnapshot, configHash: string): SnapshotHashes {
  return {
    configHash,
    requirementSpecHash: digest("1"),
    factSnapshotHash: snapshot.contentHash,
    userObservationSnapshotHash: digest("2"),
    priceSnapshotHash: digest("3"),
    ruleSetHash: digest("4"),
    systemProfileHash: digest("5"),
    adapterSnapshotHash: digest("6"),
    engineHash: digest("7"),
    simulationModelHash: digest("8"),
    simulationInputHash: digest("9"),
  };
}

interface Fixture {
  runtimeRoot: string;
  coordinator: RuntimeCoordinator;
  facts: FactRepository;
  decisions: UpdateDecisionRepository;
  service: FactUpdateNoticeService;
  pinned: Record<"plan-a" | "plan-b", FactSnapshot>;
  oldPinout: FactRecord;
  oldFirmware: FactRecord;
  newPinout: FactRecord;
  newFirmware: FactRecord;
  oldSystemRequirement?: FactRecord;
  newSystemRequirement?: FactRecord;
  observationA: FactRecord;
  observationB: FactRecord;
  evaluatorCalls: FactUpdateAuthorizedTarget[];
  racePlanTargetAfterNextEvaluationPair(target: FactUpdateNoticePlanTarget, alreadyUnderWriter?: boolean): void;
  raceRuntimeGenerationAfterNextEvaluationPair(): void;
  prepareRootBoundGenerationSwitchRace(): Promise<{
    maintenanceLeaseToken: string;
    cleanup(): Promise<void>;
  }>;
  setPlanTarget(target: FactUpdateNoticePlanTarget): void;
  restart(): FactUpdateNoticeService;
  addPlanBObservation(): Promise<FactRecord>;
}

async function fixture(includeSystemRequirement = false): Promise<Fixture> {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-update-notices-"));
  roots.push(runtimeRoot);
  const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => now });
  await coordinator.initialize();
  const claims = await Promise.all([
    evidence("psu.pinout", { connectorFamily: "old", revision: "R1", pinCount: 12, pinMapHash: digest("a") }, "1"),
    evidence("psu.pinout", { connectorFamily: "new", revision: "R1", pinCount: 12, pinMapHash: digest("b") }, "2"),
    evidence("firmware.file_hash", digest("c"), "3"),
    evidence("firmware.file_hash", digest("d"), "4"),
    ...(includeSystemRequirement ? [
      evidence("system.requirement", {
        systemProfileId: "system.windows-11", releaseId: "system-release.windows-11.24h2",
        requirementId: "memory.minimum", operator: "gte", valueType: "number", value: 8, unit: "gib",
      }, "5"),
      evidence("system.requirement", {
        systemProfileId: "system.windows-11", releaseId: "system-release.windows-11.24h2",
        requirementId: "memory.minimum", operator: "gte", valueType: "number", value: 16, unit: "gib",
      }, "6"),
    ] : []),
  ]);
  const claimMap = new Map<string, EvidenceClaim>(claims.map((claim) => [claim.claimId, claim]));
  const observations = new Map<string, UserObservation>();
  const observationAValue = observation("plan-a", "old", 4);
  const observationBValue = observation("plan-b", "old", 8);
  observations.set(observationAValue.observationId, observationAValue);
  observations.set(observationBValue.observationId, observationBValue);
  const observationLookup = {
    resolveForFact: async (planId: string, observationId: string) => {
      const value = observations.get(observationId);
      return value?.planId === planId ? { observation: structuredClone(value), context: {
        planId, subjectExists: true, currentConfigHash: digest("e"), currentSubjectRevisionHash: digest("f"),
      } } : null;
    },
    resolveForFactAtRoot: async (_activeRoot: string, planId: string, observationId: string) => {
      const value = observations.get(observationId);
      return value?.planId === planId ? { observation: structuredClone(value), context: {
        planId, subjectExists: true, currentConfigHash: digest("e"), currentSubjectRevisionHash: digest("f"),
      } } : null;
    },
  };
  const facts = new FactRepository({
    runtimeRoot,
    coordinator,
    now: () => now,
    evidenceClaims: {
      getClaim: async (claimId) => structuredClone(claimMap.get(claimId) ?? null),
      getClaimAtRoot: async (_activeRoot, claimId) => structuredClone(claimMap.get(claimId) ?? null),
    },
    observations: observationLookup,
  });
  const oldPinout = await sourceFact("fact-pinout-old", claims[0]!);
  const newPinout = await sourceFact("fact-pinout-new", claims[1]!, oldPinout);
  const oldFirmware = await sourceFact("fact-firmware-old", claims[2]!);
  const newFirmware = await sourceFact("fact-firmware-new", claims[3]!, oldFirmware);
  const observationA = await observationFact(observationAValue);
  const observationB = await observationFact(observationBValue);
  const oldSystemRequirement = includeSystemRequirement ? await sourceFact("fact-system-requirement-old", claims[4]!) : undefined;
  const newSystemRequirement = includeSystemRequirement ? await sourceFact("fact-system-requirement-new", claims[5]!, oldSystemRequirement) : undefined;
  await facts.putFact({ fact: oldPinout });
  await facts.putFact({ fact: oldFirmware });
  await facts.putFact({ fact: observationA });
  await facts.putFact({ fact: observationB });
  if (oldSystemRequirement) await facts.putFact({ fact: oldSystemRequirement });
  const pinned = {
    "plan-a": await facts.createSnapshot({ factIds: [oldPinout.factId, oldFirmware.factId, observationA.factId, ...(oldSystemRequirement ? [oldSystemRequirement.factId] : [])] }),
    "plan-b": await facts.createSnapshot({ factIds: [oldPinout.factId, oldFirmware.factId, observationB.factId, ...(oldSystemRequirement ? [oldSystemRequirement.factId] : [])] }),
  };
  await facts.putFact({ fact: newPinout });
  await facts.putFact({ fact: newFirmware });
  if (newSystemRequirement) await facts.putFact({ fact: newSystemRequirement });
  const decisions = new UpdateDecisionRepository({ runtimeRoot, coordinator, snapshots: facts, now: () => now });
  const evaluatorCalls: FactUpdateAuthorizedTarget[] = [];
  let currentTarget: FactUpdateNoticePlanTarget = {
    kind: "draft", expectedDraftRevision: 4, expectedConfigHash: digest("0"),
  };
  let afterEvaluation: ((input: FactUpdateAuthorizedTarget) => Promise<void>) | undefined;
  let service: FactUpdateNoticeService;
  const plans: FactUpdateNoticeServiceOptions["plans"] = {
    resolvePlanNoticeContextAtRoot: async (_activeRoot, planId) => ({
      target: structuredClone(currentTarget),
      pinnedSnapshotRef: {
        snapshotId: pinned[planId as keyof typeof pinned].snapshotId,
        contentHash: pinned[planId as keyof typeof pinned].contentHash,
      },
    }),
  };
  const relevantFacts: FactUpdateNoticeServiceOptions["relevantFacts"] = {
    selectRelevantProductFactIdsAtRoot: async (_activeRoot, _planId, _target, current) => current
      .filter((fact) => fact.subject.kind === "product" && fact.subject.skuId === product.skuId)
      .map((fact) => fact.factId),
  };
  async function evaluate(input: FactUpdateAuthorizedTarget, activeRoot?: string): Promise<SnapshotEvaluationReceipt> {
    evaluatorCalls.push(structuredClone(input));
    const closure = activeRoot
      ? await service.resolveFactUpdateSnapshotAtRoot(activeRoot, input)
      : (await coordinator.withConsistentSnapshot(
        ({ activeRoot: root }: { activeRoot: string }) => service.resolveFactUpdateSnapshotAtRoot(root, input),
      )).result as Awaited<ReturnType<typeof service.resolveFactUpdateSnapshotAtRoot>>;
    const notice = activeRoot
      ? await decisions.getNoticeAtRoot(activeRoot, input.updateNoticeId)
      : await decisions.getNotice(input.updateNoticeId);
    if (!notice) throw new Error("notice disappeared");
    const configHash = input.target.expectedConfigHash ?? digest("0");
    const snapshotHashes = hashes(closure.snapshot, configHash);
    const evaluationLock = await createPlanEvaluationLock({
      planId: input.planId,
      snapshotHashes,
      factSnapshotId: closure.snapshot.snapshotId,
      userObservationSnapshotId: `observation-snapshot-${input.planId}`,
      artifactLockfileHash: digest("f"),
    });
    const domain = notice.affectedDomains[0]!;
    const receipt: SnapshotEvaluationReceipt = {
      schemaVersion: "fact-update-snapshot-evaluation-receipt-v1",
      planId: input.planId,
      target: input.target.kind === "draft"
        ? { kind: "draft" as const, draftRevision: input.target.expectedDraftRevision }
        : { kind: "version" as const, versionId: input.target.versionId },
      runtimeGeneration: activeRoot
        ? Number(path.basename(activeRoot))
        : (await coordinator.readState()).runtimeGeneration,
      configHash,
      factSnapshotId: closure.snapshot.snapshotId,
      factSnapshotHash: closure.snapshot.contentHash,
      evaluationHash: sha256Json({ evaluation: closure.snapshot.contentHash }),
      evaluationLock,
      domainHashes: { [domain]: sha256Json({ domain, evaluationLockHash: evaluationLock.contentHash }) },
    };
    await afterEvaluation?.(structuredClone(input));
    return receipt;
  }
  function createService(currentFacts = facts, currentDecisions = decisions, currentCoordinator = coordinator): FactUpdateNoticeService {
    service = new FactUpdateNoticeService({
      runtimeRoot,
      coordinator: currentCoordinator,
      facts: currentFacts,
      decisions: currentDecisions,
      plans,
      relevantFacts,
      evaluator: {
        evaluateFactUpdateTarget: (input) => evaluate(cloneInput(input)),
        evaluateFactUpdateTargetAtRoot: (activeRoot, input) => evaluate(cloneInput(input), activeRoot),
      },
      now: () => now,
    });
    return service;
  }
  function cloneInput(input: Readonly<FactUpdateAuthorizedTarget>): FactUpdateAuthorizedTarget {
    return structuredClone(input);
  }
  function raceAfterNextEvaluationPair(effect: () => Promise<void>): void {
    let arrived = 0;
    let release!: () => void;
    const bothAuthorized = new Promise<void>((resolve) => { release = resolve; });
    afterEvaluation = async () => {
      arrived += 1;
      if (arrived === 2) {
        afterEvaluation = undefined;
        try { await effect(); }
        finally { release(); }
      } else {
        await bothAuthorized;
      }
    };
  }
  async function copyActiveGenerationToStaging(maintenanceLeaseToken: string): Promise<{
    staging: string;
    expectedGeneration: number;
  }> {
    const state = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(state);
    const staging = await coordinator.createStagingGeneration(maintenanceLeaseToken);
    for (const entry of await readdir(activeRoot)) {
      await cp(path.join(activeRoot, entry), path.join(staging, entry), { recursive: true, force: true });
    }
    return { staging, expectedGeneration: state.runtimeGeneration };
  }
  createService();
  return {
    runtimeRoot, coordinator, facts, decisions, get service() { return service; }, pinned,
    oldPinout, oldFirmware, newPinout, newFirmware,
    ...(oldSystemRequirement ? { oldSystemRequirement } : {}),
    ...(newSystemRequirement ? { newSystemRequirement } : {}),
    observationA, observationB, evaluatorCalls,
    setPlanTarget: (target) => { currentTarget = structuredClone(target); },
    racePlanTargetAfterNextEvaluationPair: (target, alreadyUnderWriter = false) => {
      let arrived = 0;
      let release!: () => void;
      const bothAuthorized = new Promise<void>((resolve) => { release = resolve; });
      afterEvaluation = async () => {
        arrived += 1;
        if (arrived === 2) {
          if (alreadyUnderWriter) currentTarget = structuredClone(target);
          else await coordinator.withWrite(async () => { currentTarget = structuredClone(target); });
          afterEvaluation = undefined;
          release();
        } else {
          await bothAuthorized;
        }
      };
    },
    raceRuntimeGenerationAfterNextEvaluationPair: () => {
      raceAfterNextEvaluationPair(async () => {
        const lease = await coordinator.acquireMaintenanceLease("fact-update-generation-race");
        const { staging, expectedGeneration } = await copyActiveGenerationToStaging(lease.token);
        try { await coordinator.activateStagingGeneration(staging, expectedGeneration, lease.token); }
        finally { await coordinator.releaseMaintenanceLease(lease.token); }
      });
    },
    prepareRootBoundGenerationSwitchRace: async () => {
      const lease = await coordinator.acquireMaintenanceLease("fact-update-root-bound-generation-race");
      const { staging, expectedGeneration } = await copyActiveGenerationToStaging(lease.token);
      const switchingCoordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => now, lockTimeoutMs: 100 });
      raceAfterNextEvaluationPair(() => switchingCoordinator.activateStagingGeneration(
        staging,
        expectedGeneration,
        lease.token,
      ).then(() => undefined));
      return {
        maintenanceLeaseToken: lease.token,
        cleanup: async () => {
          await coordinator.discardStagingGeneration(staging).catch(() => undefined);
          await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined);
        },
      };
    },
    restart: () => {
      const nextCoordinator = new RuntimeCoordinator({ root: runtimeRoot, now: () => now });
      const nextFacts = new FactRepository({
        runtimeRoot,
        coordinator: nextCoordinator,
        now: () => now,
        evidenceClaims: {
          getClaim: async (claimId) => structuredClone(claimMap.get(claimId) ?? null),
          getClaimAtRoot: async (_activeRoot, claimId) => structuredClone(claimMap.get(claimId) ?? null),
        },
        observations: observationLookup,
      });
      const nextDecisions = new UpdateDecisionRepository({ runtimeRoot, coordinator: nextCoordinator, snapshots: nextFacts, now: () => now });
      return createService(nextFacts, nextDecisions, nextCoordinator);
    },
    addPlanBObservation: async () => {
      const next = observation("plan-b", "new", 9);
      observations.set(next.observationId, next);
      const fact = await observationFact(next, observationB);
      await facts.putFact({ fact });
      return fact;
    },
  };
}

describe("U3 plan-scoped fact update notices", () => {
  it("surfaces a governed system-release requirement change through the plan update flow", async () => {
    const value = await fixture(true);
    const notice = (await value.service.list("plan-a")).find(({ claimKey }) => claimKey === "system.requirement");
    expect(notice).toMatchObject({
      planId: "plan-a",
      claimKey: "system.requirement",
      affectedDomains: ["system"],
      oldFactRefs: [{
        factId: value.oldSystemRequirement!.factId,
        contentHash: value.oldSystemRequirement!.contentHash,
      }],
      newFactRefs: [{
        factId: value.newSystemRequirement!.factId,
        contentHash: value.newSystemRequirement!.contentHash,
      }],
    });
  });

  it("revalidates notice authority inside the writer and leaves no decision side effects when the plan changes after evaluation", async () => {
    const value = await fixture();
    const notice = (await value.service.list("plan-a")).find((candidate) => candidate.claimKey === "psu.pinout")!;
    const before = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    value.racePlanTargetAfterNextEvaluationPair({
      kind: "draft", expectedDraftRevision: 5, expectedConfigHash: digest("a"),
    });

    await expect(value.service.decide("plan-a", {
      noticeId: notice.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
    })).rejects.toMatchObject({ code: "conflict" });

    const after = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    expect(after).toEqual(before);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toBeNull();
    await expect(value.decisions.getMemory({
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      planIds: [notice.planId],
    })).resolves.toBeNull();

    await value.coordinator.withWrite(async () => value.setPlanTarget(structuredClone(notice.target)));
    const evaluatorCallsBeforeRetry = value.evaluatorCalls.length;
    const accepted = await value.restart().decide("plan-a", {
      noticeId: notice.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
    });
    expect(accepted.selectedSnapshotRef).toEqual(notice.newSnapshotRef);
    expect(value.evaluatorCalls).toHaveLength(evaluatorCallsBeforeRetry + 2);
    const callsAfterCommit = structuredClone(value.evaluatorCalls);
    await expect(value.restart().decide("plan-a", {
      noticeId: notice.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
    })).resolves.toEqual(accepted);
    expect(value.evaluatorCalls).toEqual(callsAfterCommit);
  });

  it("applies the same final authority check to decideAtRoot without re-entering the coordinator", async () => {
    const value = await fixture();
    const notice = (await value.service.list("plan-a")).find((candidate) => candidate.claimKey === "psu.pinout")!;
    const before = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    value.racePlanTargetAfterNextEvaluationPair({
      kind: "draft", expectedDraftRevision: 5, expectedConfigHash: digest("a"),
    }, true);

    await expect(value.coordinator.withWrite(
      ({ activeRoot }: { activeRoot: string }) => value.service.decideAtRoot(activeRoot, "plan-a", {
        noticeId: notice.updateNoticeId,
        action: "accept",
        expectedMemoryRevision: -1,
        confirmation: true,
      }),
    )).rejects.toMatchObject({ code: "conflict" });

    const after = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    expect(after).toEqual(before);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toBeNull();
    await expect(value.decisions.getMemory({
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      planIds: [notice.planId],
    })).resolves.toBeNull();
  });

  it("fails accept closed across a content-identical restore generation and retries from the new generation", async () => {
    const value = await fixture();
    const notice = (await value.service.list("plan-a")).find((candidate) => candidate.claimKey === "psu.pinout")!;
    const beforeState = await value.coordinator.readState();
    const before = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    value.raceRuntimeGenerationAfterNextEvaluationPair();

    const input = {
      noticeId: notice.updateNoticeId,
      action: "accept" as const,
      expectedMemoryRevision: -1,
      confirmation: true as const,
    };
    await expect(value.service.decide("plan-a", input)).rejects.toMatchObject({ code: "conflict" });

    const afterState = await value.coordinator.readState();
    expect(afterState.runtimeGeneration).toBe(beforeState.runtimeGeneration + 1);
    const after = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    expect(after).toEqual(before);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toBeNull();
    await expect(value.decisions.getMemory({
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      planIds: [notice.planId],
    })).resolves.toBeNull();

    const callsBeforeRetry = value.evaluatorCalls.length;
    const accepted = await value.restart().decide("plan-a", input);
    expect(accepted.selectedSnapshotRef).toEqual(notice.newSnapshotRef);
    expect(accepted.evaluationDiffs.every((diff) => diff.before.runtimeGeneration === afterState.runtimeGeneration
      && diff.after.runtimeGeneration === afterState.runtimeGeneration)).toBe(true);
    expect(value.evaluatorCalls).toHaveLength(callsBeforeRetry + 2);
    const callsAfterCommit = structuredClone(value.evaluatorCalls);
    await expect(value.restart().decide("plan-a", input)).resolves.toEqual(accepted);
    expect(value.evaluatorCalls).toEqual(callsAfterCommit);
  });

  it("fails undo closed across a content-identical restore generation and preserves exact replay after retry", async () => {
    const value = await fixture();
    const notice = (await value.service.list("plan-a")).find((candidate) => candidate.claimKey === "psu.pinout")!;
    const accepted = await value.service.decide("plan-a", {
      noticeId: notice.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
    });
    const beforeState = await value.coordinator.readState();
    const before = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    value.raceRuntimeGenerationAfterNextEvaluationPair();
    const input = {
      noticeId: notice.updateNoticeId,
      action: "undo" as const,
      decisionId: accepted.decision.updateDecisionId,
      expectedMemoryRevision: 0,
      confirmation: true as const,
    };

    await expect(value.service.decide("plan-a", input)).rejects.toMatchObject({ code: "conflict" });

    const afterState = await value.coordinator.readState();
    expect(afterState.runtimeGeneration).toBe(beforeState.runtimeGeneration + 1);
    const after = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    expect(after).toEqual(before);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toEqual(notice.newSnapshotRef);
    await expect(value.decisions.getMemory({
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      planIds: [notice.planId],
    })).resolves.toMatchObject({ revision: 0, decision: { updateDecisionId: accepted.decision.updateDecisionId, decision: "accept" } });

    const callsBeforeRetry = value.evaluatorCalls.length;
    const undone = await value.restart().decide("plan-a", input);
    expect(undone.selectedSnapshotRef).toEqual(notice.oldSnapshotRef);
    expect(undone.evaluationDiffs.every((diff) => diff.before.runtimeGeneration === afterState.runtimeGeneration
      && diff.after.runtimeGeneration === afterState.runtimeGeneration)).toBe(true);
    expect(value.evaluatorCalls).toHaveLength(callsBeforeRetry + 2);
    const callsAfterCommit = structuredClone(value.evaluatorCalls);
    await expect(value.restart().decide("plan-a", input)).resolves.toEqual(undone);
    expect(value.evaluatorCalls).toEqual(callsAfterCommit);
  });

  it("keeps decideAtRoot generation-pinned because an outer writer fences the restore switch", async () => {
    const value = await fixture();
    const notice = (await value.service.list("plan-a")).find((candidate) => candidate.claimKey === "psu.pinout")!;
    const race = await value.prepareRootBoundGenerationSwitchRace();
    const beforeState = await value.coordinator.readState();
    const before = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    try {
      await expect(value.coordinator.withWrite(
        ({ activeRoot }: { activeRoot: string }) => value.service.decideAtRoot(activeRoot, "plan-a", {
          noticeId: notice.updateNoticeId,
          action: "accept",
          expectedMemoryRevision: -1,
          confirmation: true,
        }),
        { maintenanceLeaseToken: race.maintenanceLeaseToken },
      )).rejects.toThrow("runtime coordination lock timeout");
    } finally {
      await race.cleanup();
    }

    const afterState = await value.coordinator.readState();
    expect(afterState.runtimeGeneration).toBe(beforeState.runtimeGeneration);
    expect(afterState.revision).toBe(beforeState.revision);
    const after = (await value.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => value.decisions.snapshotReferences(activeRoot),
    )).result;
    expect(after).toEqual(before);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toBeNull();
    await expect(value.decisions.getMemory({
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      planIds: [notice.planId],
    })).resolves.toBeNull();
  });

  it("persists stable single-field notices across restart and rejects forged transport authority", async () => {
    const value = await fixture();
    const notices = await value.service.list("plan-a");
    expect(notices.map((notice) => notice.claimKey)).toEqual(["firmware.file_hash", "psu.pinout"]);
    for (const notice of notices) {
      expect(verifyFactUpdateNotice(notice)).toBe(true);
      expect(verifyFactUpdateNoticeRuntime(notice)).toBe(true);
      expect(factUpdateNoticeContentHashRuntime(notice)).toBe(notice.contentHash);
      const candidate = await value.facts.getSnapshot(notice.newSnapshotRef.snapshotId);
      const unrelatedOldId = notice.claimKey === "psu.pinout" ? value.oldFirmware.factId : value.oldPinout.factId;
      expect(candidate.factRefs).toContainEqual({
        factId: unrelatedOldId,
        contentHash: notice.claimKey === "psu.pinout" ? value.oldFirmware.contentHash : value.oldPinout.contentHash,
      });
      expect(candidate.factRefs).toContainEqual({ factId: value.observationA.factId, contentHash: value.observationA.contentHash });
      expect(candidate.factRefs).not.toContainEqual(expect.objectContaining({ factId: value.observationB.factId }));
    }
    const restarted = value.restart();
    await expect(restarted.list("plan-a")).resolves.toEqual(notices);
    await expect(restarted.decide("plan-a", {
      noticeId: notices[0]!.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: 0,
      confirmation: true,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(restarted.decide("plan-a", {
      noticeId: notices[0]!.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
      oldSnapshotRef: notices[0]!.oldSnapshotRef,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(value.evaluatorCalls).toHaveLength(0);
  });

  it("records reject/defer without evaluation and suppresses the exact handled notices", async () => {
    const value = await fixture();
    const notices = await value.service.list("plan-a");
    const firmware = notices.find((notice) => notice.claimKey === "firmware.file_hash")!;
    const pinout = notices.find((notice) => notice.claimKey === "psu.pinout")!;
    await expect(value.service.decide("plan-a", {
      noticeId: firmware.updateNoticeId,
      action: "defer",
      expectedMemoryRevision: -1,
      confirmation: true,
    })).resolves.toMatchObject({ decision: { decision: "defer" }, evaluationDiffs: [] });
    await expect(value.service.decide("plan-a", {
      noticeId: pinout.updateNoticeId,
      action: "reject",
      expectedMemoryRevision: -1,
      confirmation: true,
    })).resolves.toMatchObject({ decision: { decision: "reject" }, evaluationDiffs: [] });
    expect(value.evaluatorCalls).toHaveLength(0);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toBeNull();
    await expect(value.service.list("plan-a")).resolves.toEqual([]);
  });

  it("advances selected snapshot by CAS, rebases the second field, and undo restores that notice's old snapshot", async () => {
    const value = await fixture();
    const initial = await value.service.list("plan-a");
    const pinout = initial.find((notice) => notice.claimKey === "psu.pinout")!;
    const firmwareStale = initial.find((notice) => notice.claimKey === "firmware.file_hash")!;
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toBeNull();
    const restartedBeforeAccept = value.restart();
    const acceptInput = {
      noticeId: pinout.updateNoticeId,
      action: "accept" as const,
      expectedMemoryRevision: -1,
      confirmation: true as const,
    };
    const acceptedPinout = await restartedBeforeAccept.decide("plan-a", acceptInput);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toEqual(pinout.newSnapshotRef);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-b")).resolves.toBeNull();
    expect(value.evaluatorCalls).toHaveLength(2);
    const callsAfterAccept = structuredClone(value.evaluatorCalls);
    await expect(value.restart().decide("plan-a", acceptInput)).resolves.toEqual(acceptedPinout);
    expect(value.evaluatorCalls).toEqual(callsAfterAccept);
    await expect(value.service.decide("plan-a", {
      noticeId: firmwareStale.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
    })).rejects.toMatchObject({ code: "conflict" });
    const rebased = await value.service.list("plan-a");
    expect(rebased).toHaveLength(1);
    expect(rebased[0]).toMatchObject({ claimKey: "firmware.file_hash", oldSnapshotRef: pinout.newSnapshotRef });
    const rebasedSnapshot = await value.facts.getSnapshot(rebased[0]!.newSnapshotRef.snapshotId);
    expect(rebasedSnapshot.factRefs).toContainEqual({ factId: value.newPinout.factId, contentHash: value.newPinout.contentHash });
    const acceptedFirmware = await value.service.decide("plan-a", {
      noticeId: rebased[0]!.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
    });
    expect(acceptedFirmware.selectedSnapshotRef).toEqual(rebased[0]!.newSnapshotRef);
    const undoInput = {
      noticeId: rebased[0]!.updateNoticeId,
      action: "undo" as const,
      decisionId: acceptedFirmware.decision.updateDecisionId,
      expectedMemoryRevision: 0,
      confirmation: true as const,
    };
    const undone = await value.restart().decide("plan-a", undoInput);
    expect(undone.selectedSnapshotRef).toEqual(rebased[0]!.oldSnapshotRef);
    expect(undone.selectedSnapshotRef).toEqual(acceptedPinout.selectedSnapshotRef);
    const callsAfterUndo = structuredClone(value.evaluatorCalls);
    await expect(value.restart().decide("plan-a", undoInput)).resolves.toEqual(undone);
    expect(value.evaluatorCalls).toEqual(callsAfterUndo);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-b")).resolves.toBeNull();
  });

  it("isolates two plan pointers and never folds another plan's observation update into a candidate", async () => {
    const value = await fixture();
    const beforeA = await value.service.list("plan-a");
    const beforeB = await value.service.list("plan-b");
    expect(beforeA[0]!.oldSnapshotRef).toEqual({
      snapshotId: value.pinned["plan-a"].snapshotId,
      contentHash: value.pinned["plan-a"].contentHash,
    });
    expect(beforeB[0]!.oldSnapshotRef).toEqual({
      snapshotId: value.pinned["plan-b"].snapshotId,
      contentHash: value.pinned["plan-b"].contentHash,
    });
    const nextBObservation = await value.addPlanBObservation();
    const afterA = await value.service.list("plan-a");
    expect(afterA).toEqual(beforeA);
    for (const notice of afterA) {
      const candidate = await value.facts.getSnapshot(notice.newSnapshotRef.snapshotId);
      expect(candidate.factRefs).toContainEqual({ factId: value.observationA.factId, contentHash: value.observationA.contentHash });
      expect(candidate.factRefs).not.toContainEqual(expect.objectContaining({ factId: value.observationB.factId }));
      expect(candidate.factRefs).not.toContainEqual(expect.objectContaining({ factId: nextBObservation.factId }));
    }
    const acceptedA = await value.service.decide("plan-a", {
      noticeId: afterA.find((notice) => notice.claimKey === "psu.pinout")!.updateNoticeId,
      action: "accept",
      expectedMemoryRevision: -1,
      confirmation: true,
    });
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-a")).resolves.toEqual(acceptedA.selectedSnapshotRef);
    await expect(value.decisions.getSelectedSnapshotForPlan("plan-b")).resolves.toBeNull();
    expect((await value.service.list("plan-b"))[0]!.oldSnapshotRef).toEqual(beforeB[0]!.oldSnapshotRef);
  });
});

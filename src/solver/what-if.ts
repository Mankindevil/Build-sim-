import { canonicalize, type SnapshotHashes } from "../hash";
import type { FileScenarioRepository, ScenarioAcceptanceProposal } from "../scenarios/repository";
import type { PersistedWhatIfResult } from "../scenarios/contracts";
import { configV3Hash } from "../topology/hash";
import type { BuildConfigV3 } from "../topology/contracts";
import {
  assertAuthoritativeSolverEvaluationReceipt,
  type AuthoritativeSolverEvaluationReceipt,
  type AuthoritativeSolverEvaluator,
  type SolverArtifactWriter,
} from "./solve";

export interface WhatIfSnapshotAuthority {
  readonly authorityKind: "what-if-snapshot-authority-v1";
  resolveRefreshed(input: {
    scenarioId: string;
    planId: string;
    basePlanVersionId: string;
    beforeConfigHash: string;
    afterConfigHash: string;
    beforeConfig: BuildConfigV3;
    afterConfig: BuildConfigV3;
    lockedBaseSnapshotHashes: SnapshotHashes;
  }): Promise<{ before: SnapshotHashes; after: SnapshotHashes }>;
}

export interface WhatIfDomainDiff {
  schemaVersion: "solver-what-if-domain-diff-v1";
  scenarioId: string;
  domain: string;
  beforeEvaluationHash: string;
  afterEvaluationHash: string;
  beforeReceiptRef: string;
  afterReceiptRef: string;
  before: { verdict: string; domainHash: string } | null;
  after: { verdict: string; domainHash: string } | null;
  changed: boolean;
}

export interface WhatIfDecisionDiff {
  schemaVersion: "solver-what-if-decision-diff-v1";
  scenarioId: string;
  beforeEvaluationHash: string;
  afterEvaluationHash: string;
  beforeReceiptRef: string;
  afterReceiptRef: string;
  changedDomains: string[];
  unchangedDomains: string[];
}

export interface GovernedWhatIfArtifact {
  schemaVersion: "solver-what-if-result-v1";
  scenarioId: string;
  familyId: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  afterConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
  beforeInputHashes: SnapshotHashes;
  afterInputHashes: SnapshotHashes;
  snapshotChangedFields: Array<keyof SnapshotHashes>;
  beforeEvaluationHash: string;
  afterEvaluationHash: string;
  beforeReceiptRef: string;
  afterReceiptRef: string;
  beforeCoverageRef: string;
  afterCoverageRef: string;
  decisionDiffRef: string;
  domainDiffRefs: string[];
  snapshotAttribution: "same_snapshots" | "refreshed";
  proposalOnly: true;
  createdAt: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function changedSnapshotAuthority(before: SnapshotHashes, after: SnapshotHashes): boolean {
  return (Object.keys(before) as Array<keyof SnapshotHashes>)
    .some((field) => field !== "configHash" && before[field] !== after[field]);
}

/**
 * Evaluates an immutable scenario without a PlanRepository dependency. The
 * ordinary acceptance proposal is exposed separately and remains the only path
 * by which a caller may request a draft change.
 */
export class ReadonlyWhatIfService {
  constructor(private readonly options: {
    scenarios: Pick<FileScenarioRepository, "materializeComparison" | "commitAuthoritativeResult" | "proposalForAcceptance">;
    evaluator: AuthoritativeSolverEvaluator;
    artifacts: SolverArtifactWriter;
    snapshotAuthority?: WhatIfSnapshotAuthority;
    now?: () => string;
  }) {
    if (options.evaluator?.authorityKind !== "authoritative-solver-evaluator-v1") throw new TypeError("authoritative what-if evaluator is required");
    if (options.artifacts?.authorityKind !== "solver-artifact-writer-v1") throw new TypeError("what-if artifact authority is required");
    if (options.snapshotAuthority && options.snapshotAuthority.authorityKind !== "what-if-snapshot-authority-v1") {
      throw new TypeError("what-if refreshed snapshot authority is invalid");
    }
  }

  async evaluate(input: { scenarioId: string; refreshSnapshots?: boolean }): Promise<{
    artifactRef: string;
    artifact: GovernedWhatIfArtifact;
    result: PersistedWhatIfResult;
    before: AuthoritativeSolverEvaluationReceipt;
    after: AuthoritativeSolverEvaluationReceipt;
  }> {
    if (!input.scenarioId.trim()) throw new TypeError("what-if scenarioId is invalid");
    const view = await this.options.scenarios.materializeComparison(input.scenarioId);
    const beforeConfigHash = await configV3Hash(view.base.config);
    const afterConfigHash = await configV3Hash(view.config);
    if (beforeConfigHash !== view.family.baseConfigHash || beforeConfigHash !== view.branch.baseConfigHash
      || afterConfigHash !== view.branch.materializedConfigHash) throw new Error("what-if scenario base/materialization is stale");
    let beforeHashes: SnapshotHashes = structuredClone(view.family.baseSnapshotHashes);
    let afterHashes: SnapshotHashes = { ...structuredClone(view.family.baseSnapshotHashes), configHash: afterConfigHash };
    let snapshotAttribution: "same_snapshots" | "refreshed" = "same_snapshots";
    if (input.refreshSnapshots === true) {
      if (!this.options.snapshotAuthority) throw new Error("refreshed what-if snapshots require server authority");
      const refreshed = await this.options.snapshotAuthority.resolveRefreshed({
        scenarioId: input.scenarioId,
        planId: view.family.planId,
        basePlanVersionId: view.family.basePlanVersionId,
        beforeConfigHash,
        afterConfigHash,
        beforeConfig: structuredClone(view.base.config),
        afterConfig: structuredClone(view.config),
        lockedBaseSnapshotHashes: structuredClone(view.family.baseSnapshotHashes),
      });
      beforeHashes = structuredClone(refreshed.before);
      afterHashes = structuredClone(refreshed.after);
      if (beforeHashes.configHash !== beforeConfigHash || afterHashes.configHash !== afterConfigHash) {
        throw new Error("refreshed what-if snapshot authority returned mismatched config hashes");
      }
      snapshotAttribution = changedSnapshotAuthority(view.family.baseSnapshotHashes, beforeHashes)
        || changedSnapshotAuthority(view.family.baseSnapshotHashes, afterHashes)
        ? "refreshed" : "same_snapshots";
    }
    const before = await this.options.evaluator.evaluate({
      planId: view.family.planId,
      basePlanVersionId: view.family.basePlanVersionId,
      candidateConfig: structuredClone(view.base.config),
      expectedInputHashes: beforeHashes,
    });
    assertAuthoritativeSolverEvaluationReceipt(before, {
      planId: view.family.planId,
      basePlanVersionId: view.family.basePlanVersionId,
      configHash: beforeConfigHash,
      snapshotHashes: beforeHashes,
    });
    const after = await this.options.evaluator.evaluate({
      planId: view.family.planId,
      basePlanVersionId: view.family.basePlanVersionId,
      candidateConfig: structuredClone(view.config),
      expectedInputHashes: afterHashes,
    });
    assertAuthoritativeSolverEvaluationReceipt(after, {
      planId: view.family.planId,
      basePlanVersionId: view.family.basePlanVersionId,
      configHash: afterConfigHash,
      snapshotHashes: afterHashes,
    });
    const beforeByDomain = new Map(before.domainCoverage.map((coverage) => [coverage.domain, coverage]));
    const afterByDomain = new Map(after.domainCoverage.map((coverage) => [coverage.domain, coverage]));
    const domains = [...new Set([...beforeByDomain.keys(), ...afterByDomain.keys()])].sort(compareText);
    const domainDiffRefs: string[] = [];
    const changedDomains: string[] = [];
    const unchangedDomains: string[] = [];
    for (const domain of domains) {
      const oldCoverage = beforeByDomain.get(domain);
      const newCoverage = afterByDomain.get(domain);
      const beforeDomain = oldCoverage ? { verdict: oldCoverage.verdict, domainHash: oldCoverage.domainHash } : null;
      const afterDomain = newCoverage ? { verdict: newCoverage.verdict, domainHash: newCoverage.domainHash } : null;
      const changed = canonicalize(beforeDomain) !== canonicalize(afterDomain);
      (changed ? changedDomains : unchangedDomains).push(domain);
      const diff: WhatIfDomainDiff = {
        schemaVersion: "solver-what-if-domain-diff-v1",
        scenarioId: input.scenarioId,
        domain,
        beforeEvaluationHash: before.evaluationHash,
        afterEvaluationHash: after.evaluationHash,
        beforeReceiptRef: before.evaluationReceiptRef,
        afterReceiptRef: after.evaluationReceiptRef,
        before: beforeDomain,
        after: afterDomain,
        changed,
      };
      domainDiffRefs.push((await this.options.artifacts.put({
        kind: "solver-what-if-domain-diff",
        value: diff,
        references: [
          { ref: before.evaluationReceiptRef, necessity: "required_for_replay" },
          { ref: after.evaluationReceiptRef, necessity: "required_for_replay" },
        ],
      })).ref);
    }
    const decisionDiff: WhatIfDecisionDiff = {
      schemaVersion: "solver-what-if-decision-diff-v1",
      scenarioId: input.scenarioId,
      beforeEvaluationHash: before.evaluationHash,
      afterEvaluationHash: after.evaluationHash,
      beforeReceiptRef: before.evaluationReceiptRef,
      afterReceiptRef: after.evaluationReceiptRef,
      changedDomains,
      unchangedDomains,
    };
    const decisionDiffRef = (await this.options.artifacts.put({
      kind: "solver-what-if-decision-diff",
      value: decisionDiff,
      references: [
        { ref: before.evaluationReceiptRef, necessity: "required_for_replay" },
        { ref: after.evaluationReceiptRef, necessity: "required_for_replay" },
      ],
    })).ref;
    const createdAt = (this.options.now ?? (() => new Date().toISOString()))();
    const artifact: GovernedWhatIfArtifact = {
      schemaVersion: "solver-what-if-result-v1",
      scenarioId: input.scenarioId,
      familyId: view.family.familyId,
      basePlanVersionId: view.family.basePlanVersionId,
      baseConfigHash: beforeConfigHash,
      afterConfigHash,
      baseSnapshotHashes: structuredClone(view.family.baseSnapshotHashes),
      beforeInputHashes: structuredClone(before.inputHashes),
      afterInputHashes: structuredClone(after.inputHashes),
      snapshotChangedFields: (Object.keys(before.inputHashes) as Array<keyof SnapshotHashes>)
        .filter((field) => before.inputHashes[field] !== after.inputHashes[field]).sort(compareText),
      beforeEvaluationHash: before.evaluationHash,
      afterEvaluationHash: after.evaluationHash,
      beforeReceiptRef: before.evaluationReceiptRef,
      afterReceiptRef: after.evaluationReceiptRef,
      beforeCoverageRef: before.coverageArtifactRef,
      afterCoverageRef: after.coverageArtifactRef,
      decisionDiffRef,
      domainDiffRefs: [...domainDiffRefs].sort(compareText),
      snapshotAttribution,
      proposalOnly: true,
      createdAt,
    };
    if (snapshotAttribution === "same_snapshots" && changedSnapshotAuthority(before.inputHashes, after.inputHashes)) {
      throw new Error("fixed-snapshot what-if changed non-config snapshot authority");
    }
    const artifactRef = (await this.options.artifacts.put({
      kind: "solver-what-if-result",
      value: artifact,
      references: [
        { ref: before.evaluationReceiptRef, necessity: "required_for_replay" },
        { ref: after.evaluationReceiptRef, necessity: "required_for_replay" },
        { ref: before.coverageArtifactRef, necessity: "required_for_replay" },
        { ref: after.coverageArtifactRef, necessity: "required_for_replay" },
        { ref: decisionDiffRef, necessity: "required_for_replay" },
        ...artifact.domainDiffRefs.map((ref) => ({ ref, necessity: "required_for_replay" as const })),
      ],
    })).ref;
    const result: PersistedWhatIfResult = {
      schemaVersion: "1.0.0",
      createdAt,
      scenarioId: artifact.scenarioId,
      beforeConfigHash,
      afterConfigHash,
      patchHash: view.branch.patchHash,
      beforeEvaluationHash: artifact.beforeEvaluationHash,
      afterEvaluationHash: artifact.afterEvaluationHash,
      decisionDiffRef,
      domainDiffRefs: artifact.domainDiffRefs,
      snapshotAttribution,
    };
    const confirmation = await this.options.scenarios.materializeComparison(input.scenarioId);
    if (canonicalize({ family: confirmation.family, branch: confirmation.branch, base: confirmation.base, config: confirmation.config })
      !== canonicalize({ family: view.family, branch: view.branch, base: view.base, config: view.config })) {
      throw new Error("what-if scenario authority changed before result commit");
    }
    await this.options.scenarios.commitAuthoritativeResult({
      scenarioId: input.scenarioId,
      expectedRuntimeGeneration: confirmation.runtimeBinding.runtimeGeneration,
      expectedRuntimeRevision: confirmation.runtimeBinding.runtimeRevision,
      result,
      authority: { artifactRef, artifact },
    });
    return { artifactRef, artifact, result, before, after };
  }

  /** Returns the existing ordinary proposal object; it performs no write. */
  proposalForAcceptance(
    scenarioId: string,
    current: { planId: string; planVersionId: string; configHash: string; draftRevision: number },
  ): Promise<ScenarioAcceptanceProposal> {
    return this.options.scenarios.proposalForAcceptance(scenarioId, current);
  }
}

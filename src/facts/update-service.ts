import type { FactSnapshot } from "./contracts";
import type {
  FactUpdateDecisionCommit,
  FactSnapshotLookup,
  PutUpdateDecisionInput,
  UpdateDecisionRepository,
} from "./update-decision-repository";
import {
  createFactUpdateEvaluationDiff,
  verifySnapshotEvaluationReceipt,
  type FactUpdateEvaluationDiff,
  type SnapshotEvaluationReceipt,
} from "./update-evaluation";

export type { FactUpdateEvaluationDiff, SnapshotEvaluationReceipt } from "./update-evaluation";

export interface FactUpdateResult extends FactUpdateDecisionCommit {}

export type FactUpdateDecisionInput = Omit<PutUpdateDecisionInput, "evaluationDiffs">;

export interface FactUpdateServiceOptions {
  decisions: UpdateDecisionRepository;
  snapshots: FactSnapshotLookup;
  /** Exact active generation that authorized this notice decision, when root-bound authority is available. */
  expectedRuntimeGeneration?: number;
  /**
   * Internal authority adapter only. Production composition must resolve the
   * exact plan target and the supplied immutable snapshot in repositories; it
   * must never accept snapshot bytes or hashes from transport callers.
   */
  evaluate(planId: string, snapshot: Readonly<FactSnapshot>): Promise<SnapshotEvaluationReceipt>;
  evaluateAtRoot?(
    activeRoot: string,
    planId: string,
    snapshot: Readonly<FactSnapshot>,
  ): Promise<SnapshotEvaluationReceipt>;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class FactUpdateService {
  constructor(private readonly options: FactUpdateServiceOptions) {}

  private async evaluateRef(planId: string, snapshot: FactSnapshot, activeRoot?: string): Promise<SnapshotEvaluationReceipt> {
    const receipt = activeRoot && this.options.evaluateAtRoot
      ? await this.options.evaluateAtRoot(activeRoot, planId, Object.freeze(clone(snapshot)))
      : await this.options.evaluate(planId, Object.freeze(clone(snapshot)));
    if (!await verifySnapshotEvaluationReceipt(receipt)
      || receipt.planId !== planId
      || receipt.factSnapshotId !== snapshot.snapshotId
      || receipt.factSnapshotHash !== snapshot.contentHash
      || (this.options.expectedRuntimeGeneration !== undefined
        && receipt.runtimeGeneration !== this.options.expectedRuntimeGeneration)) {
      throw new Error("fact update evaluator receipt is not bound to its exact plan and snapshot authority");
    }
    return clone(receipt);
  }

  private async evaluationDiffs(
    input: FactUpdateDecisionInput,
    oldSnapshot: FactSnapshot,
    newSnapshot: FactSnapshot,
    activeRoot?: string,
  ): Promise<FactUpdateEvaluationDiff[]> {
    const decision = input.decision;
    return Promise.all([...decision.planIds].sort().map(async (planId) => {
      const [oldEvaluation, newEvaluation] = await Promise.all([
        this.evaluateRef(planId, oldSnapshot, activeRoot),
        this.evaluateRef(planId, newSnapshot, activeRoot),
      ]);
      if (oldEvaluation.runtimeGeneration !== newEvaluation.runtimeGeneration) {
        throw new Error("fact update evaluator receipts changed runtime generation between snapshots");
      }
      const before = decision.decision === "undo" ? newEvaluation : oldEvaluation;
      const after = decision.decision === "undo" ? oldEvaluation : newEvaluation;
      const changedDomains = [...decision.affectedDomains].sort()
        .filter((domain) => before.domainHashes[domain] !== after.domainHashes[domain]);
      const fieldDiffs = (decision.decision === "undo"
        ? decision.fieldDiffs.map((field) => ({
          field: field.field,
          beforeFactIds: [...field.afterFactIds].sort(),
          afterFactIds: [...field.beforeFactIds].sort(),
        }))
        : decision.fieldDiffs.map((field) => ({
          field: field.field,
          beforeFactIds: [...field.beforeFactIds].sort(),
          afterFactIds: [...field.afterFactIds].sort(),
        }))).sort((left, right) => left.field.localeCompare(right.field));
      return createFactUpdateEvaluationDiff({
        updateDecisionId: decision.updateDecisionId,
        updateDecisionHash: decision.contentHash,
        planId,
        before,
        after,
        changedDomains,
        fieldDiffs,
      });
    }));
  }

  async decide(input: FactUpdateDecisionInput): Promise<FactUpdateResult> {
    const decision = clone(input.decision);

    // A retry after the commit point is a pure replay. In particular, it must
    // not call today's evaluator and accidentally replace the original receipt.
    const committed = await this.options.decisions.getActiveDecisionResult(decision);
    if (committed) return committed;

    // A crash anywhere after the atomic preparation write can be resumed from
    // the exact original receipts, even if no decision/diff file or pointer was
    // installed yet.
    const prepared = await this.options.decisions.getPreparedDecision(decision.updateDecisionId);
    if (prepared) {
      return this.options.decisions.putDecision({
        ...input,
        decision,
        evaluationDiffs: prepared.evaluationDiffs,
      });
    }

    if (decision.decision !== "accept" && decision.decision !== "undo") {
      return this.options.decisions.putDecision({ ...input, decision });
    }

    // Evaluation is intentionally outside the repository writer boundary. No
    // decision, diff, or memory authority exists if any plan/snapshot fails.
    const [oldSnapshot, newSnapshot] = await Promise.all([
      this.options.snapshots.getSnapshot(decision.oldSnapshotRef.snapshotId),
      this.options.snapshots.getSnapshot(decision.newSnapshotRef.snapshotId),
    ]);
    if (oldSnapshot.contentHash !== decision.oldSnapshotRef.contentHash
      || newSnapshot.contentHash !== decision.newSnapshotRef.contentHash) {
      throw new Error("fact update snapshots changed before evaluation");
    }
    const evaluationDiffs = await this.evaluationDiffs(input, oldSnapshot, newSnapshot);
    return this.options.decisions.putDecision({ ...input, decision, evaluationDiffs });
  }

  /** Root-bound variant for a composition already holding the runtime barrier. */
  async decideAtRoot(activeRoot: string, input: FactUpdateDecisionInput): Promise<FactUpdateResult> {
    const decision = clone(input.decision);
    const committed = await this.options.decisions.getActiveDecisionResultAtRoot(activeRoot, decision);
    if (committed) return committed;
    const prepared = await this.options.decisions.getPreparedDecisionAtRoot(activeRoot, decision.updateDecisionId);
    if (prepared) {
      return this.options.decisions.putDecisionAtRoot(activeRoot, {
        ...input,
        decision,
        evaluationDiffs: prepared.evaluationDiffs,
      });
    }
    if (decision.decision !== "accept" && decision.decision !== "undo") {
      return this.options.decisions.putDecisionAtRoot(activeRoot, { ...input, decision });
    }
    if (!this.options.snapshots.getSnapshotAtRoot) throw new Error("root-bound fact snapshot lookup is unavailable");
    const [oldSnapshot, newSnapshot] = await Promise.all([
      this.options.snapshots.getSnapshotAtRoot(activeRoot, decision.oldSnapshotRef.snapshotId),
      this.options.snapshots.getSnapshotAtRoot(activeRoot, decision.newSnapshotRef.snapshotId),
    ]);
    if (!oldSnapshot || !newSnapshot
      || oldSnapshot.contentHash !== decision.oldSnapshotRef.contentHash
      || newSnapshot.contentHash !== decision.newSnapshotRef.contentHash) {
      throw new Error("fact update snapshots changed before root-bound evaluation");
    }
    const evaluationDiffs = await this.evaluationDiffs(input, oldSnapshot, newSnapshot, activeRoot);
    return this.options.decisions.putDecisionAtRoot(activeRoot, { ...input, decision, evaluationDiffs });
  }
}

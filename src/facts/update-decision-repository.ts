import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json, withDirectoryLock } from "../runtime/fs.mjs";
import { validateConflictSet, type FactRecord, type FactSnapshot, type UpdateDecision } from "./contracts";
import { verifyConflictSet } from "./conflicts";
import type { FactUpdateConflictTransition } from "./repository";
import { verifyFactRecord } from "./hash";
import { factSubjectKey } from "./resolver";
import { verifyFactSnapshot } from "./snapshots";
import {
  requiredEvaluationDomainsForFactField,
  validateFactUpdateEvaluationDiffClosure,
  verifyFactUpdateEvaluationDiff,
  type FactUpdateEvaluationDiff,
} from "./update-evaluation";
import {
  verifyFactUpdateNotice,
  type FactUpdateNotice,
} from "./update-notices";
import { selectedFactSnapshotRef, verifyUpdateDecision } from "./update-decisions";

const DECISION_ID = /^update-decision-sha256-[a-f0-9]{64}$/;
const DIFF_ID = /^fact-update-evaluation-diff-sha256-[a-f0-9]{64}$/;
const TRANSACTION_ID = /^fact-update-transaction-sha256-[a-f0-9]{64}$/;
const NOTICE_ID = /^fact-update-notice-sha256-[a-f0-9]{64}$/;
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export interface FactSnapshotLookup {
  getSnapshot(snapshotId: string): Promise<FactSnapshot>;
  getSnapshotAtRoot?(activeRoot: string, snapshotId: string): Promise<FactSnapshot | null>;
  getFact(factId: string): Promise<FactRecord>;
  getFactAtRoot?(activeRoot: string, factId: string): Promise<FactRecord | null>;
  prepareUpdateConflictTransitions?(decision: UpdateDecision): Promise<FactUpdateConflictTransition[]>;
  prepareUpdateConflictTransitionsAtRoot?(activeRoot: string, decision: UpdateDecision): Promise<FactUpdateConflictTransition[]>;
  publishUpdateConflictTransitions?(decision: UpdateDecision, transitions: readonly FactUpdateConflictTransition[]): Promise<void>;
  publishUpdateConflictTransitionsAtRoot?(
    activeRoot: string,
    decision: UpdateDecision,
    transitions: readonly FactUpdateConflictTransition[],
  ): Promise<void>;
}

interface DecisionEnvelope {
  schemaVersion: "fact-update-decision-envelope-v1";
  kind: "decision";
  checksum: string;
  payload: UpdateDecision;
}

interface DecisionMemory {
  schemaVersion: "fact-update-memory-v1";
  memoryKey: string;
  revision: number;
  decisionId: string;
  decisionHash: string;
  selectedSnapshotRef: UpdateDecision["oldSnapshotRef"];
  updatedAt: string;
}

interface MemoryEnvelope {
  schemaVersion: "fact-update-decision-envelope-v1";
  kind: "memory";
  checksum: string;
  payload: DecisionMemory;
}

export interface FactUpdatePlanPointer {
  schemaVersion: "fact-update-plan-pointer-v1";
  planKey: string;
  planId: string;
  revision: number;
  decisionId: string;
  decisionHash: string;
  decisionMemoryKey: string;
  selectedSnapshotRef: UpdateDecision["oldSnapshotRef"];
  previousSnapshotRef: UpdateDecision["oldSnapshotRef"];
  previousDecisionId?: string;
  previousDecisionHash?: string;
  updatedAt: string;
}

interface PlanPointerEnvelope {
  schemaVersion: "fact-update-plan-pointer-envelope-v1";
  kind: "plan-pointer";
  checksum: string;
  payload: FactUpdatePlanPointer;
}

interface EvaluationDiffEnvelope {
  schemaVersion: "fact-update-evaluation-diff-envelope-v1";
  kind: "evaluation-diff";
  checksum: string;
  payload: FactUpdateEvaluationDiff;
}

interface UpdateNoticeEnvelope {
  schemaVersion: "fact-update-notice-envelope-v1";
  kind: "notice";
  checksum: string;
  payload: FactUpdateNotice;
}

export interface PreparedUpdateDecision {
  schemaVersion: "fact-update-decision-transaction-v1";
  transactionId: string;
  memoryKey: string;
  decision: UpdateDecision;
  evaluationDiffs: FactUpdateEvaluationDiff[];
  conflictTransitions: FactUpdateConflictTransition[];
  contentHash: string;
}

interface TransactionEnvelope {
  schemaVersion: "fact-update-decision-transaction-envelope-v1";
  kind: "transaction";
  checksum: string;
  payload: PreparedUpdateDecision;
}

export interface FactUpdateDecisionCommit {
  decision: UpdateDecision;
  selectedSnapshotRef: UpdateDecision["oldSnapshotRef"];
  evaluationDiffs: FactUpdateEvaluationDiff[];
  /** Compatibility view for decisions affecting exactly one plan. */
  evaluationDiff?: FactUpdateEvaluationDiff;
}

export type UpdateDecisionWriteFailurePoint =
  | "after_prepare"
  | "after_decision"
  | "after_evaluation_diff"
  | "after_plan_pointer"
  | "after_conflict_pointer"
  | "before_memory"
  | "after_memory";

export interface UpdateDecisionWriteFailureContext {
  decisionId: string;
  memoryKey: string;
  evaluationDiffId?: string;
}

export class UpdateDecisionRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input", message: string) {
    super(message);
    this.name = "UpdateDecisionRepositoryError";
  }
}

export interface UpdateDecisionRepositoryOptions {
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  snapshots: FactSnapshotLookup;
  now?: () => string;
  /** Test/operations hook. Throwing simulates a process failure at a durable write boundary. */
  failureInjector?: (
    point: UpdateDecisionWriteFailurePoint,
    context: Readonly<UpdateDecisionWriteFailureContext>,
  ) => void | Promise<void>;
}

export interface PutUpdateDecisionInput {
  decision: UpdateDecision;
  expectedMemoryRevision: number;
  /** Required, with exactly one receipt per plan, for accept and undo. Forbidden otherwise. */
  evaluationDiffs?: readonly FactUpdateEvaluationDiff[];
  /**
   * Internal root-bound authority check. It runs while the repository owns the
   * coordinator writer and immediately before the first durable transaction
   * write. Implementations must use only root-bound readers and must not re-enter
   * the coordinator.
   */
  precommitAuthorizer?: UpdateDecisionPrecommitAuthorizer;
  maintenanceLeaseToken?: string;
}

export interface UpdateDecisionPrecommitContext {
  activeRoot: string;
  runtimeGeneration: number;
  decision: UpdateDecision;
  expectedMemoryRevision: number;
  preparedTransaction: PreparedUpdateDecision;
}

export type UpdateDecisionPrecommitAuthorizer = (
  context: Readonly<UpdateDecisionPrecommitContext>,
) => void | Promise<void>;

type EnvelopeKind = "decision" | "memory" | "plan-pointer" | "evaluation-diff" | "transaction" | "notice";

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return unique(left) && unique(right) && same([...left].sort(), [...right].sort());
}

function decisionRevision(subject: Extract<FactRecord["subject"], { kind: "product" }>): string {
  return subject.revision ?? subject.variantId ?? subject.modelId ?? subject.familyId ?? subject.skuId;
}

function canonicalString(value: string, maxLength = 256): boolean {
  if (!value || value.length > maxLength || value !== value.normalize("NFC")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function factUpdateDecisionTransactionContentHash(
  value: Omit<PreparedUpdateDecision, "transactionId" | "contentHash"> | PreparedUpdateDecision,
): string {
  const material = clone(value) as Partial<PreparedUpdateDecision>;
  delete material.transactionId;
  delete material.contentHash;
  return sha256Json({
    domain: "fact-update-decision-transaction",
    schemaVersion: "fact-update-decision-transaction-v1",
    canonicalizationPolicyId: "canonical-json-v1",
    payload: material,
  });
}

export class UpdateDecisionRepository {
  private readonly root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly snapshots: FactSnapshotLookup;
  private readonly now: () => string;
  private readonly failureInjector: UpdateDecisionRepositoryOptions["failureInjector"];

  constructor(options: UpdateDecisionRepositoryOptions) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? options.coordinator?.root ?? path.join(process.cwd(), "runtime"));
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, "facts"));
    this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
    this.snapshots = options.snapshots;
    this.now = options.now ?? (() => new Date().toISOString());
    this.failureInjector = options.failureInjector;
  }

  private decisionFile(factsRoot: string, decisionId: string): string {
    if (!DECISION_ID.test(decisionId)) throw new UpdateDecisionRepositoryError("invalid_input", "update decision ID invalid");
    return confined(factsRoot, "update-decisions", "records", `${decisionId}.json`);
  }

  private diffFile(factsRoot: string, diffId: string): string {
    if (!DIFF_ID.test(diffId)) throw new UpdateDecisionRepositoryError("invalid_input", "update evaluation diff ID invalid");
    return confined(factsRoot, "update-decisions", "evaluation-diffs", `${diffId}.json`);
  }

  private transactionFile(factsRoot: string, decisionId: string): string {
    if (!DECISION_ID.test(decisionId)) throw new UpdateDecisionRepositoryError("invalid_input", "update decision ID invalid");
    return confined(factsRoot, "update-decisions", "transactions", `${decisionId}.json`);
  }

  private noticeFile(factsRoot: string, noticeId: string): string {
    if (!NOTICE_ID.test(noticeId)) throw new UpdateDecisionRepositoryError("invalid_input", "fact update notice ID invalid");
    return confined(factsRoot, "update-decisions", "notices", `${noticeId}.json`);
  }

  private memoryKey(decision: Pick<UpdateDecision, "subjectKey" | "claimKey" | "revision" | "planIds">): string {
    return sha256Json({ subjectKey: decision.subjectKey, claimKey: decision.claimKey, revision: decision.revision, planIds: [...decision.planIds].sort() });
  }

  private memoryFile(factsRoot: string, memoryKey: string): string {
    return confined(factsRoot, "update-decisions", "memory", `${memoryKey}.json`);
  }

  private planKey(planId: string): string {
    if (!PLAN_ID.test(planId)) throw new UpdateDecisionRepositoryError("invalid_input", "update plan ID invalid");
    return sha256Json({ planId });
  }

  private planPointerFile(factsRoot: string, planId: string): string {
    return confined(factsRoot, "update-decisions", "plan-pointers", `${this.planKey(planId)}.json`);
  }

  private async boundary<T>(
    write: boolean,
    operation: (
      factsRoot: string,
      activeRoot?: string,
      runtimeState?: Readonly<{ runtimeGeneration: number; revision: number }>,
    ) => Promise<T>,
    maintenanceLeaseToken?: string,
  ): Promise<T> {
    if (this.coordinator) {
      await this.coordinator.initialize();
      if (write) {
        return (await this.coordinator.withWrite(
          ({ activeRoot, state }: {
            activeRoot: string;
            state: { runtimeGeneration: number; revision: number };
          }) => operation(confined(activeRoot, "facts"), activeRoot, state),
          { maintenanceLeaseToken },
        )).result as T;
      }
      return (await this.coordinator.withConsistentSnapshot(
        ({ activeRoot }: { activeRoot: string }) => operation(confined(activeRoot, "facts"), activeRoot),
      )).result as T;
    }
    return withDirectoryLock(confined(this.root, ".locks", "update-decision-repository"), () => operation(this.root));
  }

  private async inject(point: UpdateDecisionWriteFailurePoint, context: UpdateDecisionWriteFailureContext): Promise<void> {
    await this.failureInjector?.(point, Object.freeze(clone(context)));
  }

  private async readEnvelope<T>(
    file: string,
    expected: { schemaVersion: string; kind: EnvelopeKind },
    optional = false,
  ): Promise<T | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (optional) return null;
        throw new UpdateDecisionRepositoryError("not_found", `update ${expected.kind} was not found`);
      }
      throw new UpdateDecisionRepositoryError("corrupt_data", `update ${expected.kind} cannot be read`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", `update ${expected.kind} envelope invalid`);
    }
    const envelope = parsed as { schemaVersion?: unknown; kind?: unknown; checksum?: unknown; payload?: unknown };
    if (Object.keys(envelope).length !== 4 || Object.keys(envelope).some((key) => !["schemaVersion", "kind", "checksum", "payload"].includes(key))
      || envelope.schemaVersion !== expected.schemaVersion || envelope.kind !== expected.kind
      || !("payload" in envelope) || envelope.checksum !== sha256Json(envelope.payload)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", `update ${expected.kind} envelope checksum invalid`);
    }
    return clone(envelope.payload as T);
  }

  private async readDecisionAt(factsRoot: string, decisionId: string): Promise<UpdateDecision> {
    const decision = await this.readEnvelope<UpdateDecision>(this.decisionFile(factsRoot, decisionId), {
      schemaVersion: "fact-update-decision-envelope-v1", kind: "decision",
    });
    if (!decision || decision.updateDecisionId !== decisionId || !await verifyUpdateDecision(decision)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "update decision authority invalid");
    }
    return decision;
  }

  private async readDiffAt(factsRoot: string, diffId: string): Promise<FactUpdateEvaluationDiff> {
    const diff = await this.readEnvelope<FactUpdateEvaluationDiff>(this.diffFile(factsRoot, diffId), {
      schemaVersion: "fact-update-evaluation-diff-envelope-v1", kind: "evaluation-diff",
    });
    if (!diff || diff.evaluationDiffId !== diffId || !await verifyFactUpdateEvaluationDiff(diff)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "update evaluation diff authority invalid");
    }
    return diff;
  }

  private async readNoticeAt(factsRoot: string, noticeId: string): Promise<FactUpdateNotice> {
    const notice = await this.readEnvelope<FactUpdateNotice>(this.noticeFile(factsRoot, noticeId), {
      schemaVersion: "fact-update-notice-envelope-v1", kind: "notice",
    });
    if (!notice || notice.updateNoticeId !== noticeId || !verifyFactUpdateNotice(notice)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "fact update notice authority invalid");
    }
    return notice;
  }

  private async validateDiffSet(decision: UpdateDecision, value: readonly FactUpdateEvaluationDiff[] | undefined): Promise<FactUpdateEvaluationDiff[]> {
    const diffs = clone(value ? [...value] : []).sort((left, right) => left.planId.localeCompare(right.planId));
    const needsDiffs = decision.decision === "accept" || decision.decision === "undo";
    if (!needsDiffs && diffs.length) throw new UpdateDecisionRepositoryError("invalid_input", "reject/defer decisions must not carry evaluation diffs");
    if (!needsDiffs) return [];
    if (diffs.length !== decision.planIds.length || !sameStringSet(diffs.map((diff) => diff.planId), decision.planIds)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "accept/undo requires exactly one evaluation diff for every plan");
    }
    for (const diff of diffs) {
      const errors = await validateFactUpdateEvaluationDiffClosure(diff, decision);
      if (errors.length) throw new UpdateDecisionRepositoryError("invalid_input", errors.join("; "));
    }
    return diffs;
  }

  private conflictStaticAuthority(value: FactUpdateConflictTransition["before"]): Record<string, unknown> {
    const material = clone(value) as unknown as Record<string, unknown>;
    delete material.status;
    delete material.resolutionFactIds;
    delete material.decisionIds;
    delete material.resolvedAt;
    delete material.contentHash;
    return material;
  }

  private async validateConflictTransitionSet(
    decision: UpdateDecision,
    value: readonly FactUpdateConflictTransition[] | undefined,
  ): Promise<FactUpdateConflictTransition[]> {
    const transitions = clone(value ? [...value] : []).sort((left, right) => (
      left.pointer.conflictSetId.localeCompare(right.pointer.conflictSetId)
    ));
    if (decision.decision !== "accept" && decision.decision !== "undo") {
      if (transitions.length) throw new UpdateDecisionRepositoryError("invalid_input", "reject/defer cannot carry conflict transitions");
      return [];
    }
    if (new Set(transitions.map((transition) => transition.pointer.conflictSetId)).size !== transitions.length) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update transaction contains duplicate conflict transitions");
    }
    for (const transition of transitions) {
      const pointer = transition.pointer;
      const allowedTransition = ["schemaVersion", "pointer", "before", "after"];
      const allowedPointer = [
        "schemaVersion", "conflictKey", "conflictSetId", "revision", "decisionId", "decisionHash",
        "decisionMemoryKey", "selectedConflictRef", "previousConflictRef", "previousDecisionId",
        "previousDecisionHash", "updatedAt",
      ];
      const previousPresent = pointer.previousDecisionId !== undefined || pointer.previousDecisionHash !== undefined;
      if (!transition || Object.keys(transition).length !== allowedTransition.length
        || Object.keys(transition).some((key) => !allowedTransition.includes(key))
        || transition.schemaVersion !== "fact-update-conflict-transition-v1"
        || !pointer || Object.keys(pointer).some((key) => !allowedPointer.includes(key))
        || pointer.schemaVersion !== "fact-update-conflict-pointer-v1"
        || pointer.conflictKey !== sha256Json({ conflictSetId: pointer.conflictSetId })
        || pointer.decisionId !== decision.updateDecisionId || pointer.decisionHash !== decision.contentHash
        || pointer.decisionMemoryKey !== this.memoryKey(decision)
        || pointer.conflictSetId !== transition.before.conflictSetId
        || pointer.conflictSetId !== transition.after.conflictSetId
        || pointer.previousConflictRef?.conflictSetId !== pointer.conflictSetId
        || pointer.previousConflictRef?.contentHash !== transition.before.contentHash
        || pointer.selectedConflictRef?.conflictSetId !== pointer.conflictSetId
        || pointer.selectedConflictRef?.contentHash !== transition.after.contentHash
        || !Number.isInteger(pointer.revision) || pointer.revision < 0 || !isoTimestamp(pointer.updatedAt)
        || previousPresent !== (pointer.previousDecisionId !== undefined && pointer.previousDecisionHash !== undefined)
        || (pointer.previousDecisionId !== undefined
          && pointer.previousDecisionId !== `update-decision-sha256-${pointer.previousDecisionHash}`)
        || validateConflictSet(transition.before).length || validateConflictSet(transition.after).length
        || !await verifyConflictSet(transition.before) || !await verifyConflictSet(transition.after)
        || !same(this.conflictStaticAuthority(transition.before), this.conflictStaticAuthority(transition.after))) {
        throw new UpdateDecisionRepositoryError("invalid_input", "update transaction conflict transition authority invalid");
      }
      if (decision.decision === "accept") {
        if (transition.before.status !== "open" || transition.after.status !== "resolved"
          || !same(transition.after.resolutionFactIds, decision.newFactIds)
          || !same(transition.after.decisionIds, [decision.updateDecisionId])
          || transition.after.resolvedAt !== decision.decidedAt
          || (pointer.revision === 0 && previousPresent)
          || (pointer.revision > 0 && !previousPresent)) {
          throw new UpdateDecisionRepositoryError("invalid_input", "accepted update conflict transition closure invalid");
        }
      } else if (transition.before.status !== "resolved" || transition.after.status !== "open"
        || !decision.supersedesDecisionId || !transition.before.decisionIds.includes(decision.supersedesDecisionId)
        || pointer.previousDecisionId !== decision.supersedesDecisionId
        || pointer.previousDecisionHash !== decision.supersedesDecisionHash) {
        throw new UpdateDecisionRepositoryError("invalid_input", "undo conflict transition closure invalid");
      }
    }
    return transitions;
  }

  private createTransaction(
    decision: UpdateDecision,
    evaluationDiffs: FactUpdateEvaluationDiff[],
    conflictTransitions: FactUpdateConflictTransition[],
  ): PreparedUpdateDecision {
    const material = {
      schemaVersion: "fact-update-decision-transaction-v1" as const,
      memoryKey: this.memoryKey(decision),
      decision: clone(decision),
      evaluationDiffs: clone(evaluationDiffs),
      conflictTransitions: clone(conflictTransitions),
    };
    const contentHash = factUpdateDecisionTransactionContentHash(material);
    return {
      ...material,
      transactionId: `fact-update-transaction-sha256-${contentHash}`,
      contentHash,
    };
  }

  private async readTransactionAt(factsRoot: string, decisionId: string): Promise<PreparedUpdateDecision> {
    const transaction = await this.readEnvelope<PreparedUpdateDecision>(this.transactionFile(factsRoot, decisionId), {
      schemaVersion: "fact-update-decision-transaction-envelope-v1", kind: "transaction",
    });
    if (!transaction || Object.keys(transaction).length !== 7
      || Object.keys(transaction).some((key) => !["schemaVersion", "transactionId", "memoryKey", "decision", "evaluationDiffs", "conflictTransitions", "contentHash"].includes(key))
      || transaction.schemaVersion !== "fact-update-decision-transaction-v1"
      || transaction.decision.updateDecisionId !== decisionId
      || !TRANSACTION_ID.test(transaction.transactionId)
      || transaction.transactionId !== `fact-update-transaction-sha256-${transaction.contentHash}`
      || transaction.contentHash !== factUpdateDecisionTransactionContentHash(transaction)
      || transaction.memoryKey !== this.memoryKey(transaction.decision)
      || !await verifyUpdateDecision(transaction.decision)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "update decision transaction authority invalid");
    }
    try {
      const diffs = await this.validateDiffSet(transaction.decision, transaction.evaluationDiffs);
      if (!same(diffs, transaction.evaluationDiffs)) {
        throw new UpdateDecisionRepositoryError("corrupt_data", "update decision transaction diff order is non-canonical");
      }
      const transitions = await this.validateConflictTransitionSet(transaction.decision, transaction.conflictTransitions);
      if (!same(transitions, transaction.conflictTransitions)) {
        throw new UpdateDecisionRepositoryError("corrupt_data", "update decision transaction conflict transition order is non-canonical");
      }
    } catch (error) {
      if (error instanceof UpdateDecisionRepositoryError && error.code === "invalid_input") {
        throw new UpdateDecisionRepositoryError("corrupt_data", `update decision transaction closure invalid: ${error.message}`);
      }
      throw error;
    }
    return transaction;
  }

  private async readPublishedResultAt(factsRoot: string, decisionId: string): Promise<FactUpdateDecisionCommit> {
    const decision = await this.readDecisionAt(factsRoot, decisionId);
    const transaction = await this.readTransactionAt(factsRoot, decisionId);
    if (!same(transaction.decision, decision)) throw new UpdateDecisionRepositoryError("corrupt_data", "update transaction decision payload mismatch");
    const evaluationDiffs = await Promise.all(transaction.evaluationDiffs.map(async (reference) => {
      const persisted = await this.readDiffAt(factsRoot, reference.evaluationDiffId);
      if (!same(persisted, reference)) throw new UpdateDecisionRepositoryError("corrupt_data", "update transaction diff payload mismatch");
      return persisted;
    }));
    const selectedSnapshotRef = selectedFactSnapshotRef(decision);
    return {
      decision,
      selectedSnapshotRef,
      evaluationDiffs,
      ...(evaluationDiffs.length === 1 ? { evaluationDiff: evaluationDiffs[0] } : {}),
    };
  }

  private async readMemoryAt(factsRoot: string, memoryKey: string): Promise<DecisionMemory | null> {
    const memory = await this.readEnvelope<DecisionMemory>(this.memoryFile(factsRoot, memoryKey), {
      schemaVersion: "fact-update-decision-envelope-v1", kind: "memory",
    }, true);
    if (!memory) return null;
    if (Object.keys(memory).length !== 7
      || Object.keys(memory).some((key) => !["schemaVersion", "memoryKey", "revision", "decisionId", "decisionHash", "selectedSnapshotRef", "updatedAt"].includes(key))
      || memory.schemaVersion !== "fact-update-memory-v1" || memory.memoryKey !== memoryKey
      || !Number.isInteger(memory.revision) || memory.revision < 0 || !DECISION_ID.test(memory.decisionId)
      || memory.decisionId !== `update-decision-sha256-${memory.decisionHash}` || !isoTimestamp(memory.updatedAt)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "update decision memory authority invalid");
    }
    const committed = await this.readPublishedResultAt(factsRoot, memory.decisionId);
    if (committed.decision.contentHash !== memory.decisionHash || committed.decision.memoryRevision !== memory.revision
      || !same(committed.selectedSnapshotRef, memory.selectedSnapshotRef)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "update decision memory closure invalid");
    }
    return memory;
  }

  private async decisionInCurrentMemoryChainAt(factsRoot: string, decisionId: string, memoryKey: string): Promise<boolean> {
    const memory = await this.readMemoryAt(factsRoot, memoryKey);
    if (!memory) return false;
    const visited = new Set<string>();
    let current: UpdateDecision | null = await this.readDecisionAt(factsRoot, memory.decisionId);
    while (current) {
      if (visited.has(current.updateDecisionId)) throw new UpdateDecisionRepositoryError("corrupt_data", "update decision memory chain contains a cycle");
      visited.add(current.updateDecisionId);
      if (current.updateDecisionId === decisionId) return true;
      current = current.supersedesDecisionId ? await this.readDecisionAt(factsRoot, current.supersedesDecisionId) : null;
    }
    return false;
  }

  private async readPlanPointerAt(factsRoot: string, planId: string, optional = false): Promise<FactUpdatePlanPointer | null> {
    const pointer = await this.readEnvelope<FactUpdatePlanPointer>(this.planPointerFile(factsRoot, planId), {
      schemaVersion: "fact-update-plan-pointer-envelope-v1", kind: "plan-pointer",
    }, optional);
    if (!pointer) return null;
    const allowed = [
      "schemaVersion", "planKey", "planId", "revision", "decisionId", "decisionHash", "decisionMemoryKey",
      "selectedSnapshotRef", "previousSnapshotRef", "previousDecisionId", "previousDecisionHash", "updatedAt",
    ];
    const required = allowed.filter((key) => key !== "previousDecisionId" && key !== "previousDecisionHash");
    const keys = Object.keys(pointer);
    const previousPresent = pointer.previousDecisionId !== undefined || pointer.previousDecisionHash !== undefined;
    if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))
      || keys.length !== required.length + (previousPresent ? 2 : 0)
      || pointer.schemaVersion !== "fact-update-plan-pointer-v1" || pointer.planId !== planId
      || pointer.planKey !== this.planKey(planId) || !Number.isInteger(pointer.revision) || pointer.revision < 0
      || !DECISION_ID.test(pointer.decisionId) || pointer.decisionId !== `update-decision-sha256-${pointer.decisionHash}`
      || !/^[a-f0-9]{64}$/.test(pointer.decisionMemoryKey) || !isoTimestamp(pointer.updatedAt)
      || previousPresent !== (pointer.previousDecisionId !== undefined && pointer.previousDecisionHash !== undefined)
      || (previousPresent && (pointer.revision === 0 || !DECISION_ID.test(pointer.previousDecisionId!)
        || pointer.previousDecisionId !== `update-decision-sha256-${pointer.previousDecisionHash}`))) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "fact update plan pointer authority invalid");
    }
    const decision = await this.readDecisionAt(factsRoot, pointer.decisionId);
    const beforeRef = decision.decision === "undo" ? decision.newSnapshotRef : decision.oldSnapshotRef;
    if ((decision.decision !== "accept" && decision.decision !== "undo") || !decision.planIds.includes(planId)
      || decision.contentHash !== pointer.decisionHash || this.memoryKey(decision) !== pointer.decisionMemoryKey
      || !same(selectedFactSnapshotRef(decision), pointer.selectedSnapshotRef) || !same(beforeRef, pointer.previousSnapshotRef)) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "fact update plan pointer decision closure invalid");
    }
    if (previousPresent) {
      const previous = await this.readDecisionAt(factsRoot, pointer.previousDecisionId!);
      if (previous.contentHash !== pointer.previousDecisionHash || !previous.planIds.includes(planId)
        || !same(selectedFactSnapshotRef(previous), pointer.previousSnapshotRef)) {
        throw new UpdateDecisionRepositoryError("corrupt_data", "fact update plan pointer previous-decision closure invalid");
      }
    }
    return pointer;
  }

  private async resolvedPlanPointerAt(factsRoot: string, planId: string): Promise<{
    pointer: FactUpdatePlanPointer;
    selectedSnapshotRef: UpdateDecision["oldSnapshotRef"];
    pending: boolean;
  } | null> {
    const pointer = await this.readPlanPointerAt(factsRoot, planId, true);
    if (!pointer) return null;
    const committed = await this.decisionInCurrentMemoryChainAt(factsRoot, pointer.decisionId, pointer.decisionMemoryKey);
    if (committed) return { pointer, selectedSnapshotRef: clone(pointer.selectedSnapshotRef), pending: false };
    if (pointer.previousDecisionId) {
      const previous = await this.readDecisionAt(factsRoot, pointer.previousDecisionId);
      if (!await this.decisionInCurrentMemoryChainAt(factsRoot, previous.updateDecisionId, this.memoryKey(previous))) {
        throw new UpdateDecisionRepositoryError("corrupt_data", "fact update plan pointer has no committed recovery predecessor");
      }
    } else if (pointer.revision !== 0) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "fact update plan pointer recovery revision invalid");
    }
    return { pointer, selectedSnapshotRef: clone(pointer.previousSnapshotRef), pending: true };
  }

  private async preparePlanPointersAt(
    factsRoot: string,
    decision: UpdateDecision,
  ): Promise<FactUpdatePlanPointer[]> {
    if (decision.decision !== "accept" && decision.decision !== "undo") return [];
    const beforeRef = decision.decision === "undo" ? decision.newSnapshotRef : decision.oldSnapshotRef;
    const selectedSnapshotRef = selectedFactSnapshotRef(decision);
    const pointers: FactUpdatePlanPointer[] = [];
    for (const planId of [...decision.planIds].sort()) {
      const current = await this.resolvedPlanPointerAt(factsRoot, planId);
      if (current?.pending) {
        if (current.pointer.decisionId !== decision.updateDecisionId || !same(current.pointer.previousSnapshotRef, beforeRef)
          || !same(current.pointer.selectedSnapshotRef, selectedSnapshotRef)) {
          throw new UpdateDecisionRepositoryError("conflict", "a different recoverable update transaction owns the plan snapshot pointer");
        }
        pointers.push(current.pointer);
        continue;
      }
      if (current && !same(current.selectedSnapshotRef, beforeRef)) {
        throw new UpdateDecisionRepositoryError("conflict", "plan fact snapshot pointer CAS mismatch");
      }
      const previous = current?.pointer;
      pointers.push({
        schemaVersion: "fact-update-plan-pointer-v1",
        planKey: this.planKey(planId),
        planId,
        revision: previous ? previous.revision + 1 : 0,
        decisionId: decision.updateDecisionId,
        decisionHash: decision.contentHash,
        decisionMemoryKey: this.memoryKey(decision),
        selectedSnapshotRef: clone(selectedSnapshotRef),
        previousSnapshotRef: clone(beforeRef),
        ...(previous ? { previousDecisionId: previous.decisionId, previousDecisionHash: previous.decisionHash } : {}),
        updatedAt: this.now(),
      });
    }
    return pointers;
  }

  private async snapshot(activeRoot: string | undefined, ref: UpdateDecision["oldSnapshotRef"]): Promise<FactSnapshot> {
    if (activeRoot && !this.snapshots.getSnapshotAtRoot) {
      throw new UpdateDecisionRepositoryError("invalid_input", "coordinated fact snapshot lookup is unavailable");
    }
    const snapshot = activeRoot
      ? await this.snapshots.getSnapshotAtRoot!(activeRoot, ref.snapshotId)
      : await this.snapshots.getSnapshot(ref.snapshotId);
    if (!snapshot || snapshot.contentHash !== ref.contentHash || !await verifyFactSnapshot(snapshot)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision fact snapshot closure invalid");
    }
    return snapshot;
  }

  private async fact(activeRoot: string | undefined, factId: string): Promise<FactRecord> {
    if (activeRoot && !this.snapshots.getFactAtRoot) {
      throw new UpdateDecisionRepositoryError("invalid_input", "coordinated fact record lookup is unavailable");
    }
    const fact = activeRoot ? await this.snapshots.getFactAtRoot!(activeRoot, factId) : await this.snapshots.getFact(factId);
    if (!fact || fact.factId !== factId || !await verifyFactRecord(fact)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision fact authority invalid");
    }
    return fact;
  }

  private async validateDecisionFactClosure(
    activeRoot: string | undefined,
    decision: UpdateDecision,
    oldSnapshot: FactSnapshot,
    newSnapshot: FactSnapshot,
  ): Promise<void> {
    const requiredDomains = [...requiredEvaluationDomainsForFactField(decision.claimKey)].sort();
    if (!unique(decision.oldFactIds) || !unique(decision.newFactIds) || !unique(decision.affectedDomains)
      || !same(decision.affectedDomains, requiredDomains)
      || decision.fieldDiffs.length !== 1 || decision.fieldDiffs[0]!.field !== decision.claimKey
      || !unique(decision.fieldDiffs[0]!.beforeFactIds) || !unique(decision.fieldDiffs[0]!.afterFactIds)
      || !sameStringSet(decision.oldFactIds, decision.fieldDiffs[0]!.beforeFactIds)
      || !sameStringSet(decision.newFactIds, decision.fieldDiffs[0]!.afterFactIds)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision field diff authority is not exact");
    }
    const oldRefs = new Map(oldSnapshot.factRefs.map((ref) => [ref.factId, ref.contentHash]));
    const newRefs = new Map(newSnapshot.factRefs.map((ref) => [ref.factId, ref.contentHash]));
    if (decision.oldFactIds.some((id) => !oldRefs.has(id)) || decision.newFactIds.some((id) => !newRefs.has(id))) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision fact diff is outside its snapshots");
    }
    const oldDelta = oldSnapshot.factRefs.filter((ref) => newRefs.get(ref.factId) !== ref.contentHash).map((ref) => ref.factId);
    const newDelta = newSnapshot.factRefs.filter((ref) => oldRefs.get(ref.factId) !== ref.contentHash).map((ref) => ref.factId);
    const oldConflicts = [...oldSnapshot.conflictRefs].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
    const newConflicts = [...newSnapshot.conflictRefs].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
    if (!sameStringSet(oldDelta, decision.oldFactIds) || !sameStringSet(newDelta, decision.newFactIds)
      || !same(oldConflicts, newConflicts)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision snapshots contain undeclared fact or conflict changes");
    }
    const oldFacts = await Promise.all(decision.oldFactIds.map((id) => this.fact(activeRoot, id)));
    const newFacts = await Promise.all(decision.newFactIds.map((id) => this.fact(activeRoot, id)));
    if (oldFacts.some((fact) => fact.contentHash !== oldRefs.get(fact.factId))
      || newFacts.some((fact) => fact.contentHash !== newRefs.get(fact.factId))) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision fact/snapshot hash closure invalid");
    }
    const facts = [...oldFacts, ...newFacts];
    const first = facts[0];
    if (!first || first.subject.kind !== "product" || facts.some((fact) => fact.subject.kind !== "product"
      || factSubjectKey(fact.subject) !== factSubjectKey(first.subject) || fact.field !== decision.claimKey)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision facts do not share one product subject and field");
    }
    if (decision.subjectKey !== factSubjectKey(first.subject) || decision.revision !== decisionRevision(first.subject)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision memory identity is not derived from its facts");
    }
  }

  private async validateNoticeClosureAt(
    factsRoot: string,
    activeRoot: string | undefined,
    notice: FactUpdateNotice,
  ): Promise<void> {
    const oldSnapshot = await this.snapshot(activeRoot, notice.oldSnapshotRef);
    const newSnapshot = await this.snapshot(activeRoot, notice.newSnapshotRef);
    const oldRefs = new Map(oldSnapshot.factRefs.map((ref) => [ref.factId, ref.contentHash]));
    const newRefs = new Map(newSnapshot.factRefs.map((ref) => [ref.factId, ref.contentHash]));
    const oldDelta = oldSnapshot.factRefs.filter((ref) => newRefs.get(ref.factId) !== ref.contentHash)
      .sort((left, right) => left.factId.localeCompare(right.factId));
    const newDelta = newSnapshot.factRefs.filter((ref) => oldRefs.get(ref.factId) !== ref.contentHash)
      .sort((left, right) => left.factId.localeCompare(right.factId));
    if (!same(oldDelta, notice.oldFactRefs) || !same(newDelta, notice.newFactRefs)
      || !same(
        [...oldSnapshot.conflictRefs].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId)),
        [...newSnapshot.conflictRefs].sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId)),
      )) {
      throw new UpdateDecisionRepositoryError("invalid_input", "fact update notice snapshot delta authority is not exact");
    }
    const facts = await Promise.all([...notice.oldFactRefs, ...notice.newFactRefs].map(async (ref) => {
      const value = await this.fact(activeRoot, ref.factId);
      if (value.contentHash !== ref.contentHash) {
        throw new UpdateDecisionRepositoryError("invalid_input", "fact update notice fact hash closure invalid");
      }
      return value;
    }));
    const first = facts[0];
    if (!first || first.subject.kind !== "product" || facts.some((fact) => fact.subject.kind !== "product"
      || factSubjectKey(fact.subject) !== factSubjectKey(first.subject) || fact.field !== notice.claimKey)
      || notice.subjectKey !== factSubjectKey(first.subject) || notice.revision !== decisionRevision(first.subject)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "fact update notice product subject/field authority invalid");
    }
    const memoryKey = this.memoryKey({
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      planIds: [notice.planId],
    });
    const memory = await this.readMemoryAt(factsRoot, memoryKey);
    if ((memory?.revision ?? -1) !== notice.expectedMemoryRevision
      || notice.memoryRevision !== (memory?.revision ?? -1) + 1
      || (memory
        ? !notice.previousDecisionRef || memory.decisionId !== notice.previousDecisionRef.updateDecisionId
          || memory.decisionHash !== notice.previousDecisionRef.contentHash
        : notice.previousDecisionRef !== undefined)) {
      throw new UpdateDecisionRepositoryError("conflict", "fact update notice memory authority changed");
    }
    const pointer = await this.resolvedPlanPointerAt(factsRoot, notice.planId);
    if (pointer && !same(pointer.selectedSnapshotRef, notice.oldSnapshotRef)) {
      throw new UpdateDecisionRepositoryError("conflict", "fact update notice selected plan snapshot changed");
    }
  }

  private async authorityFiles(directory: string, label: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json"))) {
      throw new UpdateDecisionRepositoryError("corrupt_data", `${label} contains unknown authority`);
    }
    return entries.map((entry) => entry.name.slice(0, -5)).sort();
  }

  private async assertNoCompetingPreparation(
    factsRoot: string,
    transaction: PreparedUpdateDecision,
    currentRevision: number,
  ): Promise<void> {
    const decisionIds = await this.authorityFiles(confined(factsRoot, "update-decisions", "transactions"), "update decision transactions");
    for (const decisionId of decisionIds) {
      if (decisionId === transaction.decision.updateDecisionId) continue;
      if (!DECISION_ID.test(decisionId)) throw new UpdateDecisionRepositoryError("corrupt_data", "update transaction path identity invalid");
      const other = await this.readTransactionAt(factsRoot, decisionId);
      if (other.memoryKey === transaction.memoryKey && other.decision.memoryRevision > currentRevision) {
        throw new UpdateDecisionRepositoryError("conflict", "a different recoverable update transaction already owns this memory revision");
      }
    }
  }

  private async putNoticeAt(
    factsRoot: string,
    activeRoot: string | undefined,
    notice: FactUpdateNotice,
  ): Promise<FactUpdateNotice> {
    if (!verifyFactUpdateNotice(notice)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "fact update notice content authority invalid");
    }
    await this.validateNoticeClosureAt(factsRoot, activeRoot, notice);
    const file = this.noticeFile(factsRoot, notice.updateNoticeId);
    const existing = await this.readEnvelope<FactUpdateNotice>(file, {
      schemaVersion: "fact-update-notice-envelope-v1", kind: "notice",
    }, true);
    if (existing) {
      const valid = await this.readNoticeAt(factsRoot, notice.updateNoticeId);
      if (!same(valid, notice)) throw new UpdateDecisionRepositoryError("conflict", "immutable fact update notice ID collision");
      return clone(valid);
    }
    const envelope: UpdateNoticeEnvelope = {
      schemaVersion: "fact-update-notice-envelope-v1",
      kind: "notice",
      checksum: sha256Json(notice),
      payload: clone(notice),
    };
    await atomicWriteJson(file, envelope);
    return clone(notice);
  }

  async putNotice(notice: FactUpdateNotice, maintenanceLeaseToken?: string): Promise<FactUpdateNotice> {
    const value = clone(notice);
    return this.boundary(true, (factsRoot, activeRoot) => this.putNoticeAt(factsRoot, activeRoot, value), maintenanceLeaseToken);
  }

  /** Root-bound notice publication for an outer coordinator writer. */
  async putNoticeAtRoot(activeRoot: string, notice: FactUpdateNotice): Promise<FactUpdateNotice> {
    return this.putNoticeAt(confined(activeRoot, "facts"), activeRoot, clone(notice));
  }

  async getNotice(noticeId: string): Promise<FactUpdateNotice> {
    return this.boundary(false, (factsRoot) => this.readNoticeAt(factsRoot, noticeId));
  }

  async getNoticeAtRoot(activeRoot: string, noticeId: string): Promise<FactUpdateNotice | null> {
    try { return clone(await this.readNoticeAt(confined(activeRoot, "facts"), noticeId)); }
    catch (error) {
      if (error instanceof UpdateDecisionRepositoryError && error.code === "not_found") return null;
      throw error;
    }
  }

  private async listNoticesAt(factsRoot: string, planId: string): Promise<FactUpdateNotice[]> {
    if (!PLAN_ID.test(planId)) throw new UpdateDecisionRepositoryError("invalid_input", "fact update notice planId invalid");
    const noticeIds = await this.authorityFiles(confined(factsRoot, "update-decisions", "notices"), "fact update notices");
    if (noticeIds.some((noticeId) => !NOTICE_ID.test(noticeId))) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "fact update notice path identity invalid");
    }
    return (await Promise.all(noticeIds.map((noticeId) => this.readNoticeAt(factsRoot, noticeId))))
      .filter((notice) => notice.planId === planId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.updateNoticeId.localeCompare(right.updateNoticeId));
  }

  async listNoticesForPlan(planId: string): Promise<FactUpdateNotice[]> {
    return this.boundary(false, async (factsRoot) => clone(await this.listNoticesAt(factsRoot, planId)));
  }

  async listNoticesForPlanAtRoot(activeRoot: string, planId: string): Promise<FactUpdateNotice[]> {
    return clone(await this.listNoticesAt(confined(activeRoot, "facts"), planId));
  }

  private async prepareConflictTransitions(
    activeRoot: string | undefined,
    decision: UpdateDecision,
  ): Promise<FactUpdateConflictTransition[]> {
    const derived = activeRoot && this.snapshots.prepareUpdateConflictTransitionsAtRoot
      ? await this.snapshots.prepareUpdateConflictTransitionsAtRoot(activeRoot, decision)
      : this.snapshots.prepareUpdateConflictTransitions
        ? await this.snapshots.prepareUpdateConflictTransitions(decision)
        : [];
    return this.validateConflictTransitionSet(decision, derived);
  }

  private async publishConflictTransitions(
    activeRoot: string | undefined,
    decision: UpdateDecision,
    transitions: readonly FactUpdateConflictTransition[],
  ): Promise<void> {
    if (!transitions.length) return;
    if (activeRoot && this.snapshots.publishUpdateConflictTransitionsAtRoot) {
      await this.snapshots.publishUpdateConflictTransitionsAtRoot(activeRoot, decision, transitions);
      return;
    }
    if (this.snapshots.publishUpdateConflictTransitions) {
      await this.snapshots.publishUpdateConflictTransitions(decision, transitions);
      return;
    }
    throw new UpdateDecisionRepositoryError("invalid_input", "fact conflict lifecycle publisher is unavailable");
  }

  async putDecision(input: PutUpdateDecisionInput): Promise<FactUpdateDecisionCommit> {
    return this.putDecisionInternal(input);
  }

  private async putDecisionInternal(
    input: PutUpdateDecisionInput,
    rootBoundActiveRoot?: string,
    rootBoundRuntimeGeneration?: number,
  ): Promise<FactUpdateDecisionCommit> {
    const decision = clone(input.decision);
    if (!await verifyUpdateDecision(decision)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision content authority invalid");
    }
    if (![decision.subjectKey, decision.claimKey, decision.revision, ...decision.planIds, ...decision.oldFactIds, ...decision.newFactIds]
      .every((value) => canonicalString(value)) || !isoTimestamp(decision.decidedAt)) {
      throw new UpdateDecisionRepositoryError("invalid_input", "update decision string/time authority invalid");
    }
    if (!Number.isInteger(input.expectedMemoryRevision) || input.expectedMemoryRevision < -1) {
      throw new UpdateDecisionRepositoryError("invalid_input", "expected memory revision invalid");
    }
    const evaluationDiffs = await this.validateDiffSet(decision, input.evaluationDiffs);
    return this.boundary(true, async (factsRoot, activeRoot, runtimeState) => {
      const oldSnapshot = await this.snapshot(activeRoot, decision.oldSnapshotRef);
      const newSnapshot = await this.snapshot(activeRoot, decision.newSnapshotRef);
      await this.validateDecisionFactClosure(activeRoot, decision, oldSnapshot, newSnapshot);
      const memoryKey = this.memoryKey(decision);
      const current = await this.readMemoryAt(factsRoot, memoryKey);
      const currentRevision = current?.revision ?? -1;

      if (current?.decisionId === decision.updateDecisionId) {
        const committed = await this.readPublishedResultAt(factsRoot, decision.updateDecisionId);
        if (!same(committed.decision, decision) || !same(committed.evaluationDiffs, evaluationDiffs)) {
          throw new UpdateDecisionRepositoryError("conflict", "idempotent update retry payload does not match the original transaction");
        }
        return committed;
      }
      if (input.expectedMemoryRevision !== currentRevision) {
        throw new UpdateDecisionRepositoryError("conflict", "update decision memory CAS revision mismatch");
      }
      if (current) {
        if (decision.memoryRevision !== current.revision + 1 || decision.supersedesDecisionId !== current.decisionId
          || decision.supersedesDecisionHash !== current.decisionHash) {
          throw new UpdateDecisionRepositoryError("conflict", "update decision supersession CAS closure mismatch");
        }
        const previous = await this.readDecisionAt(factsRoot, current.decisionId);
        if (decision.decision === "undo" && previous.decision !== "accept") {
          throw new UpdateDecisionRepositoryError("conflict", "undo may only reverse an accepted update");
        }
      } else if (decision.memoryRevision !== 0 || decision.supersedesDecisionId !== undefined) {
        throw new UpdateDecisionRepositoryError("conflict", "initial update decision memory revision invalid");
      }

      const transactionFile = this.transactionFile(factsRoot, decision.updateDecisionId);
      const existingTransactionEnvelope = await this.readEnvelope<PreparedUpdateDecision>(transactionFile, {
        schemaVersion: "fact-update-decision-transaction-envelope-v1", kind: "transaction",
      }, true);
      let transaction: PreparedUpdateDecision;
      if (existingTransactionEnvelope) {
        transaction = await this.readTransactionAt(factsRoot, decision.updateDecisionId);
        if (!same(transaction.decision, decision) || !same(transaction.evaluationDiffs, evaluationDiffs)) {
          throw new UpdateDecisionRepositoryError("conflict", "immutable update transaction does not match its recoverable preparation");
        }
      } else {
        const conflictTransitions = await this.prepareConflictTransitions(activeRoot, decision);
        transaction = this.createTransaction(decision, evaluationDiffs, conflictTransitions);
      }
      await this.assertNoCompetingPreparation(factsRoot, transaction, currentRevision);
      const planPointers = await this.preparePlanPointersAt(factsRoot, decision);
      if (input.precommitAuthorizer) {
        const authorityRoot = activeRoot ?? rootBoundActiveRoot;
        const authorityGeneration = runtimeState?.runtimeGeneration ?? rootBoundRuntimeGeneration;
        if (!authorityRoot || !Number.isInteger(authorityGeneration) || authorityGeneration! < 1) {
          throw new UpdateDecisionRepositoryError("invalid_input", "root-bound update decision precommit authority is unavailable");
        }
        await input.precommitAuthorizer(Object.freeze({
          activeRoot: authorityRoot,
          runtimeGeneration: authorityGeneration!,
          decision: clone(decision),
          expectedMemoryRevision: input.expectedMemoryRevision,
          preparedTransaction: clone(transaction),
        }));
      }
      if (!existingTransactionEnvelope) {
        const envelope: TransactionEnvelope = {
          schemaVersion: "fact-update-decision-transaction-envelope-v1", kind: "transaction",
          checksum: sha256Json(transaction), payload: transaction,
        };
        await atomicWriteJson(transactionFile, envelope);
      }
      await this.inject("after_prepare", { decisionId: decision.updateDecisionId, memoryKey });

      const decisionFile = this.decisionFile(factsRoot, decision.updateDecisionId);
      const existingDecision = await this.readEnvelope<UpdateDecision>(decisionFile, {
        schemaVersion: "fact-update-decision-envelope-v1", kind: "decision",
      }, true);
      if (existingDecision) {
        const valid = await this.readDecisionAt(factsRoot, decision.updateDecisionId);
        if (!same(valid, decision)) throw new UpdateDecisionRepositoryError("conflict", "immutable update decision ID collision");
      } else {
        const envelope: DecisionEnvelope = {
          schemaVersion: "fact-update-decision-envelope-v1", kind: "decision",
          checksum: sha256Json(decision), payload: decision,
        };
        await atomicWriteJson(decisionFile, envelope);
      }
      await this.inject("after_decision", { decisionId: decision.updateDecisionId, memoryKey });

      for (const diff of evaluationDiffs) {
        const file = this.diffFile(factsRoot, diff.evaluationDiffId);
        const existingDiff = await this.readEnvelope<FactUpdateEvaluationDiff>(file, {
          schemaVersion: "fact-update-evaluation-diff-envelope-v1", kind: "evaluation-diff",
        }, true);
        if (existingDiff) {
          const valid = await this.readDiffAt(factsRoot, diff.evaluationDiffId);
          if (!same(valid, diff)) throw new UpdateDecisionRepositoryError("conflict", "immutable update evaluation diff ID collision");
        } else {
          const envelope: EvaluationDiffEnvelope = {
            schemaVersion: "fact-update-evaluation-diff-envelope-v1", kind: "evaluation-diff",
            checksum: sha256Json(diff), payload: diff,
          };
          await atomicWriteJson(file, envelope);
        }
        await this.inject("after_evaluation_diff", {
          decisionId: decision.updateDecisionId, memoryKey, evaluationDiffId: diff.evaluationDiffId,
        });
      }

      for (const pointer of planPointers) {
        const currentPointer = await this.readPlanPointerAt(factsRoot, pointer.planId, true);
        if (!currentPointer || !same(currentPointer, pointer)) {
          const envelope: PlanPointerEnvelope = {
            schemaVersion: "fact-update-plan-pointer-envelope-v1",
            kind: "plan-pointer",
            checksum: sha256Json(pointer),
            payload: pointer,
          };
          await atomicWriteJson(this.planPointerFile(factsRoot, pointer.planId), envelope);
        }
        await this.inject("after_plan_pointer", { decisionId: decision.updateDecisionId, memoryKey });
      }

      await this.publishConflictTransitions(activeRoot, decision, transaction.conflictTransitions);
      if (transaction.conflictTransitions.length) {
        await this.inject("after_conflict_pointer", { decisionId: decision.updateDecisionId, memoryKey });
      }

      const selectedSnapshotRef = selectedFactSnapshotRef(decision);
      const memory: DecisionMemory = {
        schemaVersion: "fact-update-memory-v1",
        memoryKey,
        revision: decision.memoryRevision,
        decisionId: decision.updateDecisionId,
        decisionHash: decision.contentHash,
        selectedSnapshotRef,
        updatedAt: this.now(),
      };
      await this.inject("before_memory", { decisionId: decision.updateDecisionId, memoryKey });
      const memoryEnvelope: MemoryEnvelope = {
        schemaVersion: "fact-update-decision-envelope-v1", kind: "memory",
        checksum: sha256Json(memory), payload: memory,
      };
      await atomicWriteJson(this.memoryFile(factsRoot, memoryKey), memoryEnvelope);
      await this.inject("after_memory", { decisionId: decision.updateDecisionId, memoryKey });
      return {
        decision,
        selectedSnapshotRef,
        evaluationDiffs: clone(evaluationDiffs),
        ...(evaluationDiffs.length === 1 ? { evaluationDiff: clone(evaluationDiffs[0]!) } : {}),
      };
    }, input.maintenanceLeaseToken);
  }

  /**
   * Root-pinned writer for a composition already holding the runtime barrier.
   * The direct child repository uses only root-bound snapshot/fact lookups and
   * therefore never resolves a second active generation.
   */
  async putDecisionAtRoot(
    activeRoot: string,
    input: Omit<PutUpdateDecisionInput, "maintenanceLeaseToken">,
  ): Promise<FactUpdateDecisionCommit> {
    if (!this.snapshots.getSnapshotAtRoot || !this.snapshots.getFactAtRoot) {
      throw new UpdateDecisionRepositoryError("invalid_input", "root-bound fact update lookup is unavailable");
    }
    const rootLookup: FactSnapshotLookup = {
      getSnapshot: async (snapshotId) => {
        const snapshot = await this.snapshots.getSnapshotAtRoot!(activeRoot, snapshotId);
        if (!snapshot) throw new UpdateDecisionRepositoryError("not_found", "root-bound fact snapshot was not found");
        return snapshot;
      },
      getFact: async (factId) => {
        const fact = await this.snapshots.getFactAtRoot!(activeRoot, factId);
        if (!fact) throw new UpdateDecisionRepositoryError("not_found", "root-bound fact was not found");
        return fact;
      },
      ...(this.snapshots.prepareUpdateConflictTransitionsAtRoot ? {
        prepareUpdateConflictTransitions: (decision: UpdateDecision) => (
          this.snapshots.prepareUpdateConflictTransitionsAtRoot!(activeRoot, decision)
        ),
      } : {}),
      ...(this.snapshots.publishUpdateConflictTransitionsAtRoot ? {
        publishUpdateConflictTransitions: (
          decision: UpdateDecision,
          transitions: readonly FactUpdateConflictTransition[],
        ) => this.snapshots.publishUpdateConflictTransitionsAtRoot!(activeRoot, decision, transitions),
      } : {}),
    };
    const direct = new UpdateDecisionRepository({
      root: confined(activeRoot, "facts"),
      snapshots: rootLookup,
      now: this.now,
      ...(this.failureInjector ? { failureInjector: this.failureInjector } : {}),
    });
    const { precommitAuthorizer, ...serializableInput } = input;
    const generationDirectory = path.basename(path.resolve(activeRoot));
    const generationParent = path.basename(path.dirname(path.resolve(activeRoot)));
    const runtimeGeneration = generationParent === "generations" && /^[1-9]\d*$/.test(generationDirectory)
      ? Number(generationDirectory) : undefined;
    return direct.putDecisionInternal({
      ...clone(serializableInput),
      ...(precommitAuthorizer ? { precommitAuthorizer } : {}),
    }, activeRoot, runtimeGeneration);
  }

  async getDecision(decisionId: string): Promise<UpdateDecision> {
    return this.boundary(false, (factsRoot) => this.readDecisionAt(factsRoot, decisionId));
  }

  /** Root-pinned lookup for evaluators already holding the shared coordinator barrier. */
  async getDecisionAtRoot(activeRoot: string, decisionId: string): Promise<UpdateDecision | null> {
    try { return clone(await this.readDecisionAt(confined(activeRoot, "facts"), decisionId)); }
    catch (error) {
      if (error instanceof UpdateDecisionRepositoryError && error.code === "not_found") return null;
      throw error;
    }
  }

  private async activeDecisionAt(factsRoot: string, decisionId: string): Promise<UpdateDecision | null> {
    let decision: UpdateDecision;
    try { decision = await this.readDecisionAt(factsRoot, decisionId); }
    catch (error) {
      if (error instanceof UpdateDecisionRepositoryError && error.code === "not_found") return null;
      throw error;
    }
    const memory = await this.readMemoryAt(factsRoot, this.memoryKey(decision));
    return memory?.decisionId === decisionId ? clone(decision) : null;
  }

  /** AcceptedUpdateDecisionClosureLookup implementation for FactRepository. */
  async getActiveDecision(decisionId: string): Promise<UpdateDecision | null> {
    return this.boundary(false, (factsRoot) => this.activeDecisionAt(factsRoot, decisionId));
  }

  /** Root-bound AcceptedUpdateDecisionClosureLookup implementation. */
  async getActiveDecisionAtRoot(activeRoot: string, decisionId: string): Promise<UpdateDecision | null> {
    return this.activeDecisionAt(confined(activeRoot, "facts"), decisionId);
  }

  async getSelectedSnapshotForPlan(planId: string): Promise<UpdateDecision["oldSnapshotRef"] | null> {
    return this.boundary(false, async (factsRoot, activeRoot) => {
      const resolved = await this.resolvedPlanPointerAt(factsRoot, planId);
      if (!resolved) return null;
      await this.snapshot(activeRoot, resolved.selectedSnapshotRef);
      return clone(resolved.selectedSnapshotRef);
    });
  }

  /**
   * Root-pinned plan snapshot selector for the evaluation pipeline. A pointer
   * written by a crashed, uncommitted transaction resolves to its durable
   * previousSnapshotRef; it becomes selected only when decision memory commits.
   */
  async getSelectedSnapshotForPlanAtRoot(activeRoot: string, planId: string): Promise<UpdateDecision["oldSnapshotRef"] | null> {
    const factsRoot = confined(activeRoot, "facts");
    const resolved = await this.resolvedPlanPointerAt(factsRoot, planId);
    if (!resolved) return null;
    await this.snapshot(activeRoot, resolved.selectedSnapshotRef);
    return clone(resolved.selectedSnapshotRef);
  }

  async getEvaluationDiff(evaluationDiffId: string): Promise<FactUpdateEvaluationDiff> {
    return this.boundary(false, (factsRoot) => this.readDiffAt(factsRoot, evaluationDiffId));
  }

  async listEvaluationDiffs(decisionId: string): Promise<FactUpdateEvaluationDiff[]> {
    return this.boundary(false, async (factsRoot) => clone((await this.readPublishedResultAt(factsRoot, decisionId)).evaluationDiffs));
  }

  /** Returns the durable recovery journal even when the final memory pointer was never installed. */
  async getPreparedDecision(decisionId: string): Promise<PreparedUpdateDecision | null> {
    return this.boundary(false, async (factsRoot) => {
      const envelope = await this.readEnvelope<PreparedUpdateDecision>(this.transactionFile(factsRoot, decisionId), {
        schemaVersion: "fact-update-decision-transaction-envelope-v1", kind: "transaction",
      }, true);
      return envelope ? clone(await this.readTransactionAt(factsRoot, decisionId)) : null;
    });
  }

  async getPreparedDecisionAtRoot(activeRoot: string, decisionId: string): Promise<PreparedUpdateDecision | null> {
    const factsRoot = confined(activeRoot, "facts");
    const envelope = await this.readEnvelope<PreparedUpdateDecision>(this.transactionFile(factsRoot, decisionId), {
      schemaVersion: "fact-update-decision-transaction-envelope-v1", kind: "transaction",
    }, true);
    return envelope ? clone(await this.readTransactionAt(factsRoot, decisionId)) : null;
  }

  /** Returns an original persisted result only when this exact decision is the active memory pointer. */
  async getActiveDecisionResult(decision: UpdateDecision): Promise<FactUpdateDecisionCommit | null> {
    if (!await verifyUpdateDecision(decision)) throw new UpdateDecisionRepositoryError("invalid_input", "update decision content authority invalid");
    return this.boundary(false, async (factsRoot) => {
      const memory = await this.readMemoryAt(factsRoot, this.memoryKey(decision));
      if (!memory || memory.decisionId !== decision.updateDecisionId) return null;
      const committed = await this.readPublishedResultAt(factsRoot, decision.updateDecisionId);
      if (!same(committed.decision, decision)) throw new UpdateDecisionRepositoryError("conflict", "active decision identity collision");
      return committed;
    });
  }

  async getActiveDecisionResultAtRoot(activeRoot: string, decision: UpdateDecision): Promise<FactUpdateDecisionCommit | null> {
    if (!await verifyUpdateDecision(decision)) throw new UpdateDecisionRepositoryError("invalid_input", "update decision content authority invalid");
    const factsRoot = confined(activeRoot, "facts");
    const memory = await this.readMemoryAt(factsRoot, this.memoryKey(decision));
    if (!memory || memory.decisionId !== decision.updateDecisionId) return null;
    const committed = await this.readPublishedResultAt(factsRoot, decision.updateDecisionId);
    if (!same(committed.decision, decision)) throw new UpdateDecisionRepositoryError("conflict", "active decision identity collision");
    return committed;
  }

  async getMemory(key: Pick<UpdateDecision, "subjectKey" | "claimKey" | "revision" | "planIds">): Promise<{
    revision: number;
    decision: UpdateDecision;
    selectedSnapshotRef: UpdateDecision["oldSnapshotRef"];
    evaluationDiffs: FactUpdateEvaluationDiff[];
  } | null> {
    return this.boundary(false, async (factsRoot) => {
      const memory = await this.readMemoryAt(factsRoot, this.memoryKey(key));
      if (!memory) return null;
      const committed = await this.readPublishedResultAt(factsRoot, memory.decisionId);
      return {
        revision: memory.revision,
        decision: committed.decision,
        selectedSnapshotRef: clone(memory.selectedSnapshotRef),
        evaluationDiffs: committed.evaluationDiffs,
      };
    });
  }

  async getMemoryAtRoot(
    activeRoot: string,
    key: Pick<UpdateDecision, "subjectKey" | "claimKey" | "revision" | "planIds">,
  ): Promise<{
    revision: number;
    decision: UpdateDecision;
    selectedSnapshotRef: UpdateDecision["oldSnapshotRef"];
    evaluationDiffs: FactUpdateEvaluationDiff[];
  } | null> {
    const factsRoot = confined(activeRoot, "facts");
    const memory = await this.readMemoryAt(factsRoot, this.memoryKey(key));
    if (!memory) return null;
    const committed = await this.readPublishedResultAt(factsRoot, memory.decisionId);
    return {
      revision: memory.revision,
      decision: committed.decision,
      selectedSnapshotRef: clone(memory.selectedSnapshotRef),
      evaluationDiffs: clone(committed.evaluationDiffs),
    };
  }

  /** Read-only reference provider for backup/Doctor composition. */
  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "fact-update-decisions";
    revision: number;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const factsRoot = confined(activeRoot, "facts");
    const decisionIds = await this.authorityFiles(confined(factsRoot, "update-decisions", "records"), "update decisions");
    const memoryKeys = await this.authorityFiles(confined(factsRoot, "update-decisions", "memory"), "update decision memory");
    const diffIds = await this.authorityFiles(confined(factsRoot, "update-decisions", "evaluation-diffs"), "update evaluation diffs");
    const noticeIds = await this.authorityFiles(confined(factsRoot, "update-decisions", "notices"), "fact update notices");
    const transactionDecisionIds = await this.authorityFiles(confined(factsRoot, "update-decisions", "transactions"), "update decision transactions");
    const planKeys = await this.authorityFiles(confined(factsRoot, "update-decisions", "plan-pointers"), "update plan pointers");
    if (decisionIds.some((id) => !DECISION_ID.test(id)) || transactionDecisionIds.some((id) => !DECISION_ID.test(id))
      || diffIds.some((id) => !DIFF_ID.test(id)) || memoryKeys.some((key) => !/^[a-f0-9]{64}$/.test(key))
      || noticeIds.some((id) => !NOTICE_ID.test(id)) || planKeys.some((key) => !/^[a-f0-9]{64}$/.test(key))) {
      throw new UpdateDecisionRepositoryError("corrupt_data", "update decision authority path identity invalid");
    }
    const decisions = await Promise.all(decisionIds.map((id) => this.readDecisionAt(factsRoot, id)));
    const diffs = await Promise.all(diffIds.map((id) => this.readDiffAt(factsRoot, id)));
    const notices = await Promise.all(noticeIds.map((id) => this.readNoticeAt(factsRoot, id)));
    const transactions = await Promise.all(transactionDecisionIds.map((id) => this.readTransactionAt(factsRoot, id)));
    const planPointers = await Promise.all(planKeys.map(async (planKey) => {
      const pointer = await this.readEnvelope<FactUpdatePlanPointer>(confined(factsRoot, "update-decisions", "plan-pointers", `${planKey}.json`), {
        schemaVersion: "fact-update-plan-pointer-envelope-v1", kind: "plan-pointer",
      });
      if (!pointer || pointer.planKey !== planKey) throw new UpdateDecisionRepositoryError("corrupt_data", "update plan pointer path identity invalid");
      const valid = await this.readPlanPointerAt(factsRoot, pointer.planId);
      if (!valid) throw new UpdateDecisionRepositoryError("corrupt_data", "update plan pointer is missing");
      const resolved = await this.resolvedPlanPointerAt(factsRoot, pointer.planId);
      if (!resolved) throw new UpdateDecisionRepositoryError("corrupt_data", "update plan pointer resolution failed");
      return { pointer: valid, effectiveSnapshotRef: resolved.selectedSnapshotRef };
    }));
    const memories = await Promise.all(memoryKeys.map(async (key) => {
      const memory = await this.readMemoryAt(factsRoot, key);
      if (!memory || memory.memoryKey !== key) throw new UpdateDecisionRepositoryError("corrupt_data", "update decision memory path identity invalid");
      return memory;
    }));
    const required = "required_for_replay" as const;
    return {
      providerId: "fact-update-decisions",
      revision: transactions.length + decisions.length + diffs.length + notices.length
        + planPointers.reduce((sum, entry) => sum + entry.pointer.revision + 1, 0)
        + memories.reduce((sum, memory) => sum + memory.revision + 1, 0),
      manifestHash: sha256Json({
        transactions: transactions.map((transaction) => ({ id: transaction.transactionId, hash: transaction.contentHash })),
        decisions: decisions.map((decision) => ({ id: decision.updateDecisionId, hash: decision.contentHash })),
        diffs: diffs.map((diff) => ({ id: diff.evaluationDiffId, hash: diff.contentHash })),
        notices: notices.map((notice) => ({ id: notice.updateNoticeId, hash: notice.contentHash, sourceHash: notice.sourceHash })),
        planPointers: planPointers.map(({ pointer }) => ({ planKey: pointer.planKey, revision: pointer.revision, decisionHash: pointer.decisionHash })),
        memories: memories.map((memory) => ({ key: memory.memoryKey, revision: memory.revision, hash: memory.decisionHash })),
      }),
      snapshotPointers: [...new Set([
        ...planPointers.map(({ effectiveSnapshotRef }) => `fact-snapshot:${effectiveSnapshotRef.snapshotId}`),
        ...memories.map((memory) => `fact-snapshot:${memory.selectedSnapshotRef.snapshotId}`),
        ...notices.flatMap((notice) => [
          `fact-snapshot:${notice.oldSnapshotRef.snapshotId}`,
          `fact-snapshot:${notice.newSnapshotRef.snapshotId}`,
        ]),
      ])].sort(),
      nodes: [
        ...transactions.map((transaction) => `fact-update-transaction:${transaction.transactionId}`),
        ...decisions.map((decision) => `fact-update-decision:${decision.updateDecisionId}`),
        ...diffs.map((diff) => `fact-update-evaluation-diff:${diff.evaluationDiffId}`),
        ...notices.map((notice) => `fact-update-notice:${notice.updateNoticeId}`),
        ...planPointers.map(({ pointer }) => `fact-update-plan-pointer:${pointer.planId}`),
        ...memories.map((memory) => `fact-update-memory:${memory.memoryKey}`),
      ].sort(),
      edges: [
        ...transactions.flatMap((transaction) => [
          { fromRef: `fact-update-transaction:${transaction.transactionId}`, toRef: `fact-snapshot:${transaction.decision.oldSnapshotRef.snapshotId}`, necessity: required },
          { fromRef: `fact-update-transaction:${transaction.transactionId}`, toRef: `fact-snapshot:${transaction.decision.newSnapshotRef.snapshotId}`, necessity: required },
          ...transaction.decision.planIds.map((id) => ({ fromRef: `fact-update-transaction:${transaction.transactionId}`, toRef: `plan:${id}`, necessity: required })),
        ]),
        ...decisions.flatMap((decision) => {
          const transaction = transactions.find((candidate) => candidate.decision.updateDecisionId === decision.updateDecisionId);
          if (!transaction) throw new UpdateDecisionRepositoryError("corrupt_data", "published update decision has no recovery transaction");
          return [
            { fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `fact-update-transaction:${transaction.transactionId}`, necessity: required },
            { fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `fact-snapshot:${decision.oldSnapshotRef.snapshotId}`, necessity: required },
            { fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `fact-snapshot:${decision.newSnapshotRef.snapshotId}`, necessity: required },
            ...decision.oldFactIds.map((id) => ({ fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `fact:${id}`, necessity: required })),
            ...decision.newFactIds.map((id) => ({ fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `fact:${id}`, necessity: required })),
            ...decision.planIds.map((id) => ({ fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `plan:${id}`, necessity: required })),
            ...transaction.evaluationDiffs.map((diff) => ({ fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, necessity: required })),
            ...(decision.supersedesDecisionId ? [{ fromRef: `fact-update-decision:${decision.updateDecisionId}`, toRef: `fact-update-decision:${decision.supersedesDecisionId}`, necessity: required }] : []),
          ];
        }),
        ...diffs.flatMap((diff) => [
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `fact-update-decision:${diff.updateDecisionId}`, necessity: required },
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `plan:${diff.planId}`, necessity: required },
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `fact-snapshot:${diff.before.factSnapshotId}`, necessity: required },
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `fact-snapshot:${diff.after.factSnapshotId}`, necessity: required },
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `evaluation-lock:${diff.before.evaluationLock.contentHash}`, necessity: required },
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `evaluation-lock:${diff.after.evaluationLock.contentHash}`, necessity: required },
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `evaluation:${diff.before.evaluationHash}`, necessity: required },
          { fromRef: `fact-update-evaluation-diff:${diff.evaluationDiffId}`, toRef: `evaluation:${diff.after.evaluationHash}`, necessity: required },
        ]),
        ...notices.flatMap((notice) => [
          { fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `plan:${notice.planId}`, necessity: required },
          { fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `fact-snapshot:${notice.oldSnapshotRef.snapshotId}`, necessity: required },
          { fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `fact-snapshot:${notice.newSnapshotRef.snapshotId}`, necessity: required },
          ...notice.oldFactRefs.map((ref) => ({ fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `fact:${ref.factId}`, necessity: required })),
          ...notice.newFactRefs.map((ref) => ({ fromRef: `fact-update-notice:${notice.updateNoticeId}`, toRef: `fact:${ref.factId}`, necessity: required })),
          ...(notice.previousDecisionRef ? [{
            fromRef: `fact-update-notice:${notice.updateNoticeId}`,
            toRef: `fact-update-decision:${notice.previousDecisionRef.updateDecisionId}`,
            necessity: required,
          }] : []),
        ]),
        ...planPointers.flatMap(({ pointer }) => [
          { fromRef: `fact-update-plan-pointer:${pointer.planId}`, toRef: `fact-update-decision:${pointer.decisionId}`, necessity: required },
          { fromRef: `fact-update-plan-pointer:${pointer.planId}`, toRef: `fact-snapshot:${pointer.selectedSnapshotRef.snapshotId}`, necessity: required },
          { fromRef: `fact-update-plan-pointer:${pointer.planId}`, toRef: `fact-snapshot:${pointer.previousSnapshotRef.snapshotId}`, necessity: required },
          ...(pointer.previousDecisionId ? [{ fromRef: `fact-update-plan-pointer:${pointer.planId}`, toRef: `fact-update-decision:${pointer.previousDecisionId}`, necessity: required }] : []),
        ]),
        ...memories.flatMap((memory) => [
          { fromRef: `fact-update-memory:${memory.memoryKey}`, toRef: `fact-update-decision:${memory.decisionId}`, necessity: required },
          { fromRef: `fact-update-memory:${memory.memoryKey}`, toRef: `fact-snapshot:${memory.selectedSnapshotRef.snapshotId}`, necessity: required },
        ]),
      ].sort((left, right) => sha256Json(left).localeCompare(sha256Json(right))),
    };
  }
}

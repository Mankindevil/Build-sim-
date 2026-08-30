import path from "node:path";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { sha256Json } from "../runtime/fs.mjs";
import type { FactRecord, FactSnapshot, UpdateDecision } from "./contracts";
import { type ResolvedFactRepositorySnapshotClosure, type FactRepository } from "./repository";
import { factSubjectKey } from "./resolver";
import {
  type FactUpdateDecisionCommit,
  type UpdateDecisionPrecommitAuthorizer,
  UpdateDecisionRepository,
  UpdateDecisionRepositoryError,
} from "./update-decision-repository";
import {
  requiredEvaluationDomainsForFactField,
  type SnapshotEvaluationReceipt,
} from "./update-evaluation";
import {
  createFactUpdateNotice,
  factUpdateNoticeSourceHash,
  validateFactUpdateNoticePlanTarget,
  type FactUpdateNotice,
  type FactUpdateNoticeInput,
  type FactUpdateNoticePlanTarget,
} from "./update-notices";
import { createUpdateDecision } from "./update-decisions";
import { FactUpdateService } from "./update-service";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const NOTICE_ID = /^fact-update-notice-sha256-[a-f0-9]{64}$/;
const DECISION_ID = /^update-decision-sha256-[a-f0-9]{64}$/;

interface FactUpdateRuntimeAuthority {
  activeRoot: string;
  runtimeGeneration: number;
}

function runtimeAuthorityAtRoot(activeRoot: string): FactUpdateRuntimeAuthority {
  const resolved = path.resolve(activeRoot);
  const generationDirectory = path.basename(resolved);
  if (path.basename(path.dirname(resolved)) !== "generations" || !/^[1-9]\d*$/.test(generationDirectory)) {
    throw new FactUpdateNoticeServiceError("invalid_input", "fact update active runtime generation root is invalid");
  }
  return { activeRoot: resolved, runtimeGeneration: Number(generationDirectory) };
}

export interface FactUpdatePlanNoticeContext {
  target: FactUpdateNoticePlanTarget;
  /** Immutable plan-owned fallback; a committed update plan pointer takes precedence. */
  pinnedSnapshotRef: UpdateDecision["oldSnapshotRef"];
}

export interface FactUpdatePlanNoticeAuthority {
  resolvePlanNoticeContextAtRoot(activeRoot: string, planId: string): Promise<FactUpdatePlanNoticeContext>;
}

export interface FactUpdateRelevantFactsAuthority {
  /** Returns IDs only from currentProductFacts and is injected by the plan/config authority. */
  selectRelevantProductFactIdsAtRoot(
    activeRoot: string,
    planId: string,
    target: Readonly<FactUpdateNoticePlanTarget>,
    currentProductFacts: readonly Readonly<FactRecord>[],
  ): Promise<readonly string[]>;
}

export interface FactUpdateAuthorizedTarget {
  planId: string;
  target: FactUpdateNoticePlanTarget;
  updateNoticeId: string;
  phase: "before" | "after";
}

export interface FactUpdateTargetEvaluator {
  /** ID-only adapter to AuthoritativeEvaluationSnapshotPipeline; no snapshot/receipt bytes enter transport. */
  evaluateFactUpdateTarget(input: Readonly<FactUpdateAuthorizedTarget>): Promise<SnapshotEvaluationReceipt>;
  /** Optional adapter for callers already holding the exact coordinator root. */
  evaluateFactUpdateTargetAtRoot?(
    activeRoot: string,
    input: Readonly<FactUpdateAuthorizedTarget>,
  ): Promise<SnapshotEvaluationReceipt>;
}

export interface FactUpdateNoticeServiceOptions {
  runtimeRoot: string;
  coordinator?: RuntimeCoordinator;
  facts: FactRepository;
  decisions: UpdateDecisionRepository;
  plans: FactUpdatePlanNoticeAuthority;
  relevantFacts: FactUpdateRelevantFactsAuthority;
  evaluator: FactUpdateTargetEvaluator;
  now?: () => string;
}

export interface DecideFactUpdateNoticeInput {
  noticeId: string;
  action: "accept" | "reject" | "defer" | "undo";
  expectedMemoryRevision: number;
  confirmation: true;
  /** Required only for undo; the server verifies it is the active accepted decision for this notice. */
  decisionId?: string;
}

export interface FactUpdateNoticeDecisionResult extends FactUpdateDecisionCommit {
  notice: FactUpdateNotice;
}

export interface ResolveFactUpdateNoticeSnapshotInput {
  planId: string;
  target: FactUpdateNoticePlanTarget;
  updateNoticeId: string;
  phase: "before" | "after";
}

export class FactUpdateNoticeServiceError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid_input" | "corrupt_data", message: string) {
    super(message);
    this.name = "FactUpdateNoticeServiceError";
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
    && keys.length === required.length + optional.filter((key) => keys.includes(key)).length;
}

function snapshotRef(snapshot: FactSnapshot): UpdateDecision["oldSnapshotRef"] {
  return { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash };
}

function decisionRevision(subject: Extract<FactRecord["subject"], { kind: "product" }>): string {
  return subject.revision ?? subject.variantId ?? subject.modelId ?? subject.familyId ?? subject.skuId;
}

function factRefs(facts: readonly FactRecord[]): FactSnapshot["factRefs"] {
  return facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash }))
    .sort((left, right) => left.factId.localeCompare(right.factId));
}

function sameRefSet(left: readonly { factId: string; contentHash: string }[], right: readonly { factId: string; contentHash: string }[]): boolean {
  return same([...left].sort((a, b) => a.factId.localeCompare(b.factId)), [...right].sort((a, b) => a.factId.localeCompare(b.factId)));
}

function validatePlanContext(value: unknown): asserts value is FactUpdatePlanNoticeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["target", "pinnedSnapshotRef"])) {
    throw new FactUpdateNoticeServiceError("invalid_input", "plan update notice context invalid");
  }
  const context = value as unknown as FactUpdatePlanNoticeContext;
  if (validateFactUpdateNoticePlanTarget(context.target).length
    || !context.pinnedSnapshotRef || typeof context.pinnedSnapshotRef !== "object"
    || !/^fact-snapshot-sha256-[a-f0-9]{64}$/.test(context.pinnedSnapshotRef.snapshotId)
    || !/^[a-f0-9]{64}$/.test(context.pinnedSnapshotRef.contentHash)
    || context.pinnedSnapshotRef.snapshotId !== `fact-snapshot-sha256-${context.pinnedSnapshotRef.contentHash}`) {
    throw new FactUpdateNoticeServiceError("invalid_input", "plan update notice context authority invalid");
  }
}

function validateDecisionInput(value: unknown): asserts value is DecideFactUpdateNoticeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FactUpdateNoticeServiceError("invalid_input", "fact update decision input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["noticeId", "action", "expectedMemoryRevision", "confirmation"], ["decisionId"])
    || typeof input.noticeId !== "string" || !NOTICE_ID.test(input.noticeId)
    || !["accept", "reject", "defer", "undo"].includes(String(input.action))
    || !Number.isInteger(input.expectedMemoryRevision) || (input.expectedMemoryRevision as number) < -1
    || input.confirmation !== true) {
    throw new FactUpdateNoticeServiceError("invalid_input", "fact update decision transport fields invalid");
  }
  if (input.action === "undo") {
    if (typeof input.decisionId !== "string" || !DECISION_ID.test(input.decisionId)) {
      throw new FactUpdateNoticeServiceError("invalid_input", "undo requires one governed decisionId");
    }
  } else if (input.decisionId !== undefined) {
    throw new FactUpdateNoticeServiceError("invalid_input", "decisionId is allowed only for undo");
  }
}

function decisionMatchesNotice(decision: UpdateDecision, notice: FactUpdateNotice): boolean {
  return decision.planIds.length === 1 && decision.planIds[0] === notice.planId
    && decision.subjectKey === notice.subjectKey && decision.claimKey === notice.claimKey
    && decision.revision === notice.revision
    && same(decision.oldSnapshotRef, notice.oldSnapshotRef)
    && same(decision.newSnapshotRef, notice.newSnapshotRef)
    && same(decision.oldFactIds, notice.oldFactRefs.map((ref) => ref.factId))
    && same(decision.newFactIds, notice.newFactRefs.map((ref) => ref.factId))
    && same(decision.fieldDiffs, [{
      field: notice.claimKey,
      beforeFactIds: notice.oldFactRefs.map((ref) => ref.factId),
      afterFactIds: notice.newFactRefs.map((ref) => ref.factId),
    }])
    && same(decision.affectedDomains, notice.affectedDomains);
}

export class FactUpdateNoticeService {
  private readonly coordinator: RuntimeCoordinator;
  private readonly now: () => string;

  constructor(private readonly options: FactUpdateNoticeServiceOptions) {
    this.coordinator = options.coordinator ?? new RuntimeCoordinator({ root: path.resolve(options.runtimeRoot), now: options.now });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private assertPlanId(planId: string): void {
    if (!PLAN_ID.test(planId)) throw new FactUpdateNoticeServiceError("invalid_input", "fact update planId invalid");
  }

  private async planContextAtRoot(activeRoot: string, planId: string): Promise<FactUpdatePlanNoticeContext> {
    const context = clone(await this.options.plans.resolvePlanNoticeContextAtRoot(activeRoot, planId));
    validatePlanContext(context);
    return context;
  }

  private async selectedSnapshotAtRoot(
    activeRoot: string,
    planId: string,
    context: FactUpdatePlanNoticeContext,
  ): Promise<UpdateDecision["oldSnapshotRef"]> {
    return clone(await this.options.decisions.getSelectedSnapshotForPlanAtRoot(activeRoot, planId) ?? context.pinnedSnapshotRef);
  }

  private async snapshotClosureAtRoot(
    activeRoot: string,
    ref: UpdateDecision["oldSnapshotRef"],
  ): Promise<ResolvedFactRepositorySnapshotClosure> {
    const closure = await this.options.facts.getSnapshotClosureAtRoot(activeRoot, ref.snapshotId);
    if (!closure || closure.snapshot.contentHash !== ref.contentHash) {
      throw new FactUpdateNoticeServiceError("corrupt_data", "fact update snapshot closure is missing or changed");
    }
    return clone(closure);
  }

  private async relevantCurrentProductFactsAtRoot(
    activeRoot: string,
    planId: string,
    target: FactUpdateNoticePlanTarget,
  ): Promise<FactRecord[]> {
    const current = await this.options.facts.listCurrentFactsAtRoot(activeRoot);
    const productFacts = current.filter((fact) => fact.subject.kind === "product");
    const selectedIds = [...await this.options.relevantFacts.selectRelevantProductFactIdsAtRoot(
      activeRoot,
      planId,
      clone(target),
      productFacts.map((fact) => Object.freeze(clone(fact))),
    )];
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new FactUpdateNoticeServiceError("invalid_input", "plan relevance authority returned duplicate facts");
    }
    const selected = selectedIds.map((factId) => productFacts.find((fact) => fact.factId === factId));
    if (selected.some((fact) => !fact)) {
      throw new FactUpdateNoticeServiceError("invalid_input", "plan relevance authority returned a non-current or non-product fact");
    }
    return selected.map((fact) => clone(fact!)).sort((left, right) => left.factId.localeCompare(right.factId));
  }

  private async noticeMemoryAtRoot(activeRoot: string, notice: Pick<FactUpdateNotice, "subjectKey" | "claimKey" | "revision" | "planId">) {
    return this.options.decisions.getMemoryAtRoot(activeRoot, {
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      planIds: [notice.planId],
    });
  }

  private handledByCurrentMemory(
    memory: Awaited<ReturnType<FactUpdateNoticeService["noticeMemoryAtRoot"]>>,
    oldSnapshotRef: UpdateDecision["oldSnapshotRef"],
    oldRefs: FactSnapshot["factRefs"],
    newRefs: FactSnapshot["factRefs"],
  ): boolean {
    if (!memory || (memory.decision.decision !== "reject" && memory.decision.decision !== "defer")) return false;
    return same(memory.decision.oldSnapshotRef, oldSnapshotRef)
      && same(memory.decision.oldFactIds, oldRefs.map((ref) => ref.factId))
      && same(memory.decision.newFactIds, newRefs.map((ref) => ref.factId));
  }

  async listAtRoot(activeRoot: string, planId: string): Promise<FactUpdateNotice[]> {
    this.assertPlanId(planId);
    const context = await this.planContextAtRoot(activeRoot, planId);
    const selectedRef = await this.selectedSnapshotAtRoot(activeRoot, planId, context);
    const base = await this.snapshotClosureAtRoot(activeRoot, selectedRef);
    if (base.facts.some((fact) => fact.subject.kind === "plan_subject" && fact.subject.planId !== planId)) {
      throw new FactUpdateNoticeServiceError("corrupt_data", "selected fact snapshot crosses plan_subject ownership");
    }
    const currentFacts = await this.relevantCurrentProductFactsAtRoot(activeRoot, planId, context.target);
    const currentSubjectKeys = new Set(currentFacts.map((fact) => factSubjectKey(fact.subject)));
    if (base.facts.some((fact) => fact.subject.kind === "product" && !currentSubjectKeys.has(factSubjectKey(fact.subject)))) {
      throw new FactUpdateNoticeServiceError("conflict", "selected product snapshot is outside the plan relevance authority");
    }
    const currentGroups = new Map<string, FactRecord[]>();
    for (const fact of currentFacts) {
      const key = `${factSubjectKey(fact.subject)}\0${fact.field}`;
      const group = currentGroups.get(key) ?? [];
      group.push(fact);
      currentGroups.set(key, group);
    }
    const baseGroups = new Map<string, FactRecord[]>();
    for (const fact of base.facts.filter((candidate) => candidate.subject.kind === "product")) {
      const key = `${factSubjectKey(fact.subject)}\0${fact.field}`;
      const group = baseGroups.get(key) ?? [];
      group.push(fact);
      baseGroups.set(key, group);
    }
    const persisted = await this.options.decisions.listNoticesForPlanAtRoot(activeRoot, planId);
    const notices: FactUpdateNotice[] = [];
    for (const [key, oldGroupValue] of [...baseGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const newGroupValue = currentGroups.get(key);
      if (!newGroupValue?.length) continue;
      const oldGroup = [...oldGroupValue].sort((left, right) => left.factId.localeCompare(right.factId));
      const newGroup = [...newGroupValue].sort((left, right) => left.factId.localeCompare(right.factId));
      const oldMap = new Map(oldGroup.map((fact) => [fact.factId, fact.contentHash]));
      const newMap = new Map(newGroup.map((fact) => [fact.factId, fact.contentHash]));
      const oldDelta = oldGroup.filter((fact) => newMap.get(fact.factId) !== fact.contentHash);
      const newDelta = newGroup.filter((fact) => oldMap.get(fact.factId) !== fact.contentHash);
      if (!oldDelta.length || !newDelta.length) continue;
      const first = oldDelta[0]!;
      if (first.subject.kind !== "product") continue;
      const subjectKey = factSubjectKey(first.subject);
      if (oldDelta.some((fact) => fact.subject.kind !== "product" || factSubjectKey(fact.subject) !== subjectKey || fact.field !== first.field)
        || newDelta.some((fact) => fact.subject.kind !== "product" || factSubjectKey(fact.subject) !== subjectKey || fact.field !== first.field)) {
        throw new FactUpdateNoticeServiceError("corrupt_data", "fact update grouping lost subject/field ownership");
      }
      const memory = await this.options.decisions.getMemoryAtRoot(activeRoot, {
        subjectKey,
        claimKey: first.field,
        revision: decisionRevision(first.subject),
        planIds: [planId],
      });
      const oldDeltaRefs = factRefs(oldDelta);
      const newDeltaRefs = factRefs(newDelta);
      if (this.handledByCurrentMemory(memory, selectedRef, oldDeltaRefs, newDeltaRefs)) continue;
      const expectedMemoryRevision = memory?.revision ?? -1;
      const common = {
        planId,
        target: clone(context.target),
        subjectKey,
        claimKey: first.field,
        revision: decisionRevision(first.subject),
        expectedMemoryRevision,
        memoryRevision: expectedMemoryRevision + 1,
        ...(memory ? { previousDecisionRef: {
          updateDecisionId: memory.decision.updateDecisionId,
          contentHash: memory.decision.contentHash,
        } } : {}),
        oldSnapshotRef: clone(selectedRef),
        oldFactRefs: oldDeltaRefs,
        newFactRefs: newDeltaRefs,
        affectedDomains: [...requiredEvaluationDomainsForFactField(first.field)].sort(),
      };
      const sourceHash = factUpdateNoticeSourceHash({
        ...common,
        newSnapshotRef: clone(selectedRef),
        createdAt: "1970-01-01T00:00:00.000Z",
      } as FactUpdateNoticeInput);
      const existing = persisted.find((notice) => notice.sourceHash === sourceHash);
      if (existing) {
        await this.snapshotClosureAtRoot(activeRoot, existing.newSnapshotRef);
        notices.push(clone(existing));
        continue;
      }
      const candidate = await this.options.facts.createFactUpdateCandidateSnapshotAtRoot(activeRoot, {
        planId,
        baseSnapshotId: base.snapshot.snapshotId,
        subjectKey,
        field: first.field,
        replacementFactIds: newGroup.map((fact) => fact.factId),
      });
      const notice = createFactUpdateNotice({
        ...common,
        newSnapshotRef: snapshotRef(candidate),
        createdAt: this.now(),
      });
      notices.push(await this.options.decisions.putNoticeAtRoot(activeRoot, notice));
    }
    return notices.sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)
      || left.claimKey.localeCompare(right.claimKey) || left.updateNoticeId.localeCompare(right.updateNoticeId));
  }

  async list(planId: string): Promise<FactUpdateNotice[]> {
    this.assertPlanId(planId);
    await this.coordinator.initialize();
    return clone((await this.coordinator.withWrite(
      ({ activeRoot }: { activeRoot: string }) => this.listAtRoot(activeRoot, planId),
    )).result as FactUpdateNotice[]);
  }

  async viewAtRoot(activeRoot: string, planId: string, noticeId: string): Promise<FactUpdateNotice> {
    this.assertPlanId(planId);
    if (!NOTICE_ID.test(noticeId)) throw new FactUpdateNoticeServiceError("invalid_input", "fact update noticeId invalid");
    const notice = await this.options.decisions.getNoticeAtRoot(activeRoot, noticeId);
    if (!notice || notice.planId !== planId) throw new FactUpdateNoticeServiceError("not_found", "fact update notice was not found for this plan");
    await this.snapshotClosureAtRoot(activeRoot, notice.oldSnapshotRef);
    await this.snapshotClosureAtRoot(activeRoot, notice.newSnapshotRef);
    return clone(notice);
  }

  async view(planId: string, noticeId: string): Promise<FactUpdateNotice> {
    this.assertPlanId(planId);
    await this.coordinator.initialize();
    return clone((await this.coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => this.viewAtRoot(activeRoot, planId, noticeId),
    )).result as FactUpdateNotice);
  }

  private async noticeStatusAtRoot(
    activeRoot: string,
    notice: FactUpdateNotice,
    context: FactUpdatePlanNoticeContext,
  ): Promise<{ kind: "pending" } | { kind: "accepted"; decision: UpdateDecision }> {
    if (!same(context.target, notice.target)) throw new FactUpdateNoticeServiceError("conflict", "fact update notice plan target changed");
    const selected = await this.selectedSnapshotAtRoot(activeRoot, notice.planId, context);
    const memory = await this.noticeMemoryAtRoot(activeRoot, notice);
    if ((memory?.revision ?? -1) === notice.expectedMemoryRevision
      && same(selected, notice.oldSnapshotRef)
      && (memory
        ? notice.previousDecisionRef?.updateDecisionId === memory.decision.updateDecisionId
          && notice.previousDecisionRef.contentHash === memory.decision.contentHash
        : notice.previousDecisionRef === undefined)) return { kind: "pending" };
    if (memory?.decision.decision === "accept" && decisionMatchesNotice(memory.decision, notice)
      && same(selected, notice.newSnapshotRef)) return { kind: "accepted", decision: clone(memory.decision) };
    throw new FactUpdateNoticeServiceError("conflict", "fact update notice is stale for the selected plan snapshot or memory");
  }

  /** Adapter consumed by AuthorizedFactCandidateAuthority in the evaluation pipeline. */
  async resolveFactUpdateSnapshotAtRoot(
    activeRoot: string,
    value: unknown,
  ): Promise<ResolvedFactRepositorySnapshotClosure> {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !exactKeys(value as Record<string, unknown>, ["planId", "target", "updateNoticeId", "phase"])) {
      throw new FactUpdateNoticeServiceError("invalid_input", "authorized fact update target fields invalid");
    }
    const request = value as unknown as ResolveFactUpdateNoticeSnapshotInput;
    this.assertPlanId(request.planId);
    if (validateFactUpdateNoticePlanTarget(request.target).length
      || !NOTICE_ID.test(request.updateNoticeId)
      || (request.phase !== "before" && request.phase !== "after")) {
      throw new FactUpdateNoticeServiceError("invalid_input", "authorized fact update target invalid");
    }
    const notice = await this.viewAtRoot(activeRoot, request.planId, request.updateNoticeId);
    const context = await this.planContextAtRoot(activeRoot, request.planId);
    if (!same(request.target, notice.target)) throw new FactUpdateNoticeServiceError("conflict", "authorized fact update target does not match its notice");
    await this.noticeStatusAtRoot(activeRoot, notice, context);
    return this.snapshotClosureAtRoot(activeRoot, request.phase === "before" ? notice.oldSnapshotRef : notice.newSnapshotRef);
  }

  private async prepareDecisionAtRoot(
    activeRoot: string,
    planId: string,
    input: DecideFactUpdateNoticeInput,
  ): Promise<{ notice: FactUpdateNotice; decision: UpdateDecision }> {
    const notice = await this.viewAtRoot(activeRoot, planId, input.noticeId);
    const context = await this.planContextAtRoot(activeRoot, planId);
    const currentMemory = await this.noticeMemoryAtRoot(activeRoot, notice);
    const currentDecision = currentMemory?.decision;

    // Preserve the repository's pure-replay contract at the transport authority
    // boundary. A caller retrying the exact confirmed operation after losing its
    // response must receive the original immutable result without evaluating the
    // candidate against today's state. Memory revision equality prevents an old
    // notice from aliasing a later decision over the same subject and field.
    if (currentDecision && decisionMatchesNotice(currentDecision, notice)) {
      const initialReplay = currentDecision.memoryRevision === notice.memoryRevision
        && input.expectedMemoryRevision === notice.expectedMemoryRevision
        && input.action === currentDecision.decision
        && input.action !== "undo";
      const undoReplay = currentDecision.decision === "undo"
        && input.action === "undo"
        && currentDecision.memoryRevision === notice.memoryRevision + 1
        && input.expectedMemoryRevision === notice.memoryRevision
        && currentDecision.supersedesDecisionId === input.decisionId;
      if (initialReplay || undoReplay) return { notice, decision: clone(currentDecision) };
    }

    const status = await this.noticeStatusAtRoot(activeRoot, notice, context);
    let previous: UpdateDecision | undefined;
    if (input.action === "undo") {
      if (status.kind !== "accepted" || status.decision.updateDecisionId !== input.decisionId) {
        throw new FactUpdateNoticeServiceError("conflict", "undo decision is not the active accepted decision for this notice");
      }
      previous = status.decision;
    } else if (status.kind !== "pending") {
      throw new FactUpdateNoticeServiceError("conflict", "an accepted fact update requires undo, not a second decision");
    }
    const memory = currentMemory;
    if ((memory?.revision ?? -1) !== input.expectedMemoryRevision) {
      throw new FactUpdateNoticeServiceError("conflict", "fact update decision memory CAS revision mismatch");
    }
    if (input.action !== "undo" && input.expectedMemoryRevision !== notice.expectedMemoryRevision) {
      throw new FactUpdateNoticeServiceError("conflict", "fact update notice expected memory revision changed");
    }
    const superseded = previous ?? memory?.decision;
    const decision = await createUpdateDecision({
      schemaVersion: "fact-update-decision-v1",
      subjectKey: notice.subjectKey,
      claimKey: notice.claimKey,
      revision: notice.revision,
      memoryRevision: input.expectedMemoryRevision + 1,
      planIds: [planId],
      oldSnapshotRef: clone(notice.oldSnapshotRef),
      newSnapshotRef: clone(notice.newSnapshotRef),
      oldFactIds: notice.oldFactRefs.map((ref) => ref.factId),
      newFactIds: notice.newFactRefs.map((ref) => ref.factId),
      fieldDiffs: [{
        field: notice.claimKey,
        beforeFactIds: notice.oldFactRefs.map((ref) => ref.factId),
        afterFactIds: notice.newFactRefs.map((ref) => ref.factId),
      }],
      affectedDomains: clone(notice.affectedDomains),
      decision: input.action,
      decidedBy: "user",
      decidedAt: superseded?.decidedAt ?? notice.createdAt,
      ...(superseded ? {
        supersedesDecisionId: superseded.updateDecisionId,
        supersedesDecisionHash: superseded.contentHash,
      } : {}),
      safetyWarningRetained: true,
    });
    return { notice, decision };
  }

  private evaluationTargetForSnapshot(
    notice: FactUpdateNotice,
    planId: string,
    snapshot: Readonly<FactSnapshot>,
  ): FactUpdateAuthorizedTarget {
    const phase = snapshot.snapshotId === notice.oldSnapshotRef.snapshotId ? "before"
      : snapshot.snapshotId === notice.newSnapshotRef.snapshotId ? "after" : null;
    if (!phase || snapshot.contentHash !== (phase === "before" ? notice.oldSnapshotRef.contentHash : notice.newSnapshotRef.contentHash)) {
      throw new FactUpdateNoticeServiceError("corrupt_data", "fact update evaluator requested a snapshot outside its notice");
    }
    return { planId, target: clone(notice.target), updateNoticeId: notice.updateNoticeId, phase };
  }

  private precommitAuthorizerFor(
    planId: string,
    input: DecideFactUpdateNoticeInput,
    prepared: Readonly<{ notice: FactUpdateNotice; decision: UpdateDecision }>,
    preparedRuntime: Readonly<FactUpdateRuntimeAuthority>,
  ): UpdateDecisionPrecommitAuthorizer {
    const expectedNotice = clone(prepared.notice);
    const expectedDecision = clone(prepared.decision);
    const expectedInput = clone(input);
    const expectedRuntime = clone(preparedRuntime);
    return async ({ activeRoot, runtimeGeneration, decision, expectedMemoryRevision, preparedTransaction }) => {
      if (planId !== expectedNotice.planId
        || expectedInput.noticeId !== expectedNotice.updateNoticeId
        || expectedInput.action !== expectedDecision.decision
        || expectedMemoryRevision !== expectedInput.expectedMemoryRevision
        || !same(decision, expectedDecision)
        || !same(preparedTransaction.decision, expectedDecision)) {
        throw new FactUpdateNoticeServiceError("corrupt_data", "fact update precommit preparation authority changed");
      }
      if (path.resolve(activeRoot) !== path.resolve(expectedRuntime.activeRoot)
        || runtimeGeneration !== expectedRuntime.runtimeGeneration) {
        throw new FactUpdateNoticeServiceError("conflict", "fact update runtime generation changed before commit");
      }

      // This callback runs under UpdateDecisionRepository's writer. Every read is
      // explicitly pinned to that writer's activeRoot; it must never re-enter the
      // coordinator or resolve a different generation.
      const notice = await this.viewAtRoot(activeRoot, planId, expectedNotice.updateNoticeId);
      if (!same(notice, expectedNotice) || !decisionMatchesNotice(expectedDecision, notice)) {
        throw new FactUpdateNoticeServiceError("corrupt_data", "immutable fact update notice changed before commit");
      }
      const planContext = await this.planContextAtRoot(activeRoot, planId);
      if (!same(planContext.target, notice.target)) {
        throw new FactUpdateNoticeServiceError("conflict", "fact update notice plan target changed before commit");
      }
      if (notice.target.kind === "draft"
        && (planContext.target.kind !== "draft"
          || planContext.target.expectedDraftRevision !== notice.target.expectedDraftRevision
          || planContext.target.expectedConfigHash !== notice.target.expectedConfigHash)) {
        throw new FactUpdateNoticeServiceError("conflict", "fact update notice draft revision or config changed before commit");
      }
      if (notice.target.kind === "version"
        && (planContext.target.kind !== "version"
          || planContext.target.versionId !== notice.target.versionId
          || planContext.target.expectedConfigHash !== notice.target.expectedConfigHash)) {
        throw new FactUpdateNoticeServiceError("conflict", "fact update notice PlanVersion authority changed before commit");
      }

      const expectedEvaluationTarget = notice.target.kind === "draft"
        ? { kind: "draft" as const, draftRevision: notice.target.expectedDraftRevision }
        : { kind: "version" as const, versionId: notice.target.versionId };
      for (const diff of preparedTransaction.evaluationDiffs) {
        if (diff.planId !== planId
          || diff.before.planId !== planId || diff.after.planId !== planId
          || diff.before.runtimeGeneration !== expectedRuntime.runtimeGeneration
          || diff.after.runtimeGeneration !== expectedRuntime.runtimeGeneration
          || !same(diff.before.target, expectedEvaluationTarget)
          || !same(diff.after.target, expectedEvaluationTarget)
          || (notice.target.expectedConfigHash !== undefined
            && (diff.before.configHash !== notice.target.expectedConfigHash
              || diff.after.configHash !== notice.target.expectedConfigHash))) {
          throw new FactUpdateNoticeServiceError("conflict", "fact update evaluation receipt target changed before commit");
        }
      }

      const status = await this.noticeStatusAtRoot(activeRoot, notice, planContext);
      const selected = await this.selectedSnapshotAtRoot(activeRoot, planId, planContext);
      const memory = await this.noticeMemoryAtRoot(activeRoot, notice);
      if ((memory?.revision ?? -1) !== expectedInput.expectedMemoryRevision
        || expectedDecision.memoryRevision !== expectedInput.expectedMemoryRevision + 1) {
        throw new FactUpdateNoticeServiceError("conflict", "fact update memory changed before commit");
      }
      if (memory
        ? expectedDecision.supersedesDecisionId !== memory.decision.updateDecisionId
          || expectedDecision.supersedesDecisionHash !== memory.decision.contentHash
        : expectedDecision.supersedesDecisionId !== undefined || expectedDecision.supersedesDecisionHash !== undefined) {
        throw new FactUpdateNoticeServiceError("conflict", "fact update memory predecessor changed before commit");
      }
      if (expectedInput.action === "undo") {
        if (status.kind !== "accepted" || !memory
          || memory.decision.decision !== "accept"
          || memory.decision.updateDecisionId !== expectedInput.decisionId
          || !same(selected, notice.newSnapshotRef)) {
          throw new FactUpdateNoticeServiceError("conflict", "accepted fact update changed before undo commit");
        }
      } else if (status.kind !== "pending" || !same(selected, notice.oldSnapshotRef)
        || expectedInput.expectedMemoryRevision !== notice.expectedMemoryRevision) {
        throw new FactUpdateNoticeServiceError("conflict", "pending fact update notice changed before commit");
      }
    };
  }

  private updateServiceFor(
    notice: FactUpdateNotice,
    runtimeAuthority: Readonly<FactUpdateRuntimeAuthority>,
  ): FactUpdateService {
    return new FactUpdateService({
      decisions: this.options.decisions,
      snapshots: this.options.facts,
      expectedRuntimeGeneration: runtimeAuthority.runtimeGeneration,
      evaluate: (planId, snapshot) => this.options.evaluator.evaluateFactUpdateTarget(
        this.evaluationTargetForSnapshot(notice, planId, snapshot),
      ),
      ...(this.options.evaluator.evaluateFactUpdateTargetAtRoot ? {
        evaluateAtRoot: (activeRoot: string, planId: string, snapshot: Readonly<FactSnapshot>) => (
          this.options.evaluator.evaluateFactUpdateTargetAtRoot!(
            activeRoot,
            this.evaluationTargetForSnapshot(notice, planId, snapshot),
          )
        ),
      } : {}),
    });
  }

  async decideAtRoot(activeRoot: string, planId: string, value: unknown): Promise<FactUpdateNoticeDecisionResult> {
    this.assertPlanId(planId);
    validateDecisionInput(value);
    const input = clone(value);
    const runtimeAuthority = runtimeAuthorityAtRoot(activeRoot);
    const prepared = await this.prepareDecisionAtRoot(activeRoot, planId, input);
    try {
      if (!this.options.evaluator.evaluateFactUpdateTargetAtRoot) {
        throw new FactUpdateNoticeServiceError("invalid_input", "root-bound fact update evaluator is unavailable");
      }
      const committed = await this.updateServiceFor(prepared.notice, runtimeAuthority).decideAtRoot(activeRoot, {
        decision: prepared.decision,
        expectedMemoryRevision: input.expectedMemoryRevision,
        precommitAuthorizer: this.precommitAuthorizerFor(planId, input, prepared, runtimeAuthority),
      });
      return { ...committed, notice: clone(prepared.notice) };
    } catch (error) {
      if (error instanceof UpdateDecisionRepositoryError) {
        throw new FactUpdateNoticeServiceError(error.code, error.message);
      }
      throw error;
    }
  }

  async decide(planId: string, value: unknown): Promise<FactUpdateNoticeDecisionResult> {
    this.assertPlanId(planId);
    validateDecisionInput(value);
    await this.coordinator.initialize();
    const preparedSnapshot = await this.coordinator.withConsistentSnapshot(
      async ({ activeRoot, state }: {
        activeRoot: string;
        state: { runtimeGeneration: number };
      }) => ({
        prepared: await this.prepareDecisionAtRoot(activeRoot, planId, clone(value)),
        runtimeAuthority: { activeRoot: path.resolve(activeRoot), runtimeGeneration: state.runtimeGeneration },
      }),
    );
    const { prepared, runtimeAuthority } = preparedSnapshot.result as {
      prepared: { notice: FactUpdateNotice; decision: UpdateDecision };
      runtimeAuthority: FactUpdateRuntimeAuthority;
    };
    try {
      const committed = await this.updateServiceFor(prepared.notice, runtimeAuthority).decide({
        decision: prepared.decision,
        expectedMemoryRevision: value.expectedMemoryRevision,
        precommitAuthorizer: this.precommitAuthorizerFor(planId, clone(value), prepared, runtimeAuthority),
      });
      return { ...committed, notice: clone(prepared.notice) };
    } catch (error) {
      if (error instanceof UpdateDecisionRepositoryError) {
        throw new FactUpdateNoticeServiceError(error.code, error.message);
      }
      throw error;
    }
  }
}

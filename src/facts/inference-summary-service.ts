import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import {
  PLAN_INFERENCE_SUMMARY_SCHEMA_VERSION,
  type PlanInferenceSummary,
} from "../plans/contracts";
import type { FactRecord } from "./contracts";
import type { InferenceCandidateRepository } from "./inference-candidate-repository";
import type { ResolvedInferenceCandidateApproval } from "./inference-candidate-service";
import type { FactRepository, InferenceApprovalTransaction } from "./repository";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export interface PlanInferenceSummaryProjection {
  readonly schemaVersion: "plan-inference-summary-list-v1";
  readonly planId: string;
  readonly runtimeGeneration: number;
  readonly featureEnabled: boolean;
  readonly inferences: readonly PlanInferenceSummary[];
}

export interface PlanInferenceSummaryServiceOptions {
  readonly coordinator: RuntimeCoordinator;
  readonly candidates: InferenceCandidateRepository;
  readonly facts: FactRepository;
  readonly featureEnabled: boolean;
  readonly resolveCurrentFactAtRoot: (
    activeRoot: string,
    runtimeGeneration: number,
    candidateId: string,
    expectedCandidateHash: string,
    currentFacts: readonly Readonly<FactRecord>[],
  ) => Promise<ResolvedInferenceCandidateApproval | null>;
}

function transactionForCandidate(
  transactions: readonly InferenceApprovalTransaction[],
  candidateId: string,
): InferenceApprovalTransaction | undefined {
  const matches = transactions.filter((transaction) => transaction.candidateId === candidateId);
  if (matches.length > 1) throw new Error(`inference candidate has duplicate approval transactions: ${candidateId}`);
  return matches[0];
}

function isCurrentFact(
  currentFacts: readonly FactRecord[],
  transaction: InferenceApprovalTransaction | undefined,
): boolean {
  if (!transaction || transaction.status !== "committed") return false;
  return currentFacts.some((fact) => fact.factId === transaction.fact.factId
    && fact.contentHash === transaction.fact.contentHash);
}

/**
 * Server-owned, root-pinned inference read model. Every lifecycle decision is
 * derived from immutable candidates, approval journals, replay authority and
 * the current FactRepository closure from one RuntimeCoordinator snapshot.
 */
export class PlanInferenceSummaryService {
  constructor(private readonly options: PlanInferenceSummaryServiceOptions) {}

  async forPlanAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    planId: string,
  ): Promise<PlanInferenceSummaryProjection> {
    if (!PLAN_ID.test(planId)) throw new TypeError("inference summary plan ID is invalid");
    if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
      throw new TypeError("inference summary runtime generation is invalid");
    }
    const [allCandidates, transactions, currentFacts] = await Promise.all([
      this.options.candidates.listAtRoot(activeRoot),
      this.options.facts.listInferenceApprovalTransactionsAtRoot(activeRoot),
      this.options.facts.listCurrentFactsAtRoot(activeRoot, runtimeGeneration),
    ]);
      const candidates = allCandidates.filter((candidate) => candidate.planId === planId);
      const inferences: PlanInferenceSummary[] = [];
      for (const candidate of candidates) {
        const transaction = transactionForCandidate(transactions, candidate.candidateId);
        const replay = this.options.featureEnabled
          ? await this.options.resolveCurrentFactAtRoot(
            activeRoot,
            runtimeGeneration,
            candidate.candidateId,
            candidate.contentHash,
            currentFacts,
          )
          : null;
        const lifecycle: PlanInferenceSummary["lifecycle"] = !this.options.featureEnabled
          ? "disabled_historical"
          : transaction?.status === "aborted_stale"
            ? "aborted_stale"
            : replay === null
              ? "stale"
              : transaction?.status === "pending"
                ? "approval_pending_recovery"
                : isCurrentFact(currentFacts, transaction)
                  ? "active"
                  : "pending_approval";
        const trace = candidate.trace;
        const outputRange = trace.outputRange;
        if (!outputRange) throw new Error(`inference candidate is missing its governed output range: ${candidate.candidateId}`);
        const numericValue = typeof candidate.proposedFact.value === "number"
          && Number.isFinite(candidate.proposedFact.value)
          ? candidate.proposedFact.value
          : null;
        inferences.push(Object.freeze({
          schemaVersion: PLAN_INFERENCE_SUMMARY_SCHEMA_VERSION,
          candidateId: candidate.candidateId,
          candidateHash: candidate.contentHash,
          planId: candidate.planId,
          featureEnabled: this.options.featureEnabled,
          lifecycle,
          ...(candidate.proposalApprovalRef === undefined ? {} : {
            proposalApprovalRef: candidate.proposalApprovalRef,
          }),
          ...(transaction === undefined ? {} : {
            transaction: Object.freeze({
              transactionId: transaction.transactionId as `inference-approval-sha256-${string}`,
              status: transaction.status,
              ...(transaction.approvalAuthorityRef === undefined ? {} : {
                approvalAuthorityRef: transaction.approvalAuthorityRef,
              }),
            }),
          }),
          inference: Object.freeze({
            inferenceTraceId: trace.inferenceTraceId as `inference-sha256-${string}`,
            contentHash: trace.contentHash,
            ruleOrModelId: trace.ruleOrModelId,
            ruleOrModelVersion: trace.ruleOrModelVersion,
            ruleOrModelArtifactHash: trace.ruleOrModelArtifactHash,
            formula: candidate.rule.formula,
            inputFactRefs: Object.freeze(trace.inputFactRefs.map((ref) => Object.freeze({ ...ref }))),
            assumptions: Object.freeze([...trace.assumptions]),
            outputRange: Object.freeze({
              min: outputRange.min,
              max: outputRange.max,
              ...(outputRange.unit === undefined ? {} : { unit: outputRange.unit }),
            }),
            invalidationConditions: Object.freeze([...trace.invalidationConditions]),
            confidence: trace.confidence,
          }),
          output: Object.freeze({
            factId: candidate.proposedFact.factId,
            fieldId: candidate.proposedFact.field,
            value: numericValue,
            ...(candidate.proposedFact.unit === undefined ? {} : { unit: candidate.proposedFact.unit }),
            safetyClass: candidate.proposedFact.safetyClass,
          }),
          safetyDisposition: candidate.safetyDisposition,
          maySupportSafetyPass: false,
          createdAt: candidate.createdAt,
        }));
      }
      inferences.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
        || left.candidateId.localeCompare(right.candidateId));
      return Object.freeze({
        schemaVersion: "plan-inference-summary-list-v1" as const,
        planId,
        runtimeGeneration,
        featureEnabled: this.options.featureEnabled,
        inferences: Object.freeze(inferences),
      });
  }

  async forPlan(planId: string): Promise<PlanInferenceSummaryProjection> {
    if (!PLAN_ID.test(planId)) throw new TypeError("inference summary plan ID is invalid");
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(({ activeRoot, state }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => this.forPlanAtRoot(activeRoot, state.runtimeGeneration, planId))).result;
  }
}

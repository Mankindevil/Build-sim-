import type { BuildConfig } from "../config/types";
import { parseAuthoritativeBuildConfig } from "../server/evaluation-service";
import { evaluateBuildAuthoritatively } from "../server/evaluation-service";
import { diffEvaluations } from "./evaluation";
import { sha256Hex } from "./canonical";
import { assertExpectedConfigHash, assertExpectedRevision } from "./conflict";
import { PLAN_SCHEMA_VERSION, type BuildIntent, type BuildPlan, type PlanChangeProposal, type PlanPatchOperation, type PlanRepository } from "./contracts";
import { assertValidPlanChangeProposal } from "./validation";

export class PlanProposalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

function decodePath(path: string): string[] {
  return path.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function applyPlanPatchOperations(config: BuildConfig, operations: PlanPatchOperation[]): BuildConfig {
  const candidate = structuredClone(config) as unknown as Record<string, unknown>;
  for (const operation of operations) {
    const segments = decodePath(operation.path);
    let parent: Record<string, unknown> = candidate;
    for (const segment of segments.slice(0, -1)) {
      const child = parent[segment];
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new PlanProposalError("patch_path_invalid", `Cannot traverse ${operation.path}`);
      parent = child as Record<string, unknown>;
    }
    const key = segments.at(-1)!;
    if (operation.op === "remove") delete parent[key];
    else parent[key] = structuredClone(operation.value);
  }
  return parseAuthoritativeBuildConfig(candidate);
}

export interface PreviewPlanProposalInput {
  id?: string;
  planId: string;
  expectedDraftRevision: number;
  expectedConfigHash: string;
  summary: string;
  rationale: string[];
  operations: PlanPatchOperation[];
  createdAt?: string;
  kind?: "change" | "initialization";
  intent?: BuildIntent;
}

export async function previewPlanProposal(config: BuildConfig, input: PreviewPlanProposalInput): Promise<{ proposal: PlanChangeProposal; candidate: BuildConfig }> {
  const actualHash = await sha256Hex(config);
  assertExpectedConfigHash(input.expectedConfigHash, actualHash);
  const candidate = applyPlanPatchOperations(config, input.operations);
  const before = evaluateBuildAuthoritatively(config).evaluation;
  const after = evaluateBuildAuthoritatively(candidate).evaluation;
  const impact = diffEvaluations(before, after);
  const proposal: PlanChangeProposal = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id: input.id ?? `proposal-${crypto.randomUUID()}`,
    planId: input.planId,
    expectedDraftRevision: input.expectedDraftRevision,
    expectedConfigHash: input.expectedConfigHash,
    createdAt: input.createdAt ?? new Date().toISOString(),
    summary: input.summary,
    rationale: [...input.rationale],
    operations: structuredClone(input.operations),
    predictedImpact: { resolvedFindingIds: impact.resolvedFindingIds, introducedFindingIds: impact.introducedFindingIds, budgetDeltaCny: impact.budgetDeltaCny },
    status: "proposed",
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.intent ? { intent: structuredClone(input.intent) } : {}),
  };
  assertValidPlanChangeProposal(proposal);
  return { proposal, candidate };
}

export interface ProposalApprovalAudit {
  schemaVersion: "1.0.0";
  approvalId: string;
  proposalId: string;
  planId: string;
  approvedBy: string;
  operationIndexes: number[];
  beforeConfigHash: string;
  afterConfigHash: string;
  appliedAt: string;
  idempotencyKey: string;
}

export class PlanProposalService {
  private readonly applied = new Map<string, { proposal: PlanChangeProposal; plan: BuildPlan; audit: ProposalApprovalAudit }>();
  constructor(private readonly repository: PlanRepository, private readonly now = () => new Date().toISOString()) {}

  async validate(planId: string, proposal: PlanChangeProposal, operationIndexes?: number[]): Promise<PlanChangeProposal> {
    assertValidPlanChangeProposal(proposal);
    if (proposal.planId !== planId) throw new PlanProposalError("proposal_plan_mismatch", "Proposal belongs to another plan", 409);
    if (proposal.status !== "proposed") throw new PlanProposalError("proposal_status_invalid", "Only a proposed change can be validated", 409);
    if (operationIndexes?.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= proposal.operations.length)) {
      throw new PlanProposalError("proposal_indexes_invalid", "Proposal operation indexes are out of range");
    }
    if (operationIndexes && new Set(operationIndexes).size !== operationIndexes.length) throw new PlanProposalError("proposal_indexes_invalid", "Proposal operation indexes must be unique");
    const plan = await this.repository.get(planId);
    if (proposal.kind === "initialization") {
      if (plan.metadata.initialization?.status !== "pending") throw new PlanProposalError("initialization_status_invalid", "Only a pending Agent plan can be initialized", 409);
      if (!proposal.intent?.useCase.trim()) throw new PlanProposalError("initialization_intent_required", "Initialization requires a structured build intent");
      const allIndexes = proposal.operations.map((_, index) => index);
      if (operationIndexes && (operationIndexes.length !== allIndexes.length || operationIndexes.some((index, offset) => index !== allIndexes[offset]))) {
        throw new PlanProposalError("initialization_atomic_required", "Initialization must be approved as one atomic configuration", 409);
      }
    }
    assertExpectedRevision(proposal.expectedDraftRevision, plan.draftRevision);
    assertExpectedConfigHash(proposal.expectedConfigHash, await sha256Hex(plan.draft.config));
    const operations = operationIndexes ? operationIndexes.map((index) => proposal.operations[index]!) : proposal.operations;
    if (!operations.length) throw new PlanProposalError("proposal_empty", "At least one proposal operation must be selected");
    return (await previewPlanProposal(plan.draft.config, { ...proposal, operations })).proposal;
  }

  async apply(planId: string, proposal: PlanChangeProposal, operationIndexes: number[] | undefined, approval: { confirmed: boolean; approvedBy: string }): Promise<{ proposal: PlanChangeProposal; plan: BuildPlan; audit: ProposalApprovalAudit }> {
    if (!approval.confirmed || !approval.approvedBy.trim()) throw new PlanProposalError("human_approval_required", "Explicit human approval is required", 403);
    const requestedIndexes = operationIndexes ?? proposal.operations.map((_, index) => index);
    const replayKey = `${planId}:${proposal.id}:${requestedIndexes.join("-")}`;
    const replay = this.applied.get(replayKey);
    if (replay) return structuredClone(replay);
    const canonical = await this.validate(planId, proposal, operationIndexes);
    const current = await this.repository.get(planId);
    const candidate = applyPlanPatchOperations(current.draft.config, canonical.operations);
    const indexes = requestedIndexes;
    const idempotencyKey = `proposal-${proposal.id}-${indexes.join("-")}`;
    const metadata = canonical.kind === "initialization"
      ? {
          ...current.metadata,
          useCase: canonical.intent!.useCase,
          ...(canonical.intent!.budgetCny !== undefined ? { budgetCny: canonical.intent!.budgetCny } : {}),
          initialization: {
            status: "initialized" as const,
            source: "agent" as const,
            intent: structuredClone(canonical.intent!),
            proposalId: canonical.id,
            initializedAt: this.now(),
          },
        }
      : undefined;
    const plan = await this.repository.updateDraft(planId, {
      expectedRevision: current.draftRevision,
      config: candidate,
      ...(candidate.name !== current.name ? { name: candidate.name } : {}),
      ...(metadata ? { metadata } : {}),
      idempotencyKey,
    });
    const afterConfigHash = await sha256Hex(plan.draft.config);
    const applied: PlanChangeProposal = { ...canonical, status: "applied" };
    const result: { proposal: PlanChangeProposal; plan: BuildPlan; audit: ProposalApprovalAudit } = {
      proposal: applied,
      plan,
      audit: {
        schemaVersion: "1.0.0",
        approvalId: `approval-${crypto.randomUUID()}`,
        proposalId: proposal.id,
        planId,
        approvedBy: approval.approvedBy.trim(),
        operationIndexes: indexes,
        beforeConfigHash: proposal.expectedConfigHash,
        afterConfigHash,
        appliedAt: this.now(),
        idempotencyKey,
      },
    };
    this.applied.set(replayKey, structuredClone(result));
    return result;
  }
}

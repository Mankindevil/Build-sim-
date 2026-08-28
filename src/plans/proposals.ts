import { serializeConfig, type BuildConfig, type BuildConfigDocument, type ConfigV2 } from "../config/types";
import { assertValidConfig } from "../config/validate";
import { sha256Hex as sha256String } from "../hash";
import type { TopologyV3PatchOperation } from "../contracts/registries";
import { parseAuthoritativeBuildConfig, evaluateBuildAuthoritatively } from "../server/evaluation-service";
import { loadBundledCatalog } from "../sku/catalog";
import type { SkuCatalog } from "../sku/types";
import type { BuildConfigV3 } from "../topology/contracts";
import { canonicalJson, hashPlanConfig } from "./canonical";
import { assertExpectedConfigHash, assertExpectedRevision } from "./conflict";
import {
  PLAN_IDEMPOTENCY_REQUEST,
  PLAN_SCHEMA_VERSION,
  type BuildIntent,
  type BuildPlan,
  type PlanChangeProposal,
  type PlanConfig,
  type PlanPatchOperation,
  type PlanProposalOperation,
  type PlanRepository,
} from "./contracts";
import { diffEvaluations } from "./evaluation";
import { migrateBuildConfigV2ToV3, type BuildConfigV3MigrationCatalogBinding } from "./migration";
import { validateGovernedPatchOperation } from "../contracts/registries";
import { applyScenarioTopologyPatchRuntime } from "../scenarios/runtime-validation.mjs";
import { assertValidPlanChangeProposal, validatePlanV3ProposalOperation } from "./validation";

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

function stampRoleDecisionOperations(operations: readonly TopologyV3PatchOperation[], confirmedAt: string): TopologyV3PatchOperation[] {
  return operations.map((operation) => {
    if (operation.op !== "add" || operation.selector.collection !== "roleDecisions") return structuredClone(operation);
    const value = operation.value as Record<string, unknown>;
    return {
      ...structuredClone(operation),
      value: { ...structuredClone(value), source: "user", confirmedAt },
    } as TopologyV3PatchOperation;
  });
}

export function applyPlanV3ProposalOperations(config: BuildConfigV3, operations: readonly TopologyV3PatchOperation[], confirmedAt: string): BuildConfigV3 {
  const proposalErrors = operations.flatMap((operation, index) => validatePlanV3ProposalOperation(operation)
    .map((error) => `operations.${index}.${error}`));
  if (proposalErrors.length) throw new PlanProposalError("invalid_operation", proposalErrors.join("; "));
  const stamped = stampRoleDecisionOperations(operations, confirmedAt);
  const materializationErrors = stamped.flatMap((operation, index) => validateGovernedPatchOperation("plan-v3", operation, { actor: "user" })
    .map((error) => `operations.${index}.${error}`));
  if (materializationErrors.length) throw new PlanProposalError("invalid_operation", materializationErrors.join("; "));
  let candidate: BuildConfigV3;
  try {
    candidate = applyScenarioTopologyPatchRuntime(config, stamped) as BuildConfigV3;
  } catch (error) {
    throw new PlanProposalError("invalid_operation", error instanceof Error ? error.message : "Plan proposal patch replay failed");
  }
  try {
    assertValidConfig(candidate, loadBundledCatalog(), { topologyV3Enabled: true });
  } catch (error) {
    throw new PlanProposalError("invalid_result", error instanceof Error ? error.message : "Invalid BuildConfig V3 proposal result");
  }
  return candidate;
}

export type RequirementConfirmationKind = "budget" | "horizonYears" | "workload" | "metric" | "constraint";

export function requirementConfirmationFieldId(kind: RequirementConfirmationKind, id?: string, parentId?: string): string {
  if (kind === "budget" || kind === "horizonYears") return `requirement:${kind}`;
  if (!id?.trim()) throw new TypeError("requirement confirmation identity is missing");
  if (kind === "metric") {
    if (!parentId?.trim()) throw new TypeError("metric confirmation requires workload identity");
    return `requirement:metric:${JSON.stringify([parentId.normalize("NFC"), id.normalize("NFC")])}`;
  }
  return `requirement:${kind}:${JSON.stringify(id.normalize("NFC"))}`;
}

function isAgentConfirmable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).source === "agent_proposed"
    && (value as Record<string, unknown>).confirmedByUser === false;
}

export function confirmableRequirementFieldIds(operations: readonly TopologyV3PatchOperation[]): string[] {
  const ids = new Set<string>();
  for (const operation of operations) {
    if (!("selector" in operation)) continue;
    if (operation.op === "add" && operation.selector.collection === "workloads") {
      if (isAgentConfirmable(operation.value)) ids.add(requirementConfirmationFieldId("workload", operation.selector.id));
      const workload = operation.value as Record<string, unknown>;
      if (Array.isArray(workload.metrics)) for (const metric of workload.metrics) {
        if (isAgentConfirmable(metric) && typeof (metric as Record<string, unknown>).metricId === "string") {
          ids.add(requirementConfirmationFieldId("metric", (metric as Record<string, unknown>).metricId as string, operation.selector.id));
        }
      }
      continue;
    }
    if (operation.op === "add" && operation.selector.collection === "metrics") {
      if (isAgentConfirmable(operation.value)) ids.add(requirementConfirmationFieldId("metric", operation.selector.id, operation.selector.parentId));
      continue;
    }
    if (operation.op === "add" && operation.selector.collection === "constraints") {
      if (isAgentConfirmable(operation.value)) ids.add(requirementConfirmationFieldId("constraint", operation.selector.id));
      continue;
    }
    if (operation.op !== "replace" || operation.selector.collection !== "config") continue;
    if (operation.selector.field === "requirementBudget") {
      if (isAgentConfirmable(operation.value)) ids.add(requirementConfirmationFieldId("budget"));
      continue;
    }
    if (operation.selector.field === "requirementHorizonYears") {
      if (isAgentConfirmable(operation.value)) ids.add(requirementConfirmationFieldId("horizonYears"));
      continue;
    }
    if (operation.selector.field !== "requirementSpec") continue;
    const spec = operation.value as Record<string, unknown> | null;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    if (isAgentConfirmable(spec.budget)) ids.add(requirementConfirmationFieldId("budget"));
    if (isAgentConfirmable(spec.horizonYears)) ids.add(requirementConfirmationFieldId("horizonYears"));
    if (Array.isArray(spec.workloads)) for (const workload of spec.workloads) {
      if (!workload || typeof workload !== "object" || Array.isArray(workload)) continue;
      const row = workload as Record<string, unknown>;
      if (isAgentConfirmable(row) && typeof row.workloadId === "string") ids.add(requirementConfirmationFieldId("workload", row.workloadId));
      if (typeof row.workloadId === "string" && Array.isArray(row.metrics)) for (const metric of row.metrics) {
        if (isAgentConfirmable(metric) && typeof metric.metricId === "string") ids.add(requirementConfirmationFieldId("metric", metric.metricId, row.workloadId));
      }
    }
    if (Array.isArray(spec.constraints)) for (const constraint of spec.constraints) {
      if (isAgentConfirmable(constraint) && typeof constraint.constraintId === "string") ids.add(requirementConfirmationFieldId("constraint", constraint.constraintId));
    }
  }
  return [...ids].sort();
}

export function applyRequirementConfirmations(config: BuildConfigV3, requestedIds: readonly string[]): BuildConfigV3 {
  const candidate = structuredClone(config);
  const requested = new Set(requestedIds);
  const spec = candidate.requirementSpec;
  const stamp = (value: unknown, id: string): void => {
    if (requested.has(id) && isAgentConfirmable(value)) (value as Record<string, unknown>).confirmedByUser = true;
  };
  if (spec) {
    stamp(spec.budget, requirementConfirmationFieldId("budget"));
    stamp(spec.horizonYears, requirementConfirmationFieldId("horizonYears"));
    for (const workload of spec.workloads) {
      stamp(workload, requirementConfirmationFieldId("workload", workload.workloadId));
      for (const metric of workload.metrics) stamp(metric, requirementConfirmationFieldId("metric", metric.metricId, workload.workloadId));
    }
    for (const constraint of spec.constraints) stamp(constraint, requirementConfirmationFieldId("constraint", constraint.constraintId));
  }
  return candidate;
}

export interface PreviewPlanProposalInput<TConfig extends PlanConfig = BuildConfig> {
  id?: string;
  planId: string;
  expectedDraftRevision: number;
  expectedConfigHash: string;
  summary: string;
  rationale: string[];
  operations: PlanProposalOperation<TConfig>[];
  createdAt?: string;
  kind?: "change" | "initialization";
  intent?: BuildIntent;
}

export async function previewPlanProposal<TConfig extends PlanConfig>(
  config: TConfig,
  input: PreviewPlanProposalInput<TConfig>,
): Promise<{ proposal: PlanChangeProposal<TConfig>; candidate: TConfig }> {
  const actualHash = await hashPlanConfig(config);
  assertExpectedConfigHash(input.expectedConfigHash, actualHash);
  const createdAt = input.createdAt ?? new Date().toISOString();
  let candidate: TConfig;
  let predictedImpact: PlanChangeProposal<TConfig>["predictedImpact"];
  if (config.schemaVersion === "3.0.0") {
    candidate = applyPlanV3ProposalOperations(config, input.operations as TopologyV3PatchOperation[], createdAt) as TConfig;
    predictedImpact = { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null };
  } else {
    const legacyCandidate = applyPlanPatchOperations(config, input.operations as PlanPatchOperation[]);
    const impact = diffEvaluations(evaluateBuildAuthoritatively(config).evaluation, evaluateBuildAuthoritatively(legacyCandidate).evaluation);
    candidate = legacyCandidate as TConfig;
    predictedImpact = { resolvedFindingIds: impact.resolvedFindingIds, introducedFindingIds: impact.introducedFindingIds, budgetDeltaCny: impact.budgetDeltaCny };
  }
  const proposal: PlanChangeProposal<TConfig> = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id: input.id ?? `proposal-${crypto.randomUUID()}`,
    planId: input.planId,
    expectedDraftRevision: input.expectedDraftRevision,
    expectedConfigHash: input.expectedConfigHash,
    createdAt,
    summary: input.summary,
    rationale: [...input.rationale],
    configSchemaVersion: config.schemaVersion,
    operations: structuredClone(input.operations),
    ...(config.schemaVersion === "3.0.0" && confirmableRequirementFieldIds(input.operations as TopologyV3PatchOperation[]).length
      ? { confirmableRequirementFieldIds: confirmableRequirementFieldIds(input.operations as TopologyV3PatchOperation[]) }
      : {}),
    predictedImpact,
    status: "proposed",
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.intent ? { intent: structuredClone(input.intent) } : {}),
  };
  assertValidPlanChangeProposal(proposal);
  return { proposal, candidate };
}

export type PreviewPlanV3ProposalFromV2Input = Omit<PreviewPlanProposalInput<BuildConfigV3>, "configSchemaVersion">;

/** Preview the first stable-selector edit against the deterministic V2 migration without writing. */
export async function previewPlanV3ProposalFromV2(
  config: ConfigV2,
  input: PreviewPlanV3ProposalFromV2Input,
  catalogAuthority: SkuCatalog | BuildConfigV3MigrationCatalogBinding,
): Promise<{ proposal: PlanChangeProposal<BuildConfigV3>; candidate: BuildConfigV3 }> {
  assertExpectedConfigHash(input.expectedConfigHash, await hashPlanConfig(config));
  const sourceBytes = serializeConfig(config);
  const migrated = await migrateBuildConfigV2ToV3(config, {
    sourceBytes,
    sourceHash: await sha256String(sourceBytes),
    ...(catalogAuthority.schemaVersion === "build-config-v3-migration-catalog-binding-v1"
      ? { catalogBinding: catalogAuthority as BuildConfigV3MigrationCatalogBinding }
      : { catalog: catalogAuthority as SkuCatalog }),
  });
  const createdAt = input.createdAt ?? new Date().toISOString();
  const candidate = applyPlanV3ProposalOperations(migrated.config, input.operations as TopologyV3PatchOperation[], createdAt);
  const proposal: PlanChangeProposal<BuildConfigV3> = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    id: input.id ?? `proposal-${crypto.randomUUID()}`,
    planId: input.planId,
    expectedDraftRevision: input.expectedDraftRevision,
    expectedConfigHash: input.expectedConfigHash,
    createdAt,
    summary: input.summary,
    rationale: [...input.rationale],
    configSchemaVersion: "3.0.0",
    migrationCatalogBinding: structuredClone(migrated.catalogBinding),
    operations: structuredClone(input.operations),
    ...(confirmableRequirementFieldIds(input.operations as TopologyV3PatchOperation[]).length
      ? { confirmableRequirementFieldIds: confirmableRequirementFieldIds(input.operations as TopologyV3PatchOperation[]) }
      : {}),
    predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null },
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
  confirmedRequirementFieldIds: string[];
}

export interface ProposalApproval {
  confirmed: boolean;
  approvedBy: string;
  /** Separate, stable fields explicitly confirmed from the reviewed selected operations. */
  confirmedRequirementFieldIds?: string[];
}

export class PlanProposalService<TConfig extends PlanConfig = BuildConfig> {
  private readonly applied = new Map<string, {
    requestHash: string;
    result: { proposal: PlanChangeProposal<TConfig>; plan: BuildPlan<TConfig>; audit: ProposalApprovalAudit };
  }>();
  private readonly migrationCatalog: () => SkuCatalog;
  constructor(
    private readonly repository: PlanRepository<TConfig>,
    private readonly now = () => new Date().toISOString(),
    migrationCatalog?: () => SkuCatalog,
  ) {
    const repositoryCatalog = (repository as PlanRepository<TConfig> & { migrationCatalogSnapshot?: () => SkuCatalog }).migrationCatalogSnapshot;
    this.migrationCatalog = migrationCatalog
      ?? (typeof repositoryCatalog === "function" ? () => repositoryCatalog.call(repository) : loadBundledCatalog);
  }

  async validate(planId: string, proposal: PlanChangeProposal<TConfig>, operationIndexes?: number[]): Promise<PlanChangeProposal<TConfig>> {
    assertValidPlanChangeProposal(proposal);
    if (proposal.planId !== planId) throw new PlanProposalError("proposal_plan_mismatch", "Proposal belongs to another plan", 409);
    if (proposal.status !== "proposed") throw new PlanProposalError("proposal_status_invalid", "Only a proposed change can be validated", 409);
    if (operationIndexes?.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= proposal.operations.length)) {
      throw new PlanProposalError("proposal_indexes_invalid", "Proposal operation indexes are out of range");
    }
    if (operationIndexes && new Set(operationIndexes).size !== operationIndexes.length) throw new PlanProposalError("proposal_indexes_invalid", "Proposal operation indexes must be unique");
    const plan = await this.repository.get(planId);
    const targetSchema: string = proposal.configSchemaVersion ?? "2.0.0";
    const migratesOnApply = plan.draft.config.schemaVersion === "2.0.0" && targetSchema === "3.0.0";
    if (!migratesOnApply && targetSchema !== plan.draft.config.schemaVersion) {
      throw new PlanProposalError("proposal_config_schema_mismatch", "Proposal config schema does not match the current draft", 409);
    }
    assertExpectedRevision(proposal.expectedDraftRevision, plan.draftRevision);
    assertExpectedConfigHash(proposal.expectedConfigHash, await hashPlanConfig(plan.draft.config));
    const operations = operationIndexes ? operationIndexes.map((index) => proposal.operations[index]!) : proposal.operations;
    if (!operations.length) throw new PlanProposalError("proposal_empty", "At least one proposal operation must be selected");
    if (plan.draft.config.schemaVersion === "3.0.0" && plan.draft.config.requirementSpec !== null && operations.some((operation) => (
      "selector" in operation && operation.op === "replace" && operation.selector.collection === "config" && operation.selector.field === "requirementSpec"
    ))) {
      throw new PlanProposalError("requirement_spec_replace_forbidden", "An existing RequirementSpec must be edited with stable field/entity selectors", 409);
    }
    if (migratesOnApply) {
      return (await previewPlanV3ProposalFromV2(
        plan.draft.config as ConfigV2,
        { ...proposal, operations } as PreviewPlanV3ProposalFromV2Input,
        proposal.migrationCatalogBinding ?? this.migrationCatalog(),
      )).proposal as PlanChangeProposal<TConfig>;
    }
    return (await previewPlanProposal(plan.draft.config, { ...proposal, operations })).proposal;
  }

  async apply(
    planId: string,
    proposal: PlanChangeProposal<TConfig>,
    operationIndexes: number[] | undefined,
    approval: ProposalApproval,
  ): Promise<{ proposal: PlanChangeProposal<TConfig>; plan: BuildPlan<TConfig>; audit: ProposalApprovalAudit }> {
    if (!approval.confirmed || !approval.approvedBy.trim()) throw new PlanProposalError("human_approval_required", "Explicit human approval is required", 403);
    assertValidPlanChangeProposal(proposal);
    if (proposal.planId !== planId) throw new PlanProposalError("proposal_plan_mismatch", "Proposal belongs to another plan", 409);
    if (proposal.status !== "proposed") throw new PlanProposalError("proposal_status_invalid", "Only a proposed change can be applied", 409);
    const requestedIndexes = operationIndexes ?? proposal.operations.map((_, index) => index);
    if (requestedIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= proposal.operations.length)
      || new Set(requestedIndexes).size !== requestedIndexes.length) {
      throw new PlanProposalError("proposal_indexes_invalid", "Proposal operation indexes are invalid");
    }
    const requestedConfirmationIds = [...(approval.confirmedRequirementFieldIds ?? [])].sort();
    if (new Set(requestedConfirmationIds).size !== requestedConfirmationIds.length || requestedConfirmationIds.some((id) => !id)) {
      throw new PlanProposalError("requirement_confirmation_scope_invalid", "Requirement confirmation field IDs must be unique and non-empty");
    }
    const approvedBy = approval.approvedBy.trim();
    const replayKey = `${planId}:${proposal.id}`;
    const approvalRequest = {
      schemaVersion: "proposal-approval-replay-v1",
      planId,
      proposal,
      operationIndexes: requestedIndexes,
      approval: {
        confirmed: approval.confirmed,
        approvedBy,
        confirmedRequirementFieldIds: requestedConfirmationIds,
      },
    };
    const requestHash = await sha256String(canonicalJson(approvalRequest));
    const idempotencyKey = `proposal-${await sha256String(canonicalJson({ schemaVersion: "proposal-approval-key-v1", planId, proposalId: proposal.id }))}`;
    const resultFor = async (plan: BuildPlan<TConfig>) => {
      const operations = requestedIndexes.map((index) => structuredClone(proposal.operations[index]!));
      const selectedConfirmableIds = confirmableRequirementFieldIds(operations as TopologyV3PatchOperation[]);
      const applied = structuredClone(proposal);
      applied.operations = operations;
      applied.status = "applied";
      if (selectedConfirmableIds.length) applied.confirmableRequirementFieldIds = selectedConfirmableIds;
      else delete applied.confirmableRequirementFieldIds;
      return {
        proposal: applied,
        plan,
        audit: {
          schemaVersion: "1.0.0" as const,
          approvalId: `approval-${requestHash}`,
          proposalId: proposal.id,
          planId,
          approvedBy,
          operationIndexes: requestedIndexes,
          beforeConfigHash: proposal.expectedConfigHash,
          afterConfigHash: await hashPlanConfig(plan.draft.config),
          appliedAt: plan.draft.updatedAt,
          idempotencyKey,
          confirmedRequirementFieldIds: requestedConfirmationIds,
        },
      };
    };
    const persistentReplay = async () => this.repository.replayIdempotentPlanWrite
      ? await this.repository.replayIdempotentPlanWrite(planId, { idempotencyKey, request: approvalRequest })
      : null;
    if (this.repository.replayIdempotentPlanWrite) {
      const persisted = await persistentReplay();
      if (persisted) return await resultFor(persisted);
    } else {
      const replay = this.applied.get(replayKey);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new PlanProposalError("idempotency_conflict", "Proposal approval replay differs from the original request", 409);
        }
        return structuredClone(replay.result);
      }
    }
    let canonical: PlanChangeProposal<TConfig>;
    try {
      canonical = await this.validate(planId, proposal, operationIndexes);
    } catch (error) {
      const persisted = await persistentReplay();
      if (persisted) return await resultFor(persisted);
      throw error;
    }
    const confirmableIds = new Set(confirmableRequirementFieldIds(canonical.operations as TopologyV3PatchOperation[]));
    if (requestedConfirmationIds.some((id) => !confirmableIds.has(id))) {
      throw new PlanProposalError("requirement_confirmation_scope_invalid", "Requirement confirmation must target a reviewed Agent-proposed field", 409);
    }
    let current: BuildPlan<TConfig>;
    try {
      current = await this.repository.get(planId);
      assertExpectedRevision(proposal.expectedDraftRevision, current.draftRevision);
      assertExpectedConfigHash(proposal.expectedConfigHash, await hashPlanConfig(current.draft.config));
    } catch (error) {
      const persisted = await persistentReplay();
      if (persisted) return await resultFor(persisted);
      throw error;
    }
    const metadata = canonical.kind === "initialization" && canonical.intent
      ? {
          ...current.metadata,
          useCase: canonical.intent.useCase,
          ...(canonical.intent.budgetCny !== undefined ? { budgetCny: canonical.intent.budgetCny } : {}),
          initialization: {
            status: "initialized" as const,
            source: "agent" as const,
            intent: structuredClone(canonical.intent),
            proposalId: canonical.id,
            initializedAt: this.now(),
          },
        }
      : undefined;
    let plan: BuildPlan<TConfig>;
    if (current.draft.config.schemaVersion === "2.0.0" && canonical.configSchemaVersion === "3.0.0") {
      if (!this.repository.migrateDraftToV3) throw new PlanProposalError("v3_migration_unavailable", "Repository does not support atomic V3 migration", 409);
      const migrated = await this.repository.migrateDraftToV3(planId, {
        expectedRevision: current.draftRevision,
        catalogBinding: structuredClone(canonical.migrationCatalogBinding!),
        operations: canonical.operations as TopologyV3PatchOperation[],
        ...(metadata ? { metadata } : {}),
        ...(requestedConfirmationIds.length ? { confirmedRequirementFieldIds: requestedConfirmationIds } : {}),
        idempotencyKey,
        [PLAN_IDEMPOTENCY_REQUEST]: approvalRequest,
      });
      plan = migrated as BuildPlan<TConfig>;
    } else {
      let candidate = current.draft.config.schemaVersion === "3.0.0"
        ? applyPlanV3ProposalOperations(current.draft.config, canonical.operations as TopologyV3PatchOperation[], this.now()) as TConfig
        : applyPlanPatchOperations(current.draft.config, canonical.operations as PlanPatchOperation[]) as TConfig;
      if (candidate.schemaVersion === "3.0.0" && requestedConfirmationIds.length) candidate = applyRequirementConfirmations(candidate, requestedConfirmationIds) as TConfig;
      plan = await this.repository.updateDraft(planId, {
        expectedRevision: current.draftRevision,
        config: candidate,
        ...(candidate.name !== current.name ? { name: candidate.name } : {}),
        ...(metadata ? { metadata } : {}),
        idempotencyKey,
        [PLAN_IDEMPOTENCY_REQUEST]: approvalRequest,
      });
    }
    const result = await resultFor(plan);
    this.applied.set(replayKey, { requestHash, result: structuredClone(result) });
    return result;
  }
}

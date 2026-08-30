import type { ProductionEvidenceJobRuntime } from "../evidence/jobs/production";
import type { PlanInferenceSummaryService } from "../facts/inference-summary-service";
import { parseEvidenceJobStatus } from "../lab/evidence-job-panel";
import type {
  PlanEvidenceClaimScopeSummary,
  PlanEvidenceResolutionSummary,
  PlanInferenceSummary,
} from "../plans/contracts";
import type { BuildPlan } from "../plans/contracts";
import type { BuildConfigDocument } from "../config/types";
import type { EvidenceClaim } from "../evidence/contracts";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { PlanCurrentPriceView, ProductionPlanPriceService } from "../price/production";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export interface WorkspacePlanResolutionSummary {
  readonly schemaVersion: "workspace-plan-resolution-summary-v1";
  readonly planId: string;
  readonly runtimeGeneration: number;
  readonly resolutions: readonly PlanEvidenceResolutionSummary[];
  readonly inferences: readonly PlanInferenceSummary[];
  readonly claimScopeCount: number;
  readonly claimScopes: readonly PlanEvidenceClaimScopeSummary[];
  /** Exact evaluation-lock price projection shared by UI and Agent. */
  readonly price: PlanCurrentPriceView | null;
}

export interface WorkspacePlanResolutionSummaryAuthority {
  forPlan(planId: string): Promise<WorkspacePlanResolutionSummary>;
}

export interface RootBoundWorkspacePlanResolutionSummaryAuthority extends WorkspacePlanResolutionSummaryAuthority {
  initialize(): Promise<void>;
  forPlanAtRoot(activeRoot: string, runtimeGeneration: number, planId: string): Promise<WorkspacePlanResolutionSummary>;
}

export interface RootBoundPlanClaimScopeAuthority {
  forPlanAtRoot(activeRoot: string, planId: string): Promise<{
    readonly count: number;
    readonly claims: readonly PlanEvidenceClaimScopeSummary[];
  }>;
}

function planClaimSkuIds(config: BuildConfigDocument): Set<string> {
  if (config.schemaVersion === "3.0.0") {
    return new Set(config.components.flatMap((component) => component.identity.status === "resolved"
      ? [component.identity.skuId] : []));
  }
  return new Set([
    config.caseId, config.boardId, config.cpuId, config.selection.psuId,
    config.selection.secondaryPsuId, config.selection.coolerId, config.selection.gpuId,
    config.selection.memoryId, config.selection.diskSkuId, config.selection.hbaSkuId,
    ...config.bom.map((line) => line.skuId),
  ].filter((value): value is string => typeof value === "string" && value.length > 0));
}

/**
 * Projects only active claim identity/scope metadata for products selected by
 * the plan. Claim values and source text stay behind read-only evidence tools.
 */
export class ProductionPlanClaimScopeSummary implements RootBoundPlanClaimScopeAuthority {
  constructor(private readonly options: {
    plans: { getAtRoot(activeRoot: string, planId: string): Promise<BuildPlan<BuildConfigDocument>> };
    claims: { listClaimsAtRoot(activeRoot: string): Promise<EvidenceClaim[]> };
  }) {}

  async forPlanAtRoot(activeRoot: string, planId: string): Promise<{
    readonly count: number;
    readonly claims: readonly PlanEvidenceClaimScopeSummary[];
  }> {
    let plan: BuildPlan<BuildConfigDocument>;
    try {
      plan = await this.options.plans.getAtRoot(activeRoot, planId);
    } catch (error) {
      // Historical inference/job projections can outlive a removed plan. Keep
      // those audit summaries readable, but never project product claim scope
      // without a current plan identity authority.
      if ((error as { code?: unknown })?.code === "not_found") {
        return Object.freeze({ count: 0, claims: Object.freeze([]) });
      }
      throw error;
    }
    const skuIds = planClaimSkuIds(plan.draft.config);
    const allClaims = await this.options.claims.listClaimsAtRoot(activeRoot);
    const supersededClaimIds = new Set(allClaims.flatMap((claim) => claim.supersedesClaimId ? [claim.supersedesClaimId] : []));
    const relevant = allClaims
      .filter((claim) => claim.status === "active" && !supersededClaimIds.has(claim.claimId)
        && skuIds.has(claim.subject.skuId))
      .sort((left, right) => left.claimId.localeCompare(right.claimId));
    const claims = relevant.slice(0, 20).map((claim): PlanEvidenceClaimScopeSummary => Object.freeze({
      schemaVersion: "plan-evidence-claim-scope-v1",
      claimId: claim.claimId,
      contentHash: claim.contentHash,
      authority: claim.authority,
      fieldId: claim.fieldId,
      scope: claim.scope,
      subject: Object.freeze(structuredClone(claim.subject)),
    }));
    return Object.freeze({ count: relevant.length, claims: Object.freeze(claims) });
  }
}

/**
 * Produces the complete bounded Agent/UI resolution projection from one active
 * runtime root. No browser-submitted summary participates in this authority.
 */
export class ProductionWorkspacePlanResolutionSummary implements RootBoundWorkspacePlanResolutionSummaryAuthority {
  constructor(private readonly options: {
    coordinator: RuntimeCoordinator;
    evidenceJobs?: ProductionEvidenceJobRuntime;
    inferenceSummary?: PlanInferenceSummaryService;
    planPrices?: Pick<ProductionPlanPriceService, "initialize" | "forPlanAtRoot">;
    claimScopes?: RootBoundPlanClaimScopeAuthority;
  }) {}

  async initialize(): Promise<void> {
    await this.options.coordinator.initialize();
    await this.options.evidenceJobs?.initialize();
    await this.options.planPrices?.initialize();
  }

  async forPlanAtRoot(activeRoot: string, runtimeGeneration: number, planId: string): Promise<WorkspacePlanResolutionSummary> {
    if (!PLAN_ID.test(planId)) throw new TypeError("workspace resolution summary plan ID is invalid");
    if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
      throw new TypeError("workspace resolution summary runtime generation is invalid");
    }
    const [evidenceStatuses, inferenceProjection, price, claimScopeProjection] = await Promise.all([
      this.options.evidenceJobs?.listForPlanAtRoot(activeRoot, planId) ?? Promise.resolve([]),
      this.options.inferenceSummary?.forPlanAtRoot(activeRoot, runtimeGeneration, planId)
        ?? Promise.resolve({ inferences: [] as readonly PlanInferenceSummary[] }),
      this.options.planPrices?.forPlanAtRoot(activeRoot, planId) ?? Promise.resolve(null),
      this.options.claimScopes?.forPlanAtRoot(activeRoot, planId) ?? Promise.resolve({ count: 0, claims: [] }),
    ]);
    const resolutions = evidenceStatuses.map((status) => parseEvidenceJobStatus(status).summary);
    if (resolutions.length > 20 || inferenceProjection.inferences.length > 20) {
      throw new Error("workspace resolution summary exceeds the bounded Agent context limit");
    }
    return Object.freeze({
      schemaVersion: "workspace-plan-resolution-summary-v1" as const,
      planId,
      runtimeGeneration,
      resolutions: Object.freeze(resolutions.map((summary) => structuredClone(summary))),
      inferences: Object.freeze(inferenceProjection.inferences.map((summary) => structuredClone(summary))),
      claimScopeCount: claimScopeProjection.count,
      claimScopes: Object.freeze(claimScopeProjection.claims.map((summary) => structuredClone(summary))),
      price: price === null ? null : Object.freeze(structuredClone(price)),
    });
  }

  async forPlan(planId: string): Promise<WorkspacePlanResolutionSummary> {
    await this.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(({ activeRoot, state }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => this.forPlanAtRoot(activeRoot, state.runtimeGeneration, planId))).result;
  }
}

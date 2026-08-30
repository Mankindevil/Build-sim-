import type { ProductionEvidenceJobRuntime } from "../evidence/jobs/production";
import type { PlanInferenceSummaryService } from "../facts/inference-summary-service";
import { parseEvidenceJobStatus } from "../lab/evidence-job-panel";
import type {
  PlanEvidenceResolutionSummary,
  PlanInferenceSummary,
} from "../plans/contracts";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { PlanCurrentPriceView, ProductionPlanPriceService } from "../price/production";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export interface WorkspacePlanResolutionSummary {
  readonly schemaVersion: "workspace-plan-resolution-summary-v1";
  readonly planId: string;
  readonly runtimeGeneration: number;
  readonly resolutions: readonly PlanEvidenceResolutionSummary[];
  readonly inferences: readonly PlanInferenceSummary[];
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
    const [evidenceStatuses, inferenceProjection, price] = await Promise.all([
      this.options.evidenceJobs?.listForPlanAtRoot(activeRoot, planId) ?? Promise.resolve([]),
      this.options.inferenceSummary?.forPlanAtRoot(activeRoot, runtimeGeneration, planId)
        ?? Promise.resolve({ inferences: [] as readonly PlanInferenceSummary[] }),
      this.options.planPrices?.forPlanAtRoot(activeRoot, planId) ?? Promise.resolve(null),
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

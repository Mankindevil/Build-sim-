import type { PlanAgentContext, PlanChangeProposal, PlanConfig, PlanRepository } from "../plans/contracts";
import { repositoryErrorResponse } from "../plans/file-repository";
import { PlanProposalError, PlanProposalService } from "../plans/proposals";
import {
  recordPlanAgentRunContext,
  type PlanAgentContextAuditStore,
  type PlanAgentRunContextAudit,
} from "../plans/agent-context-audit";
import { agentRunIdForIdempotency } from "../agent/run-identity";
import type { PlanEvidenceBinding } from "../evidence/contracts";
import type { AuthoritativeEvaluationSnapshotPipeline } from "./evaluation-service";
import { FactUpdateNoticeServiceError, type FactUpdateNoticeService } from "../facts/update-notice-service";
import { JobRepositoryError } from "../jobs";
import type { EvidenceJobRouteRuntime } from "../evidence/jobs/production";
import type {
  WorkspacePlanResolutionSummary,
  WorkspacePlanResolutionSummaryAuthority,
} from "./plan-resolution-summary";
import type { WholeBuildSolverRouteRuntime } from "./solver-production";
import type { ScenarioWhatIfRouteRuntime } from "./what-if-production";
import { ScenarioRepositoryError } from "../scenarios/repository";
import { SystemExecutionProductionError, type ProductionSystemExecutionRuntime } from "./system-execution-production";
import { SpatialProductionError, type WorkspaceSpatialSceneAuthority } from "./spatial-production";
import { PriceRepositoryError } from "../price/repository";
import type { ProductionPlanPriceService } from "../price/production";
import type { ProductionPriceObservationIntake } from "../price/intake";
import type { ProductionRecommendationService } from "../recommendation/production";
import type { ProductionWorkspaceJobCenter } from "./job-center-production";
import type { ProductionWorkspaceOperations } from "./operations-production";
import type { ProductionWorkspacePortability } from "./portability-production";
import packageMetadata from "../../package.json";

export interface WorkspaceRouteResponse {
  status: number;
  payload: unknown;
}

export interface WorkspaceAgentContextRecordAuthority {
  record(input: {
    sessionId: string;
    runId: string;
    context: PlanAgentContext;
  }): Promise<{ audit: PlanAgentRunContextAudit; context: PlanAgentContext }>;
}

export function withServerDerivedPlanResolution(
  submittedContext: PlanAgentContext,
  serverSummary: Pick<WorkspacePlanResolutionSummary, "resolutions" | "inferences" | "claimScopeCount" | "claimScopes" | "price">,
): PlanAgentContext {
  const submittedEvidence = submittedContext.evidenceSummary;
  const submittedPurchase = submittedContext.purchaseSummary && typeof submittedContext.purchaseSummary === "object"
    && !Array.isArray(submittedContext.purchaseSummary) ? submittedContext.purchaseSummary as Record<string, unknown> : {};
  return {
    ...submittedContext,
    purchaseSummary: {
      ...structuredClone(submittedPurchase),
      price: serverSummary.price === null
        ? { status: "unavailable", reason: "No current server-issued plan price projection is available." }
        : structuredClone(serverSummary.price),
    },
    evidenceSummary: {
      count: submittedEvidence?.count ?? 0,
      bindings: structuredClone(submittedEvidence?.bindings ?? []),
      resolutions: structuredClone(serverSummary.resolutions),
      inferences: structuredClone(serverSummary.inferences),
      claimScopeCount: serverSummary.claimScopeCount,
      claimScopes: structuredClone(serverSummary.claimScopes),
    },
  };
}

function planPath(pathname: string): { planId: string; action?: string } | null {
  const match = pathname.match(/^\/api\/workspace\/plans\/([^/]+)(?:\/([^/]+))?$/);
  return match?.[1] ? { planId: decodeURIComponent(match[1]), ...(match[2] ? { action: match[2] } : {}) } : null;
}

interface ProposalRouteInput<TConfig extends PlanConfig> {
  proposal: PlanChangeProposal<TConfig>;
  operationIndexes?: number[];
  approvalConfirmed?: boolean;
  approvedBy?: string;
  confirmedRequirementFieldIds?: string[];
}

function proposalRouteInput<TConfig extends PlanConfig>(body: unknown, action: "validate" | "apply"): ProposalRouteInput<TConfig> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PlanProposalError("invalid_request", "Proposal request body must be an object");
  const input = body as Record<string, unknown>;
  const allowed = action === "validate"
    ? new Set(["proposal", "operationIndexes"])
    : new Set(["proposal", "operationIndexes", "approvalConfirmed", "approvedBy", "confirmedRequirementFieldIds"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new PlanProposalError("invalid_request", "Proposal request contains unknown fields");
  if (!input.proposal || typeof input.proposal !== "object" || Array.isArray(input.proposal)) throw new PlanProposalError("invalid_request", "proposal is required");
  if (input.operationIndexes !== undefined && (!Array.isArray(input.operationIndexes)
    || input.operationIndexes.some((index) => !Number.isSafeInteger(index)))) throw new PlanProposalError("invalid_request", "operationIndexes must be an integer array");
  if (action === "apply") {
    if (input.approvalConfirmed !== undefined && typeof input.approvalConfirmed !== "boolean") throw new PlanProposalError("invalid_request", "approvalConfirmed must be boolean");
    if (input.approvedBy !== undefined && typeof input.approvedBy !== "string") throw new PlanProposalError("invalid_request", "approvedBy must be a string");
    if (input.confirmedRequirementFieldIds !== undefined && (!Array.isArray(input.confirmedRequirementFieldIds)
      || input.confirmedRequirementFieldIds.some((id) => typeof id !== "string"))) throw new PlanProposalError("invalid_request", "confirmedRequirementFieldIds must be a string array");
  }
  return input as unknown as ProposalRouteInput<TConfig>;
}

export async function handleWorkspaceRoute<TConfig extends PlanConfig = PlanConfig>(method: string | undefined, pathname: string, body: unknown, repository: PlanRepository<TConfig>, options: {
  proposalService?: PlanProposalService<TConfig>;
  agentContextAuditStore?: PlanAgentContextAuditStore;
  evaluationPipeline?: AuthoritativeEvaluationSnapshotPipeline;
  factUpdateNoticeService?: FactUpdateNoticeService;
  evidenceJobs?: EvidenceJobRouteRuntime;
  evidenceJobsEnabled?: boolean;
  factGraphEnabled?: boolean;
  planResolutionSummary?: WorkspacePlanResolutionSummaryAuthority;
  agentContextAuthority?: WorkspaceAgentContextRecordAuthority;
  wholeBuildSolver?: WholeBuildSolverRouteRuntime;
  wholeBuildSolverEnabled?: boolean;
  scenarioWhatIf?: ScenarioWhatIfRouteRuntime;
  scenarioWhatIfEnabled?: boolean;
  systemExecution?: ProductionSystemExecutionRuntime;
  spatialScene?: WorkspaceSpatialSceneAuthority;
  spatialRoutingEnabled?: boolean;
  topologyV3Enabled?: boolean;
  systemProfilesEnabled?: boolean;
  userObservationsEnabled?: boolean;
  buildExecutionV3Enabled?: boolean;
  storageLayoutEnabled?: boolean;
  planPrices?: Pick<ProductionPlanPriceService, "forPlan" | "createTarget" | "reviseTarget">;
  priceObservationIntake?: Pick<ProductionPriceObservationIntake, "ingest">;
  priceHistoryEnabled?: boolean;
  priceTargetsEnabled?: boolean;
  recommendations?: Pick<ProductionRecommendationService, "generate" | "view">;
  recommendationsEnabled?: boolean;
  jobCenter?: Pick<ProductionWorkspaceJobCenter, "list" | "cancel" | "resume">;
  jobCenterEnabled?: boolean;
  operations?: Pick<ProductionWorkspaceOperations,
    "doctor" | "listBackups" | "createFullBackup" | "createDiagnostic" | "prepareRepair" | "applyRepair"
  >;
  backupRestoreEnabled?: boolean;
  doctorEnabled?: boolean;
  portability?: Pick<ProductionWorkspacePortability, "createExport" | "applyImport">;
  portabilityEnabled?: boolean;
} = {}): Promise<WorkspaceRouteResponse> {
  try {
    if (method === "GET" && pathname === "/api/workspace/health") {
      return { status: 200, payload: { ok: true, service: "build-sim-workspace", version: packageMetadata.version } };
    }
    if (method === "GET" && pathname === "/api/workspace/capabilities") {
      return {
        status: 200,
        payload: {
          schemaVersion: "workspace-capabilities-v1",
          topologyV3Enabled: options.topologyV3Enabled === true,
          systemProfilesEnabled: options.systemProfilesEnabled === true,
          userObservationsEnabled: options.userObservationsEnabled === true,
          buildExecutionV3Enabled: options.buildExecutionV3Enabled === true,
          storageLayoutEnabled: options.storageLayoutEnabled === true,
          priceHistoryEnabled: options.priceHistoryEnabled === true,
          priceTargetsEnabled: options.priceTargetsEnabled === true,
          recommendationsEnabled: options.recommendationsEnabled === true,
          wholeBuildSolverEnabled: options.wholeBuildSolverEnabled === true,
          scenarioWhatIfEnabled: options.scenarioWhatIfEnabled === true,
          jobCenterEnabled: options.jobCenterEnabled === true,
          backupRestoreEnabled: options.backupRestoreEnabled === true,
          doctorEnabled: options.doctorEnabled === true,
          portabilityEnabled: options.portabilityEnabled === true,
        },
      };
    }
    if (pathname === "/api/workspace/portability/exports") {
      if (!options.portabilityEnabled) return { status: 404, payload: { error: "portability_disabled" } };
      if (!options.portability) return { status: 503, payload: { error: "portability_unavailable" } };
      if (method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };
      return { status: 201, payload: await options.portability.createExport(body) };
    }
    if (pathname === "/api/workspace/portability/imports/apply") {
      if (!options.portabilityEnabled) return { status: 404, payload: { error: "portability_disabled" } };
      if (!options.portability) return { status: 503, payload: { error: "portability_unavailable" } };
      if (method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };
      return { status: 200, payload: await options.portability.applyImport(body) };
    }
    if (pathname === "/api/workspace/doctor") {
      if (!options.doctorEnabled) return { status: 404, payload: { error: "doctor_disabled" } };
      if (!options.operations) return { status: 503, payload: { error: "doctor_unavailable" } };
      return method === "GET" ? { status: 200, payload: await options.operations.doctor() }
        : { status: 405, payload: { error: "method_not_allowed" } };
    }
    if (pathname === "/api/workspace/diagnostics") {
      if (!options.doctorEnabled) return { status: 404, payload: { error: "doctor_disabled" } };
      if (!options.operations) return { status: 503, payload: { error: "doctor_unavailable" } };
      return method === "POST" ? { status: 201, payload: await options.operations.createDiagnostic(body) }
        : { status: 405, payload: { error: "method_not_allowed" } };
    }
    if (pathname === "/api/workspace/doctor/repairs/preview" || pathname === "/api/workspace/doctor/repairs/apply") {
      if (!options.doctorEnabled || !options.backupRestoreEnabled) return { status: 404, payload: { error: "doctor_repair_disabled" } };
      if (!options.operations) return { status: 503, payload: { error: "doctor_repair_unavailable" } };
      if (method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };
      return pathname.endsWith("/preview")
        ? { status: 201, payload: await options.operations.prepareRepair(body) }
        : { status: 200, payload: await options.operations.applyRepair(body) };
    }
    if (pathname === "/api/workspace/backups") {
      if (!options.backupRestoreEnabled) return { status: 404, payload: { error: "backup_restore_disabled" } };
      if (!options.operations) return { status: 503, payload: { error: "backup_restore_unavailable" } };
      if (method === "GET") return { status: 200, payload: { backups: await options.operations.listBackups() } };
      if (method === "POST") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2
          || typeof (body as { password?: unknown }).password !== "string"
          || new TextEncoder().encode((body as { password: string }).password).byteLength < 12
          || (body as { confirmation?: unknown }).confirmation !== true) {
          return { status: 400, payload: { error: "invalid_request", message: "backup password and explicit confirmation are required" } };
        }
        return { status: 201, payload: await options.operations.createFullBackup(body) };
      }
      return { status: 405, payload: { error: "method_not_allowed" } };
    }
    const jobCenterMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/jobs(?:\/([^/]+)\/(cancel|resume))?$/);
    if (jobCenterMatch?.[1]) {
      if (!options.jobCenterEnabled) return { status: 404, payload: { error: "job_center_disabled" } };
      if (!options.jobCenter) return { status: 503, payload: { error: "job_center_unavailable" } };
      const planId = decodeURIComponent(jobCenterMatch[1]);
      const jobId = jobCenterMatch[2] ? decodeURIComponent(jobCenterMatch[2]) : null;
      const action = jobCenterMatch[3] as "cancel" | "resume" | undefined;
      if (method === "GET" && !jobId) return { status: 200, payload: { jobs: await options.jobCenter.list(planId) } };
      if (method === "POST" && jobId && action) {
        const input = body as { expectedRevision?: unknown };
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
          || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) {
          return { status: 400, payload: { error: "invalid_request", message: "expectedRevision is required" } };
        }
        const expectedRevision = Number(input.expectedRevision);
        return { status: 200, payload: action === "cancel"
          ? await options.jobCenter.cancel(planId, jobId, expectedRevision)
          : await options.jobCenter.resume(planId, jobId, expectedRevision) };
      }
      return { status: 405, payload: { error: "method_not_allowed" } };
    }
    const priceViewMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/prices$/);
    const priceObservationMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/price-observations$/);
    const priceTargetsMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/price-targets(?:\/([^/]+))?$/);
    if (priceViewMatch?.[1] || priceObservationMatch?.[1] || priceTargetsMatch?.[1]) {
      if (!options.priceHistoryEnabled) return { status: 404, payload: { error: "price_history_disabled" } };
      if (!options.planPrices) return { status: 503, payload: { error: "plan_price_authority_unavailable" } };
      const planId = decodeURIComponent((priceViewMatch?.[1] ?? priceObservationMatch?.[1] ?? priceTargetsMatch?.[1])!);
      try {
        if (priceViewMatch) return method === "GET"
          ? { status: 200, payload: await options.planPrices.forPlan(planId) }
          : { status: 405, payload: { error: "method_not_allowed" } };
        if (priceObservationMatch) {
          if (method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };
          if (!options.priceObservationIntake) return { status: 503, payload: { error: "price_observation_intake_unavailable" } };
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "price observation request must be an object" } };
          }
          const value = body as Record<string, unknown>;
          const fields = ["instanceId", "listingCaptureId", "variantLabel"];
          if (Object.keys(value).length !== fields.length || fields.some((field) => typeof value[field] !== "string")) {
            return { status: 400, payload: { error: "invalid_request", message: "price observation request fields are invalid" } };
          }
          return { status: 201, payload: await options.priceObservationIntake.ingest({
            planId,
            instanceId: value.instanceId as string,
            listingCaptureId: value.listingCaptureId as string,
            variantLabel: value.variantLabel as string,
          }) };
        }
        if (!options.priceTargetsEnabled) return { status: 404, payload: { error: "price_targets_disabled" } };
        if (method === "GET" && !priceTargetsMatch?.[2]) {
          const view = await options.planPrices.forPlan(planId);
          return { status: 200, payload: { priceSnapshotHash: view.priceSnapshotHash, targets: view.components.flatMap(({ targets }) => targets) } };
        }
        if (method === "POST" && !priceTargetsMatch?.[2]) {
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("price target body must be an object");
          const value = body as Record<string, unknown>;
          const allowed = ["instanceId", "targetTotalCny", "sellerTierMinimum", "requireMainlandWarranty", "expiresAt", "enabled"];
          if (Object.keys(value).some((key) => !allowed.includes(key)) || typeof value.instanceId !== "string" || !value.instanceId
            || typeof value.targetTotalCny !== "number" || !Number.isFinite(value.targetTotalCny)) throw new TypeError("price target fields are invalid");
          return { status: 201, payload: await options.planPrices.createTarget(planId, value as unknown as Parameters<ProductionPlanPriceService["createTarget"]>[1]) };
        }
        if (method === "PATCH" && priceTargetsMatch?.[2]) {
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("price target edit body must be an object");
          const value = body as Record<string, unknown>;
          const allowed = ["expectedRevision", "expectedRecordHash", "expectedTargetRevisionHash", "targetTotalCny", "sellerTierMinimum", "requireMainlandWarranty", "expiresAt", "enabled"];
          if (Object.keys(value).some((key) => !allowed.includes(key)) || !Number.isSafeInteger(value.expectedRevision)
            || typeof value.expectedRecordHash !== "string" || typeof value.expectedTargetRevisionHash !== "string") throw new TypeError("price target edit guards are invalid");
          return { status: 200, payload: await options.planPrices.reviseTarget(planId, {
            targetId: decodeURIComponent(priceTargetsMatch[2]),
            ...value,
          } as unknown as Parameters<ProductionPlanPriceService["reviseTarget"]>[1]) };
        }
        return { status: 405, payload: { error: "method_not_allowed" } };
      } catch (error) {
        if (error instanceof PriceRepositoryError) {
          const status = error.code === "not_found" ? 404 : error.code === "conflict" || error.code === "fenced" ? 409 : error.code === "invalid_input" ? 400 : 503;
          return { status, payload: { error: `price_${error.code}`, message: error.message } };
        }
        if (error instanceof TypeError) return { status: 400, payload: { error: "invalid_request", message: error.message } };
        throw error;
      }
    }
    const spatialSceneMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/versions\/([^/]+)\/spatial-scene$/);
    if (spatialSceneMatch?.[1]) {
      if (method !== "GET") return { status: 405, payload: { error: "method_not_allowed" } };
      if (!options.topologyV3Enabled) return { status: 404, payload: { error: "topology_v3_disabled" } };
      if (!options.spatialRoutingEnabled) return { status: 404, payload: { error: "spatial_routing_disabled" } };
      if (!options.spatialScene) return { status: 503, payload: { error: "spatial_scene_unavailable" } };
      try {
        return {
          status: 200,
          payload: await options.spatialScene.get(
            decodeURIComponent(spatialSceneMatch[1]),
            decodeURIComponent(spatialSceneMatch[2]!),
          ),
        };
      } catch (error) {
        if (error instanceof SpatialProductionError) {
          return {
            status: error.code === "not_found" ? 404 : error.code === "not_ready" ? 409 : 503,
            payload: { error: error.code, message: error.message },
          };
        }
        throw error;
      }
    }
    const procedureMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/versions\/([^/]+)\/system-procedure$/);
    const executionCollectionMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/execution-sessions$/);
    const executionItemMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/execution-sessions\/([^/]+)$/);
    const executionRevalidateMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/execution-sessions\/([^/]+)\/revalidate$/);
    const executionDestructiveMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/execution-sessions\/([^/]+)\/destructive-actions\/([^/]+)\/confirm$/);
    if (procedureMatch?.[1] || executionCollectionMatch?.[1] || executionItemMatch?.[1] || executionRevalidateMatch?.[1] || executionDestructiveMatch?.[1]) {
      if (!options.systemProfilesEnabled) return { status: 404, payload: { error: "system_profiles_disabled" } };
      if (!options.buildExecutionV3Enabled) return { status: 404, payload: { error: "build_execution_v3_disabled" } };
      if (!options.systemExecution) return { status: 503, payload: { error: "system_execution_unavailable" } };
      const planId = decodeURIComponent((procedureMatch?.[1] ?? executionCollectionMatch?.[1] ?? executionItemMatch?.[1] ?? executionRevalidateMatch?.[1] ?? executionDestructiveMatch?.[1])!);
      try {
        if (procedureMatch?.[2]) {
          const planVersionId = decodeURIComponent(procedureMatch[2]);
          if (method === "GET") return { status: 200, payload: await options.systemExecution.preview(planId, planVersionId) };
          if (method === "POST") {
            if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length !== 0) {
              return { status: 400, payload: { error: "invalid_request", message: "execution start body must be empty" } };
            }
            return { status: 201, payload: await options.systemExecution.start(planId, planVersionId) };
          }
          return { status: 405, payload: { error: "method_not_allowed" } };
        }
        if (executionCollectionMatch) {
          return method === "GET" ? { status: 200, payload: { sessions: await options.systemExecution.list(planId) } }
            : { status: 405, payload: { error: "method_not_allowed" } };
        }
        if (executionRevalidateMatch) {
          if (method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "execution revalidation body must be an object" } };
          }
          const value = body as Record<string, unknown>;
          if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["againstPlanVersionId", "expectedHash", "expectedRevision"])) {
            return { status: 400, payload: { error: "invalid_request", message: "execution revalidation fields are invalid" } };
          }
          return { status: 200, payload: await options.systemExecution.revalidate({
            planId,
            executionSessionId: decodeURIComponent(executionRevalidateMatch[2]!),
            againstPlanVersionId: value.againstPlanVersionId as string,
            expectedRevision: value.expectedRevision as number,
            expectedHash: value.expectedHash as string,
          }) };
        }
        if (executionDestructiveMatch) {
          if (method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "destructive confirmation body must be an object" } };
          }
          const value = body as Record<string, unknown>;
          const fields = Object.keys(value).sort();
          if (JSON.stringify(fields) !== JSON.stringify(["confirmed", "expectedHash", "expectedRevision"])
            || value.confirmed !== true) {
            return { status: 400, payload: { error: "invalid_request", message: "destructive confirmation fields are invalid" } };
          }
          return { status: 200, payload: await options.systemExecution.confirmDestructiveAction({
            planId,
            executionSessionId: decodeURIComponent(executionDestructiveMatch[2]!),
            stepId: decodeURIComponent(executionDestructiveMatch[3]!),
            expectedRevision: value.expectedRevision as number,
            expectedHash: value.expectedHash as string,
          }) };
        }
        const executionSessionId = decodeURIComponent(executionItemMatch![2]!);
        if (method === "GET") return { status: 200, payload: await options.systemExecution.get(planId, executionSessionId) };
        if (method === "PATCH") {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "execution step body must be an object" } };
          }
          const value = body as Record<string, unknown>;
          const required = ["expectedRevision", "expectedHash", "stepId", "result"];
          if (!required.every((field) => Object.hasOwn(value, field))
            || Object.keys(value).some((field) => ![...required, "note", "observationIds"].includes(field))) {
            return { status: 400, payload: { error: "invalid_request", message: "execution step fields are invalid" } };
          }
          return { status: 200, payload: await options.systemExecution.recordStep({
            planId,
            executionSessionId,
            ...structuredClone(value),
          } as Parameters<ProductionSystemExecutionRuntime["recordStep"]>[0]) };
        }
        return { status: 405, payload: { error: "method_not_allowed" } };
      } catch (error) {
        if (error instanceof SystemExecutionProductionError) {
          const status = error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400
            : error.code === "conflict" || error.code === "blocked" ? 409 : 503;
          return { status, payload: { error: `system_execution_${error.code}`, message: error.message } };
        }
        return { status: 503, payload: {
          error: "system_execution_failed",
          message: error instanceof Error ? error.message : "system execution failed",
        } };
      }
    }
    const scenarioFamilyMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/scenario-families$/);
    const scenarioMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/scenarios(?:\/([^/]+))?(?:\/(evaluate|result|proposal))?$/);
    if (scenarioFamilyMatch?.[1] || scenarioMatch?.[1]) {
      if (!options.scenarioWhatIfEnabled) return { status: 404, payload: { error: "scenario_what_if_disabled" } };
      if (!options.scenarioWhatIf) return { status: 503, payload: { error: "scenario_what_if_unavailable" } };
      const planId = decodeURIComponent((scenarioFamilyMatch?.[1] ?? scenarioMatch?.[1])!);
      try {
        if (scenarioFamilyMatch) {
          if (method !== "POST") return { status: 405, payload: { error: "method_not_allowed" } };
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "scenario family request body must be an object" } };
          }
          const fields = Object.keys(body as Record<string, unknown>).sort();
          if (JSON.stringify(fields) !== JSON.stringify(["basePlanVersionId", "familyId", "name"])) {
            return { status: 400, payload: { error: "invalid_request", message: "scenario family request fields are invalid" } };
          }
          return { status: 201, payload: await options.scenarioWhatIf.createFamily({
            ...structuredClone(body as Record<string, unknown>),
            planId,
          }) };
        }
        const scenarioId = scenarioMatch?.[2] ? decodeURIComponent(scenarioMatch[2]) : undefined;
        const action = scenarioMatch?.[3];
        if (method === "POST" && !scenarioId && !action) {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "scenario request body must be an object" } };
          }
          const fields = Object.keys(body as Record<string, unknown>).sort();
          const required = ["familyId", "patch", "scenarioId"];
          if (!required.every((field) => fields.includes(field))
            || fields.some((field) => ![...required, "simulationInputPatch"].includes(field))) {
            return { status: 400, payload: { error: "invalid_request", message: "scenario request fields are invalid" } };
          }
          return { status: 201, payload: await options.scenarioWhatIf.createBranch({
            ...structuredClone(body as Record<string, unknown>),
            planId,
          }) };
        }
        if (method === "GET" && scenarioId && !action) {
          return { status: 200, payload: await options.scenarioWhatIf.getScenario(planId, scenarioId) };
        }
        if (method === "POST" && scenarioId && action === "evaluate") {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body as Record<string, unknown>).length !== 1
            || typeof (body as { refreshSnapshots?: unknown }).refreshSnapshots !== "boolean") {
            return { status: 400, payload: { error: "invalid_request", message: "what-if evaluation requires exactly refreshSnapshots" } };
          }
          return { status: 200, payload: await options.scenarioWhatIf.evaluate({
            planId,
            scenarioId,
            refreshSnapshots: (body as { refreshSnapshots: boolean }).refreshSnapshots,
          }) };
        }
        if (method === "GET" && scenarioId && action === "result") {
          const scenario = await options.scenarioWhatIf.getScenario(planId, scenarioId);
          return scenario.result ? { status: 200, payload: scenario.result }
            : { status: 404, payload: { error: "scenario_result_not_found" } };
        }
        if (method === "POST" && scenarioId && action === "proposal") {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body as Record<string, unknown>).length !== 0) {
            return { status: 400, payload: { error: "invalid_request", message: "scenario proposal request body must be empty" } };
          }
          return { status: 200, payload: await options.scenarioWhatIf.proposal(planId, scenarioId) };
        }
        return { status: 405, payload: { error: "method_not_allowed" } };
      } catch (error) {
        if (error instanceof ScenarioRepositoryError) {
          const status = error.code === "not_found" ? 404
            : ["conflict", "stale"].includes(error.code) ? 409
              : error.code === "invalid_input" ? 400 : 503;
          return { status, payload: { error: `scenario_${error.code}`, message: error.message } };
        }
        if (error instanceof TypeError) return { status: 400, payload: { error: "invalid_request", message: error.message } };
        return { status: 503, payload: {
          error: "scenario_what_if_failed",
          message: error instanceof Error ? error.message : "scenario what-if failed",
        } };
      }
    }
    const recommendationMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/recommendations(?:\/([^/]+))?$/);
    if (recommendationMatch?.[1]) {
      if (!options.recommendationsEnabled) return { status: 404, payload: { error: "recommendations_disabled" } };
      if (!options.recommendations) return { status: 503, payload: { error: "recommendations_unavailable" } };
      const planId = decodeURIComponent(recommendationMatch[1]);
      const jobId = recommendationMatch[2] ? decodeURIComponent(recommendationMatch[2]) : undefined;
      try {
        if (method === "POST" && !jobId) {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "recommendation request body must be an object" } };
          }
          const value = body as Record<string, unknown>;
          if (!Object.hasOwn(value, "solverJobId") || Object.keys(value).some((key) => !["solverJobId", "weights"].includes(key))) {
            return { status: 400, payload: { error: "invalid_request", message: "recommendation request fields are invalid" } };
          }
          if (typeof value.solverJobId !== "string") {
            return { status: 400, payload: { error: "invalid_request", message: "solverJobId must be a string" } };
          }
          return { status: 201, payload: await options.recommendations.generate({
            planId,
            solverJobId: value.solverJobId,
            ...(value.weights === undefined ? {} : { weights: structuredClone(value.weights) as never }),
          }) };
        }
        if (method === "GET" && jobId) return { status: 200, payload: await options.recommendations.view(planId, jobId) };
        return { status: 405, payload: { error: "method_not_allowed" } };
      } catch (error) {
        if (error instanceof TypeError) return { status: 400, payload: { error: "invalid_request", message: error.message } };
        return { status: 503, payload: { error: "recommendation_failed", message: error instanceof Error ? error.message : "recommendation failed" } };
      }
    }
    const solverMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/solver-jobs(?:\/([^/]+))?(?:\/(cancel|resume))?$/);
    if (solverMatch?.[1]) {
      if (!options.wholeBuildSolverEnabled) return { status: 404, payload: { error: "whole_build_solver_disabled" } };
      if (!options.wholeBuildSolver) return { status: 503, payload: { error: "whole_build_solver_unavailable" } };
      const planId = decodeURIComponent(solverMatch[1]);
      const jobId = solverMatch[2] ? decodeURIComponent(solverMatch[2]) : undefined;
      const action = solverMatch[3];
      try {
        if (method === "POST" && !jobId && !action) {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return { status: 400, payload: { error: "invalid_request", message: "solver request body must be an object" } };
          }
          const value = body as Record<string, unknown>;
          const fields = ["basePlanVersionId", "lockedInstanceIds", "requirementSpecId", "limits"];
          if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
            return { status: 400, payload: { error: "invalid_request", message: "solver request fields are invalid" } };
          }
          return { status: 202, payload: await options.wholeBuildSolver.enqueue({ planId, ...structuredClone(value) }) };
        }
        if (method === "GET" && jobId && !action) {
          const status = await options.wholeBuildSolver.status(jobId);
          if (status.job.planId !== planId) return { status: 404, payload: { error: "solver_job_not_found" } };
          return { status: 200, payload: status };
        }
        if (method === "POST" && jobId && (action === "cancel" || action === "resume")) {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body as Record<string, unknown>).length !== 1
            || !Number.isSafeInteger((body as { expectedRevision?: unknown }).expectedRevision)) {
            return { status: 400, payload: { error: "invalid_request", message: `${action} request must contain exactly expectedRevision` } };
          }
          const current = await options.wholeBuildSolver.status(jobId);
          if (current.job.planId !== planId) return { status: 404, payload: { error: "solver_job_not_found" } };
          const input = { jobId, expectedRevision: (body as { expectedRevision: number }).expectedRevision };
          return { status: 200, payload: action === "cancel"
            ? await options.wholeBuildSolver.cancel(input)
            : await options.wholeBuildSolver.resume(input) };
        }
        return { status: 405, payload: { error: "method_not_allowed" } };
      } catch (error) {
        if (error instanceof JobRepositoryError) {
          const status = error.code === "not_found" ? 404
            : ["conflict", "fenced", "dependency_blocked"].includes(error.code) ? 409
              : error.code === "invalid_input" ? 400 : 503;
          return { status, payload: { error: `solver_job_${error.code}`, message: error.message } };
        }
        if (error instanceof TypeError) return { status: 400, payload: { error: "invalid_request", message: error.message } };
        return { status: 503, payload: {
          error: "whole_build_solver_failed",
          message: error instanceof Error ? error.message : "whole-build solver failed",
        } };
      }
    }
    const evidenceJobMatch = pathname.match(/^\/api\/workspace\/evidence-jobs(?:\/([^/]+))?(?:\/(cancel|resume))?$/);
    if (evidenceJobMatch) {
      if (!options.evidenceJobsEnabled) return { status: 404, payload: { error: "evidence_jobs_disabled" } };
      if (!options.evidenceJobs) return { status: 503, payload: { error: "evidence_job_authority_unavailable" } };
      const pipelineId = evidenceJobMatch[1] ? decodeURIComponent(evidenceJobMatch[1]) : undefined;
      const action = evidenceJobMatch[2];
      try {
        if (method === "POST" && pipelineId === undefined && action === undefined) {
          return { status: 202, payload: await options.evidenceJobs.enqueue(body) };
        }
        if (method === "GET" && pipelineId !== undefined && action === undefined) {
          return { status: 200, payload: await options.evidenceJobs.status(pipelineId) };
        }
        if (method === "POST" && pipelineId !== undefined && (action === "cancel" || action === "resume")) {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body as Record<string, unknown>).some((key) => !["stage", "expectedRevision"].includes(key))
            || Object.keys(body as Record<string, unknown>).length !== 2
            || typeof (body as { stage?: unknown }).stage !== "string"
            || !Number.isSafeInteger((body as { expectedRevision?: unknown }).expectedRevision)) {
            return { status: 400, payload: { error: "invalid_request", message: `${action} request must contain exactly stage and expectedRevision` } };
          }
          const input = {
            pipelineId,
            stage: (body as { stage: string }).stage,
            expectedRevision: (body as { expectedRevision: number }).expectedRevision,
          };
          return { status: 200, payload: action === "cancel"
            ? await options.evidenceJobs.cancel(input)
            : await options.evidenceJobs.resume(input) };
        }
        return { status: 405, payload: { error: "method_not_allowed" } };
      } catch (error) {
        if (error instanceof JobRepositoryError) {
          const status = error.code === "not_found" ? 404
            : ["conflict", "fenced", "dependency_blocked"].includes(error.code) ? 409
              : error.code === "invalid_input" ? 400 : 503;
          return { status, payload: { error: `evidence_job_${error.code}`, message: error.message } };
        }
        if (error instanceof TypeError) return { status: 400, payload: { error: "invalid_request", message: error.message } };
        return { status: 503, payload: {
          error: "evidence_job_authority_failed",
          message: error instanceof Error ? error.message : "evidence job authority failed",
        } };
      }
    }
    if (method === "GET" && pathname === "/api/workspace/plans") return { status: 200, payload: { plans: await repository.list() } };
    if (method === "POST" && pathname === "/api/workspace/plans") return { status: 201, payload: await repository.create(body as Parameters<PlanRepository<TConfig>["create"]>[0]) };
    const evaluationMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/evaluations$/);
    if (method === "POST" && evaluationMatch?.[1]) {
      if (!options.factGraphEnabled) return { status: 404, payload: { error: "fact_graph_evaluation_disabled" } };
      if (!options.evaluationPipeline) return { status: 503, payload: { error: "evaluation_authority_unavailable" } };
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body as Record<string, unknown>).length !== 1
        || !("target" in (body as Record<string, unknown>))) {
        return { status: 400, payload: { error: "invalid_request", message: "evaluation request must contain exactly target" } };
      }
      try {
        const payload = await options.evaluationPipeline.evaluateCurrent({
          planId: decodeURIComponent(evaluationMatch[1]),
          target: (body as { target: unknown }).target,
        });
        return { status: 201, payload };
      } catch (error) {
        const message = error instanceof Error ? error.message : "authoritative evaluation failed";
        if (error instanceof TypeError) return { status: 400, payload: { error: "invalid_request", message } };
        if (/conflict|changed during evaluation|target changed/i.test(message)) {
          return { status: 409, payload: { error: "evaluation_conflict", message } };
        }
        return { status: 503, payload: { error: "evaluation_authority_failed", message } };
      }
    }
    const noticeMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/fact-update-notices(?:\/([^/]+))?(?:\/(decisions))?$/);
    if (noticeMatch?.[1]) {
      if (!options.factGraphEnabled) return { status: 404, payload: { error: "fact_graph_updates_disabled" } };
      if (!options.factUpdateNoticeService) return { status: 503, payload: { error: "fact_update_authority_unavailable" } };
      const planId = decodeURIComponent(noticeMatch[1]);
      const noticeId = noticeMatch[2] ? decodeURIComponent(noticeMatch[2]) : undefined;
      try {
        if (method === "GET" && !noticeId) {
          return { status: 200, payload: { notices: await options.factUpdateNoticeService.list(planId) } };
        }
        if (method === "GET" && noticeId && !noticeMatch[3]) {
          return { status: 200, payload: await options.factUpdateNoticeService.view(planId, noticeId) };
        }
        if (method === "POST" && noticeId && noticeMatch[3] === "decisions") {
          if (!body || typeof body !== "object" || Array.isArray(body)
            || (body as { noticeId?: unknown }).noticeId !== noticeId) {
            return { status: 400, payload: { error: "invalid_request", message: "decision noticeId must match the route authority" } };
          }
          return { status: 200, payload: await options.factUpdateNoticeService.decide(planId, body) };
        }
        return { status: 405, payload: { error: "method_not_allowed" } };
      } catch (error) {
        if (error instanceof FactUpdateNoticeServiceError) {
          const status = error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 503;
          return { status, payload: { error: `fact_update_${error.code}`, message: error.message } };
        }
        return { status: 503, payload: {
          error: "fact_update_authority_failed",
          message: error instanceof Error ? error.message : "fact update authority failed",
        } };
      }
    }
    const agentContextMatch = pathname.match(/^\/api\/workspace\/agent-context\/([^/]+)$/);
    if (method === "POST" && pathname === "/api/workspace/agent-context") {
      if (!options.agentContextAuditStore && !options.agentContextAuthority) {
        return { status: 503, payload: { error: "agent_context_audit_unavailable" } };
      }
      const input = body as { sessionId?: unknown; runId?: unknown; idempotencyKey?: unknown; context?: unknown };
      if (typeof input.sessionId !== "string" || !input.sessionId) throw new Error("sessionId is required");
      const derivedRunId = typeof input.idempotencyKey === "string"
        ? agentRunIdForIdempotency(input.sessionId, input.idempotencyKey)
        : null;
      if (derivedRunId && input.runId !== undefined && input.runId !== derivedRunId) throw new Error("Agent context run binding mismatch");
      const runId = derivedRunId ?? input.runId;
      if (typeof runId !== "string" || !runId) throw new Error("runId or idempotencyKey is required");
      if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)
        || typeof (input.context as { planId?: unknown }).planId !== "string") {
        throw new Error("Agent context planId is required");
      }
      const submittedContext = structuredClone(input.context) as PlanAgentContext;
      if (options.agentContextAuthority) {
        const recorded = await options.agentContextAuthority.record({
          sessionId: input.sessionId,
          runId,
          context: submittedContext,
        });
        return { status: 201, payload: { ...recorded.audit, context: structuredClone(recorded.context) } };
      }
      const serverSummary = options.planResolutionSummary
        ? await options.planResolutionSummary.forPlan(submittedContext.planId)
        : { resolutions: [], inferences: [], claimScopeCount: 0, claimScopes: [], price: null };
      // Browser data never gets to assert durable evidence/inference state.
      // The exact arrays below are derived from one server generation before
      // validation, context hashing and audit persistence.
      const context = withServerDerivedPlanResolution(submittedContext, serverSummary);
      const audit = await recordPlanAgentRunContext(repository as unknown as PlanRepository, options.agentContextAuditStore!, {
        sessionId: input.sessionId,
        runId,
        context,
      });
      return { status: 201, payload: { ...audit, context: structuredClone(context) } };
    }
    if (method === "GET" && agentContextMatch?.[1]) {
      if (!options.agentContextAuditStore) return { status: 503, payload: { error: "agent_context_audit_unavailable" } };
      const audit = await options.agentContextAuditStore.get(decodeURIComponent(agentContextMatch[1]));
      return audit ? { status: 200, payload: audit } : { status: 404, payload: { error: "agent_context_audit_not_found" } };
    }
    const proposalMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/proposals\/(validate|apply)$/);
    if (method === "POST" && proposalMatch?.[1] && proposalMatch[2]) {
      const planId = decodeURIComponent(proposalMatch[1]);
      const service = options.proposalService ?? new PlanProposalService(repository);
      const action = proposalMatch[2] === "validate" ? "validate" : "apply";
      const input = proposalRouteInput<TConfig>(body, action);
      if (proposalMatch[2] === "validate") return { status: 200, payload: { proposal: await service.validate(planId, input.proposal, input.operationIndexes) } };
      return { status: 200, payload: await service.apply(planId, input.proposal, input.operationIndexes, {
        confirmed: input.approvalConfirmed === true,
        approvedBy: input.approvedBy ?? "",
        ...(input.confirmedRequirementFieldIds ? { confirmedRequirementFieldIds: input.confirmedRequirementFieldIds } : {}),
      }) };
    }
    const evidenceBindingMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/evidence-bindings(?:\/([^/]+))?$/);
    if (evidenceBindingMatch?.[1]) {
      const planId = decodeURIComponent(evidenceBindingMatch[1]);
      const bindingId = evidenceBindingMatch[2] ? decodeURIComponent(evidenceBindingMatch[2]) : null;
      if (method === "GET" && !bindingId) return { status: 200, payload: { bindings: await repository.listEvidenceBindings(planId) } };
      if (method === "POST" && !bindingId) return { status: 201, payload: await repository.bindEvidence(planId, body as Parameters<PlanRepository["bindEvidence"]>[1]) };
      if (method === "DELETE" && bindingId) {
        await repository.unbindEvidence(planId, { ...(body as Omit<Parameters<PlanRepository["unbindEvidence"]>[1], "bindingId">), bindingId: bindingId as PlanEvidenceBinding["id"] });
        return { status: 204, payload: null };
      }
      return { status: 404, payload: { error: "route_not_found", route: `${method} ${pathname}` } };
    }
    const resolutionSummaryMatch = pathname.match(/^\/api\/workspace\/plans\/([^/]+)\/resolution-summary$/);
    if (method === "GET" && resolutionSummaryMatch?.[1]) {
      if (!options.planResolutionSummary) {
        return { status: 503, payload: { error: "plan_resolution_summary_authority_unavailable" } };
      }
      return { status: 200, payload: await options.planResolutionSummary.forPlan(decodeURIComponent(resolutionSummaryMatch[1])) };
    }
    const path = planPath(pathname);
    if (!path) return { status: 404, payload: { error: "route_not_found", route: `${method} ${pathname}` } };
    if (method === "GET" && !path.action) return { status: 200, payload: await repository.get(path.planId) };
    if (method === "PATCH" && !path.action) return { status: 200, payload: await repository.updateInfo(path.planId, body as Parameters<PlanRepository["updateInfo"]>[1]) };
    if (method === "PATCH" && path.action === "draft") return { status: 200, payload: await repository.updateDraft(path.planId, body as Parameters<PlanRepository<TConfig>["updateDraft"]>[1]) };
    if (method === "GET" && path.action === "versions") return { status: 200, payload: { versions: await repository.listVersions(path.planId) } };
    if (method === "POST" && path.action === "versions") return { status: 201, payload: await repository.saveVersion(path.planId, body as Parameters<PlanRepository["saveVersion"]>[1]) };
    if (method === "POST" && path.action === "duplicate") return { status: 201, payload: await repository.duplicate(path.planId, body as Parameters<PlanRepository["duplicate"]>[1]) };
    if (method === "POST" && path.action === "archive") {
      await repository.archive(path.planId);
      return { status: 204, payload: null };
    }
    if (method === "POST" && path.action === "restore") {
      await repository.restore(path.planId);
      return { status: 204, payload: null };
    }
    if (method === "DELETE" && !path.action) {
      await repository.delete(path.planId);
      return { status: 204, payload: null };
    }
    return { status: 404, payload: { error: "route_not_found", route: `${method} ${pathname}` } };
  } catch (error) {
    if (error instanceof PlanProposalError) return { status: error.status, payload: { error: error.code, message: error.message } };
    return repositoryErrorResponse(error);
  }
}

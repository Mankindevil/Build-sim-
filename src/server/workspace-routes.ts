import type { PlanAgentContext, PlanChangeProposal, PlanConfig, PlanRepository } from "../plans/contracts";
import { repositoryErrorResponse } from "../plans/file-repository";
import { PlanProposalError, PlanProposalService } from "../plans/proposals";
import { recordPlanAgentRunContext, type PlanAgentContextAuditStore } from "../plans/agent-context-audit";
import { agentRunIdForIdempotency } from "../agent/run-identity";
import type { PlanEvidenceBinding } from "../evidence/contracts";

export interface WorkspaceRouteResponse {
  status: number;
  payload: unknown;
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

export async function handleWorkspaceRoute<TConfig extends PlanConfig = PlanConfig>(method: string | undefined, pathname: string, body: unknown, repository: PlanRepository<TConfig>, options: { proposalService?: PlanProposalService<TConfig>; agentContextAuditStore?: PlanAgentContextAuditStore } = {}): Promise<WorkspaceRouteResponse> {
  try {
    if (method === "GET" && pathname === "/api/workspace/plans") return { status: 200, payload: { plans: await repository.list() } };
    if (method === "POST" && pathname === "/api/workspace/plans") return { status: 201, payload: await repository.create(body as Parameters<PlanRepository<TConfig>["create"]>[0]) };
    const agentContextMatch = pathname.match(/^\/api\/workspace\/agent-context\/([^/]+)$/);
    if (method === "POST" && pathname === "/api/workspace/agent-context") {
      if (!options.agentContextAuditStore) return { status: 503, payload: { error: "agent_context_audit_unavailable" } };
      const input = body as { sessionId?: unknown; runId?: unknown; idempotencyKey?: unknown; context?: unknown };
      if (typeof input.sessionId !== "string" || !input.sessionId) throw new Error("sessionId is required");
      const derivedRunId = typeof input.idempotencyKey === "string"
        ? agentRunIdForIdempotency(input.sessionId, input.idempotencyKey)
        : null;
      if (derivedRunId && input.runId !== undefined && input.runId !== derivedRunId) throw new Error("Agent context run binding mismatch");
      const runId = derivedRunId ?? input.runId;
      if (typeof runId !== "string" || !runId) throw new Error("runId or idempotencyKey is required");
      return { status: 201, payload: await recordPlanAgentRunContext(repository as unknown as PlanRepository, options.agentContextAuditStore, {
        sessionId: input.sessionId,
        runId,
        context: input.context as PlanAgentContext,
      }) };
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

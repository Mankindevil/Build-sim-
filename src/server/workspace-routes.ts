import type { PlanAgentContext, PlanChangeProposal, PlanRepository } from "../plans/contracts";
import { repositoryErrorResponse } from "../plans/file-repository";
import { PlanProposalError, PlanProposalService } from "../plans/proposals";
import { recordPlanAgentRunContext, type PlanAgentContextAuditStore } from "../plans/agent-context-audit";

export interface WorkspaceRouteResponse {
  status: number;
  payload: unknown;
}

function planPath(pathname: string): { planId: string; action?: string } | null {
  const match = pathname.match(/^\/api\/workspace\/plans\/([^/]+)(?:\/([^/]+))?$/);
  return match?.[1] ? { planId: decodeURIComponent(match[1]), ...(match[2] ? { action: match[2] } : {}) } : null;
}

export async function handleWorkspaceRoute(method: string | undefined, pathname: string, body: unknown, repository: PlanRepository, options: { proposalService?: PlanProposalService; agentContextAuditStore?: PlanAgentContextAuditStore } = {}): Promise<WorkspaceRouteResponse> {
  try {
    if (method === "GET" && pathname === "/api/workspace/plans") return { status: 200, payload: { plans: await repository.list() } };
    if (method === "POST" && pathname === "/api/workspace/plans") return { status: 201, payload: await repository.create(body as Parameters<PlanRepository["create"]>[0]) };
    const agentContextMatch = pathname.match(/^\/api\/workspace\/agent-context\/([^/]+)$/);
    if (method === "POST" && pathname === "/api/workspace/agent-context") {
      if (!options.agentContextAuditStore) return { status: 503, payload: { error: "agent_context_audit_unavailable" } };
      return { status: 201, payload: await recordPlanAgentRunContext(repository, options.agentContextAuditStore, body as { sessionId: string; runId: string; context: PlanAgentContext }) };
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
      const input = body as { proposal: PlanChangeProposal; operationIndexes?: number[]; approvalConfirmed?: boolean; approvedBy?: string };
      if (proposalMatch[2] === "validate") return { status: 200, payload: { proposal: await service.validate(planId, input.proposal, input.operationIndexes) } };
      return { status: 200, payload: await service.apply(planId, input.proposal, input.operationIndexes, { confirmed: input.approvalConfirmed === true, approvedBy: input.approvedBy ?? "" }) };
    }
    const path = planPath(pathname);
    if (!path) return { status: 404, payload: { error: "route_not_found", route: `${method} ${pathname}` } };
    if (method === "GET" && !path.action) return { status: 200, payload: await repository.get(path.planId) };
    if (method === "PATCH" && !path.action) return { status: 200, payload: await repository.updateInfo(path.planId, body as Parameters<PlanRepository["updateInfo"]>[1]) };
    if (method === "PATCH" && path.action === "draft") return { status: 200, payload: await repository.updateDraft(path.planId, body as Parameters<PlanRepository["updateDraft"]>[1]) };
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

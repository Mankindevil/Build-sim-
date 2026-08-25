import type { PlanRepository } from "../plans/contracts";
import { repositoryErrorResponse } from "../plans/file-repository";

export interface WorkspaceRouteResponse {
  status: number;
  payload: unknown;
}

function planPath(pathname: string): { planId: string; action?: string } | null {
  const match = pathname.match(/^\/api\/workspace\/plans\/([^/]+)(?:\/([^/]+))?$/);
  return match?.[1] ? { planId: decodeURIComponent(match[1]), ...(match[2] ? { action: match[2] } : {}) } : null;
}

export async function handleWorkspaceRoute(method: string | undefined, pathname: string, body: unknown, repository: PlanRepository): Promise<WorkspaceRouteResponse> {
  try {
    if (method === "GET" && pathname === "/api/workspace/plans") return { status: 200, payload: { plans: await repository.list() } };
    if (method === "POST" && pathname === "/api/workspace/plans") return { status: 201, payload: await repository.create(body as Parameters<PlanRepository["create"]>[0]) };
    const path = planPath(pathname);
    if (!path) return { status: 404, payload: { error: "route_not_found", route: `${method} ${pathname}` } };
    if (method === "GET" && !path.action) return { status: 200, payload: await repository.get(path.planId) };
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
    return repositoryErrorResponse(error);
  }
}


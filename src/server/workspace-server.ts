import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileEvidenceRepository } from "../evidence/repository.mjs";
import { FilePlanRepository } from "../plans/file-repository";
import type { PlanRepository } from "../plans/contracts";
import { ensureDefaultPlan } from "../plans/seed";
import { handleWorkspaceRoute } from "./workspace-routes";
import { PlanProposalService } from "../plans/proposals";
import { FilePlanAgentContextAuditStore, MemoryPlanAgentContextAuditStore, type PlanAgentContextAuditStore } from "../plans/agent-context-audit";
import { loadAuthoritativeCatalog } from "./evaluation-service";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5176;
const MAX_BODY_BYTES = 1_000_000;

export interface WorkspaceRepositoryEnvironment {
  PLAN_REPOSITORY_ROOT?: string;
  EVIDENCE_REPOSITORY_ROOT?: string;
}

export function createWorkspaceRepositories(environment: WorkspaceRepositoryEnvironment = process.env): {
  repository: FilePlanRepository;
  evidenceRepository: FileEvidenceRepository;
  planRoot: string;
  evidenceRoot: string;
} {
  const planRoot = path.resolve(environment.PLAN_REPOSITORY_ROOT ?? "runtime/plans");
  const evidenceRoot = path.resolve(environment.EVIDENCE_REPOSITORY_ROOT ?? "runtime/evidence");
  const evidenceRepository = new FileEvidenceRepository({ root: evidenceRoot });
  const repository = new FilePlanRepository({
    root: planRoot,
    getCatalog: loadAuthoritativeCatalog,
    getEvidenceDocument: (documentId) => evidenceRepository.getDocument(documentId),
    getEvidenceCapture: (captureId) => evidenceRepository.getCapture(captureId),
  });
  return { repository, evidenceRepository, planRoot, evidenceRoot };
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(status === 204 ? undefined : JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createWorkspaceServer(repository: PlanRepository, options: { agentContextAuditStore?: PlanAgentContextAuditStore } = {}): http.Server {
  const agentContextAuditStore = options.agentContextAuditStore ?? new MemoryPlanAgentContextAuditStore();
  const proposalService = new PlanProposalService(repository);
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    let body: unknown = {};
    try {
      if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") body = await readJson(request);
    } catch (error) {
      send(response, 400, { error: "invalid_request", message: error instanceof Error ? error.message : "Invalid request" });
      return;
    }
    const result = await handleWorkspaceRoute(request.method, url.pathname, body, repository, { proposalService, agentContextAuditStore });
    send(response, result.status, result.payload);
  });
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  void (async () => {
    const port = Number(process.env.WORKSPACE_SERVER_PORT ?? DEFAULT_PORT);
    const { repository, planRoot } = createWorkspaceRepositories();
    await ensureDefaultPlan(repository);
    const agentContextAuditStore = new FilePlanAgentContextAuditStore(path.join(planRoot, ".agent-context-audit"));
    createWorkspaceServer(repository, { agentContextAuditStore }).listen(port, HOST, () => {
      console.log(`Build Sim workspace server listening on http://${HOST}:${port}`);
    });
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : "Workspace server failed to start");
    process.exitCode = 1;
  });
}

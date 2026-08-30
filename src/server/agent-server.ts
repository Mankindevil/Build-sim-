import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, AgentRuntimeError } from "../agent/runtime";
import { DeepSeekProviderAdapter } from "../agent/providers/deepseek";
import { ClaudeProviderAdapter } from "../agent/providers/claude";
import { AgentToolRegistry } from "../agent/tool-registry";
import { AgentWriteApprovalAuthority } from "../agent/write-approval-authority";
import { AgentSkillLoader } from "../agent/skill-loader";
import {
  configureAuthoritativeCatalogRepository,
  evaluateBuildDocumentAuthoritatively,
  loadAuthoritativeCatalog,
  parseAuthoritativeBuildConfigDocument,
  type AuthoritativeEvaluationSnapshotPipeline,
} from "./evaluation-service";
import { createLegacyV2CaseRuntimeRegistry } from "../adapters/legacy-runtime-bootstrap";
import {
  FileRootBoundProvisionalCaseAdapterAuthority,
  createProductionProvisionalCaseAdapterActions,
} from "../adapters";
import { FileAgentSessionStore } from "./file-session-store";
import { FileAgentRunAuditStore } from "./file-audit-store";
import { loadAgentRuntimeConfig } from "./agent-env";
import {
  createBuildSimTools,
  type GovernedProgressiveEvaluationToolActions,
} from "./domain-tools";
import type { AgentSession } from "../agent/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { FileJobRepository } from "../jobs/repository";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { topologyV3Enabled } from "../config/io";
import { createProductionGovernedAgentActions } from "../attachments/production-actions";
import type { StagedAttachmentUploadRepository } from "../attachments/staged-upload-repository";
import { FileEvidenceRepository } from "../evidence/repository.mjs";
import { EvidenceClaimRepository } from "../evidence/claim-repository";
import { FactRepository } from "../facts/repository";
import { FilePlanRepository } from "../plans/file-repository";
import type { BuildConfigV3 } from "../topology/contracts";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import { loadRuntimeFlags } from "../../scripts/runtime/flags.mjs";
import { createWorkspaceRepositories } from "./workspace-server";
import { canonicalize } from "../hash";
import type { SolverApprovalPlanContext } from "./solver-service";
import { hashPlanConfig } from "../plans/canonical";
import packageMetadata from "../../package.json";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1_000_000;
const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;
const LEGACY_CASE_RUNTIME_REGISTRY = createLegacyV2CaseRuntimeRegistry();

export interface AgentRouteResponse {
  status: number;
  payload: unknown;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage, maxBodyBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

async function readBytes(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBodyBytes) throw new Error("request body too large");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("attachment upload body is empty");
  return Buffer.concat(chunks);
}

export function handleAgentRoute(method: string | undefined, pathname: string, body: unknown = {}): AgentRouteResponse {
  const route = `${method} ${pathname}`;
  if (route === "GET /api/agent/health") {
    return { status: 200, payload: { ok: true, service: "build-sim-agent", version: packageMetadata.version, authoritativeEvaluation: true } };
  }
  if (route === "POST /api/agent/evaluate") {
    const input = body as { buildConfig?: unknown };
    return { status: 200, payload: evaluateBuildDocumentAuthoritatively(input.buildConfig, undefined, {
      topologyV3Enabled: topologyV3Enabled(process.env),
      caseRuntimeRegistry: LEGACY_CASE_RUNTIME_REGISTRY,
    }) };
  }
  return { status: 404, payload: { error: "route_not_found", route } };
}

function errorStatus(error: unknown): number {
  return error instanceof AgentRuntimeError ? error.status : 400;
}

function errorPayload(error: unknown): unknown {
  return {
    error: error instanceof AgentRuntimeError ? error.code : "invalid_request",
    message: error instanceof Error ? error.message : "request failed",
  };
}

function terminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "limit_exceeded"].includes(status);
}

/** The browser only needs visible conversation text; provider reasoning stays server-side. */
export function publicAgentSession(session: AgentSession): AgentSession {
  return {
    ...session,
    messages: session.messages.map(({ reasoningContent: _reasoningContent, ...message }) => message),
  };
}

/** Pure route boundary used by the HTTP binary reader and composition tests. */
export async function stageAgentAttachmentUpload(
  input: { sessionId: string; mediaType: string; bytes: Buffer },
  runtime: AgentRuntime,
  stagedUploads: StagedAttachmentUploadRepository | undefined,
): Promise<AgentRouteResponse> {
  if (!stagedUploads) return { status: 503, payload: { error: "attachment_upload_authority_unavailable" } };
  await runtime.getSession(input.sessionId);
  const mediaType = input.mediaType.split(";", 1)[0]!.trim().toLocaleLowerCase();
  if (!["image/png", "image/jpeg", "application/pdf"].includes(mediaType)) {
    return { status: 415, payload: { error: "attachment_media_type_not_allowed" } };
  }
  return { status: 201, payload: await stagedUploads.put({ sessionId: input.sessionId, bytes: input.bytes, mediaType }) };
}

async function handleRuntimeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: AgentRuntime,
  maxBodyBytes: number,
  stagedUploads?: StagedAttachmentUploadRepository,
  maxAttachmentUploadBytes = MAX_ATTACHMENT_UPLOAD_BYTES,
): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/agent/models") {
    send(res, 200, { models: runtime.getModels() });
    return true;
  }
  if (route === "GET /api/agent/tools") {
    send(res, 200, { tools: runtime.getTools() });
    return true;
  }
  if (route === "GET /api/agent/skills") {
    send(res, 200, { skills: await runtime.getSkills() });
    return true;
  }
  if (route === "POST /api/agent/sessions") {
    const body = await readJson(req, maxBodyBytes) as { provider?: "deepseek" | "claude"; model?: string };
    send(res, 201, await runtime.createSession(body));
    return true;
  }
  const uploadMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/uploads$/);
  if (req.method === "POST" && uploadMatch?.[1]) {
    const sessionId = decodeURIComponent(uploadMatch[1]);
    const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLocaleLowerCase();
    if (!stagedUploads) { send(res, 503, { error: "attachment_upload_authority_unavailable" }); return true; }
    if (!["image/png", "image/jpeg", "application/pdf"].includes(mediaType)) {
      send(res, 415, { error: "attachment_media_type_not_allowed" });
      return true;
    }
    const bytes = await readBytes(req, maxAttachmentUploadBytes);
    const staged = await stageAgentAttachmentUpload({ sessionId, bytes, mediaType }, runtime, stagedUploads);
    send(res, staged.status, staged.payload);
    return true;
  }
  const sessionMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/);
  if (req.method === "GET" && sessionMatch?.[1]) {
    send(res, 200, publicAgentSession(await runtime.getSession(decodeURIComponent(sessionMatch[1]))));
    return true;
  }
  const messageMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/);
  if (req.method === "POST" && messageMatch?.[1]) {
    const body = await readJson(req, maxBodyBytes) as { content?: string; buildConfig?: unknown; skillId?: string; approvals?: unknown; idempotencyKey?: string };
    if (Object.prototype.hasOwnProperty.call(body, "approvals")) {
      throw new AgentRuntimeError("caller_approvals_forbidden", "Write approvals must be issued and confirmed by the Agent server", 400);
    }
    const result = await runtime.startRun(decodeURIComponent(messageMatch[1]), {
      content: body.content ?? "",
      ...(body.buildConfig !== undefined ? {
        buildConfig: parseAuthoritativeBuildConfigDocument(body.buildConfig, loadAuthoritativeCatalog(), {
          topologyV3Enabled: topologyV3Enabled(process.env),
        }),
      } : {}),
      ...(body.skillId !== undefined ? { skillId: body.skillId } : {}),
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    send(res, 202, result);
    return true;
  }
  const approvalMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/approvals\/([^/]+)\/confirm$/);
  if (req.method === "POST" && approvalMatch?.[1] && approvalMatch[2]) {
    const body = await readJson(req, maxBodyBytes) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).sort().join("\0") !== ["approvedBy", "nonce"].sort().join("\0")
      || typeof body.nonce !== "string" || typeof body.approvedBy !== "string") {
      throw new AgentRuntimeError("approval_confirmation_invalid", "Approval confirmation accepts only nonce and approvedBy", 400);
    }
    const result = await runtime.confirmPendingApproval(
      decodeURIComponent(approvalMatch[1]),
      decodeURIComponent(approvalMatch[2]),
      { nonce: body.nonce, approvedBy: body.approvedBy },
    );
    send(res, 202, result);
    return true;
  }
  const rejectionMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/approvals\/([^/]+)\/reject$/);
  if (req.method === "POST" && rejectionMatch?.[1] && rejectionMatch[2]) {
    const body = await readJson(req, maxBodyBytes) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).join("\0") !== "nonce" || typeof body.nonce !== "string") {
      throw new AgentRuntimeError("approval_rejection_invalid", "Approval rejection accepts only the pending nonce", 400);
    }
    send(res, 202, await runtime.rejectPendingApproval(
      decodeURIComponent(rejectionMatch[1]),
      decodeURIComponent(rejectionMatch[2]),
      { nonce: body.nonce },
    ));
    return true;
  }
  const runMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch?.[1]) {
    send(res, 200, await runtime.getRunState(decodeURIComponent(runMatch[1])));
    return true;
  }
  const auditMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/audit$/);
  if (req.method === "GET" && auditMatch?.[1]) {
    send(res, 200, await runtime.getRunAudit(decodeURIComponent(auditMatch[1])));
    return true;
  }
  const cancelMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch?.[1]) {
    const runId = decodeURIComponent(cancelMatch[1]);
    send(res, 202, await runtime.cancelRun(runId));
    return true;
  }
  const eventsMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch?.[1]) {
    const runId = decodeURIComponent(eventsMatch[1]);
    const headerIndex = Number(req.headers["last-event-id"] ?? -1);
    const queryIndex = Number(url.searchParams.get("after") ?? -1);
    const afterIndex = Number.isInteger(headerIndex) && headerIndex >= 0 ? headerIndex : Number.isInteger(queryIndex) ? queryIndex : -1;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 1000\n\n");
    let ended = false;
    let unsubscribe = () => {};
    const end = () => {
      if (ended) return;
      ended = true;
      unsubscribe();
      res.end();
    };
    const snapshot = await runtime.getRunState(runId);
    snapshot.events.forEach((event, index) => {
      if (index <= afterIndex || ended) return;
      res.write(`id: ${index}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    if (terminal(snapshot.status)) {
      end();
      return true;
    }
    try {
      unsubscribe = runtime.subscribe(runId, (event, index) => {
        if (ended) return;
        res.write(`id: ${index}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === "run_status" && terminal(event.status)) end();
      }, snapshot.events.length - 1);
    } catch (error) {
      if (!(error instanceof AgentRuntimeError && error.code === "run_not_found")) throw error;
      // A previous process still owns an unexpired lease. The durable status
      // endpoint remains authoritative; the browser reconnects after retry.
      end();
    }
    req.on("close", end);
    return true;
  }
  return false;
}

export function createAgentServer(options: {
  runtime?: AgentRuntime;
  maxBodyBytes?: number;
  stagedUploads?: StagedAttachmentUploadRepository;
  maxAttachmentUploadBytes?: number;
} = {}): http.Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    try {
      if (options.runtime && await handleRuntimeRoute(
        req,
        res,
        url,
        options.runtime,
        maxBodyBytes,
        options.stagedUploads,
        options.maxAttachmentUploadBytes,
      )) return;
      const body = req.method === "POST" ? await readJson(req, maxBodyBytes) : {};
      const response = handleAgentRoute(req.method, url.pathname, body);
      return send(res, response.status, response.payload);
    } catch (error) {
      return send(res, errorStatus(error), errorPayload(error));
    }
  });
}

export function createProductionProgressiveEvaluationToolActions(options: {
  repository: FilePlanRepository<BuildConfigV3>;
  pipeline: AuthoritativeEvaluationSnapshotPipeline;
  resolvePlanScope(context: import("../agent/contracts").AgentToolContext): Promise<{ planId: string; configHash: string }>;
}): GovernedProgressiveEvaluationToolActions {
  return {
    async evaluate(context) {
      const scope = await options.resolvePlanScope(context);
      const plan = await options.repository.get(scope.planId);
      const currentConfigHash = await hashPlanConfig(plan.draft.config);
      if (currentConfigHash !== scope.configHash) {
        throw new Error("Agent plan authority changed before progressive evaluation");
      }
      return options.pipeline.evaluateCurrent({
        planId: plan.id,
        target: {
          kind: "draft",
          expectedDraftRevision: plan.draftRevision,
          expectedConfigHash: currentConfigHash,
        },
      });
    },
  };
}

const isMain = process.argv[1] !== undefined
  && path.basename(process.argv[1]) === "agent-server.js"
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  void (async () => {
    const config = await loadAgentRuntimeConfig();
    const runtimeFlags = await loadRuntimeFlags(process.env);
    const coordinator = new RuntimeCoordinator({ root: config.runtimeRoot });
    await coordinator.initialize();
    const jobRepository = new FileJobRepository({ coordinator, leaseDurationMs: 180_000 });
    const artifactRepository = new FileArtifactRepository({ coordinator });
    const writeApprovalAuthority = new AgentWriteApprovalAuthority(artifactRepository, { jobs: jobRepository });
    configureAuthoritativeCatalogRepository({ runtimeRoot: config.runtimeRoot, generationAware: true, priceRuntimeRoot: config.priceRuntimeRoot });
    const governedActions = createProductionGovernedAgentActions({
      coordinator,
      runtimeRoot: config.runtimeRoot,
      topologyV3Enabled: topologyV3Enabled(process.env),
      environment: process.env,
    });
    await governedActions.initializeInference();
    const governedWorkspace = runtimeFlags.progressiveEvaluationEnabled || runtimeFlags.wholeBuildSolverEnabled
      ? createWorkspaceRepositories<BuildConfigV3>(process.env)
      : null;
    const wholeBuildSolver = governedWorkspace?.wholeBuildSolver;
    if (runtimeFlags.wholeBuildSolverEnabled && !wholeBuildSolver) {
      throw new Error("whole-build solver Agent actions require the production workspace solver composition");
    }
    const progressiveEvaluationPipeline = runtimeFlags.progressiveEvaluationEnabled
      ? governedWorkspace?.evaluationPipeline
      : undefined;
    if (runtimeFlags.progressiveEvaluationEnabled && !progressiveEvaluationPipeline) {
      throw new Error("progressive Agent evaluation requires the production workspace evaluation composition");
    }
    const provisionalAuthority = runtimeFlags.topologyV3Enabled && runtimeFlags.genericAdaptersEnabled ? (() => {
      const evidence = new FileEvidenceRepository({ coordinator, runtimeRoot: config.runtimeRoot });
      const claims = new EvidenceClaimRepository({ coordinator, runtimeRoot: config.runtimeRoot, evidence });
      const facts = new FactRepository({ coordinator, runtimeRoot: config.runtimeRoot, evidenceClaims: claims });
      const plans = new FilePlanRepository<BuildConfigV3>({
        coordinator,
        topologyV3Enabled: true,
        getCatalogAtRoot: (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }),
        getEvidenceDocumentAtRoot: (activeRoot, documentId) => evidence.getDocumentAtRoot(activeRoot, documentId),
        getEvidenceCaptureAtRoot: (activeRoot, captureId) => evidence.getCaptureAtRoot(activeRoot, captureId),
      });
      return new FileRootBoundProvisionalCaseAdapterAuthority({
        plans,
        facts,
        claims,
        evidence,
        jobs: jobRepository,
        catalogAtRoot: (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }),
      });
    })() : null;
    const toolRegistry = new AgentToolRegistry(createBuildSimTools({
      priceServiceUrl: config.priceServiceUrl,
      // Keep inspection/archive/observation writes unreachable while the
      // independent user-observation rollout is disabled. Tool schemas remain
      // stable for Skill validation, but dispatch has no write authority.
      ...(runtimeFlags.userObservationsEnabled ? { attachmentActions: governedActions.attachmentActions } : {}),
      evidenceFactActions: governedActions.evidenceFactActions,
      ...(governedActions.inferenceActions ? { inferenceActions: governedActions.inferenceActions } : {}),
      ...(provisionalAuthority ? {
        provisionalCaseAdapterActions: createProductionProvisionalCaseAdapterActions({
          coordinator,
          authority: provisionalAuthority,
        }),
      } : {}),
      provisionalCaseAdapterToolEnabled: provisionalAuthority !== null,
      ...(progressiveEvaluationPipeline && governedWorkspace ? {
        progressiveEvaluationActions: createProductionProgressiveEvaluationToolActions({
          repository: governedWorkspace.repository,
          pipeline: progressiveEvaluationPipeline,
          resolvePlanScope: governedActions.resolvePlanScope,
        }),
      } : {}),
      ...(wholeBuildSolver ? {
        wholeBuildSolverActions: {
          async getJob(input: { jobId: string }, context: import("../agent/contracts").AgentToolContext) {
            const scope = await governedActions.resolvePlanScope(context);
            const status = await wholeBuildSolver.status(input.jobId);
            if (status.job.planId !== scope.planId) throw new Error("solver job does not belong to the active plan");
            const approvalContexts = status.job.status === "waiting_user" && status.result
              ? await Promise.all(status.result.result.candidates.map(async ({ candidateId }) => (
                (await wholeBuildSolver.service.approvalPlanContext(status.job.jobId, candidateId)).context
              )))
              : [];
            return { ...status, approvalContexts };
          },
          async acceptCandidate(input: SolverApprovalPlanContext, context: import("../agent/contracts").AgentToolContext) {
            const scope = await governedActions.resolvePlanScope(context);
            const status = await wholeBuildSolver.status(input.jobId);
            if (status.job.planId !== scope.planId) throw new Error("solver job does not belong to the active plan");
            const current = await wholeBuildSolver.service.approvalPlanContext(input.jobId, input.candidateId);
            if (canonicalize(current.context) !== canonicalize(input)) {
              throw new Error("solver candidate approval context changed before execution");
            }
            if (!context.writeApprovalProof) throw new Error("server-issued solver write approval proof is required");
            return wholeBuildSolver.service.approve({
              jobId: input.jobId,
              expectedRevision: input.expectedRevision,
              candidateId: input.candidateId,
              approvalProof: context.writeApprovalProof,
            });
          },
        },
      } : {}),
    }));
    const adapters = [
      new DeepSeekProviderAdapter(config.deepseek),
      ...(config.claude.enabled ? [new ClaudeProviderAdapter(config.claude)] : []),
    ];
    const runtime = new AgentRuntime(
      adapters,
      new FileAgentSessionStore(config.sessionRootConfigured ? config.sessionRoot : { coordinator }),
      {
        maxTokens: config.deepseek.maxTokens,
        temperature: config.deepseek.temperature,
        providerSettings: {
          deepseek: { maxTokens: config.deepseek.maxTokens, temperature: config.deepseek.temperature },
          claude: { maxTokens: config.claude.maxTokens, temperature: config.claude.temperature },
        },
        toolRegistry,
        skillLoader: new AgentSkillLoader(config.skillsRoot, toolRegistry),
        auditStore: new FileAgentRunAuditStore(config.auditRootConfigured ? config.auditRoot : { coordinator }),
        writeApprovalAuthority,
        limits: config.limits,
        maxMessageChars: config.maxMessageChars,
        durableJobs: {
          repository: jobRepository,
          artifacts: artifactRepository,
        },
      },
    );
    await runtime.initializeDurableRuns();
    createAgentServer({ runtime, maxBodyBytes: config.requestBodyMaxBytes, stagedUploads: governedActions.stagedUploads }).listen(config.port, HOST, () => {
      console.log(`Build Sim Agent server listening on http://${HOST}:${config.port} (${config.enabled ? "enabled" : "disabled"})`);
    });
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : "Agent server failed to start");
    process.exitCode = 1;
  });
}

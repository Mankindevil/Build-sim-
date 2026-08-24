import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, AgentRuntimeError } from "../agent/runtime";
import { DeepSeekProviderAdapter } from "../agent/providers/deepseek";
import { AgentToolRegistry } from "../agent/tool-registry";
import { AgentSkillLoader } from "../agent/skill-loader";
import { evaluateBuildAuthoritatively, parseAuthoritativeBuildConfig } from "./evaluation-service";
import { FileAgentSessionStore } from "./file-session-store";
import { FileAgentRunAuditStore } from "./file-audit-store";
import { loadAgentRuntimeConfig } from "./agent-env";
import { createBuildSimTools } from "./domain-tools";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5175;
const MAX_BODY_BYTES = 1_000_000;

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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

export function handleAgentRoute(method: string | undefined, pathname: string, body: unknown = {}): AgentRouteResponse {
  const route = `${method} ${pathname}`;
  if (route === "GET /api/agent/health") {
    return { status: 200, payload: { ok: true, service: "build-sim-agent", authoritativeEvaluation: true } };
  }
  if (route === "POST /api/agent/evaluate") {
    const input = body as { buildConfig?: unknown };
    return { status: 200, payload: evaluateBuildAuthoritatively(input.buildConfig) };
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

async function handleRuntimeRoute(req: IncomingMessage, res: ServerResponse, url: URL, runtime: AgentRuntime): Promise<boolean> {
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
    const body = await readJson(req) as { provider?: "deepseek" | "claude"; model?: string };
    send(res, 201, await runtime.createSession(body));
    return true;
  }
  const sessionMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)$/);
  if (req.method === "GET" && sessionMatch?.[1]) {
    send(res, 200, await runtime.getSession(decodeURIComponent(sessionMatch[1])));
    return true;
  }
  const messageMatch = url.pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/);
  if (req.method === "POST" && messageMatch?.[1]) {
    const body = await readJson(req) as { content?: string; buildConfig?: unknown; skillId?: string };
    const result = await runtime.startRun(decodeURIComponent(messageMatch[1]), {
      content: body.content ?? "",
      ...(body.buildConfig !== undefined ? { buildConfig: parseAuthoritativeBuildConfig(body.buildConfig) } : {}),
      ...(body.skillId !== undefined ? { skillId: body.skillId } : {}),
    });
    send(res, 202, result);
    return true;
  }
  const runMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch?.[1]) {
    send(res, 200, runtime.getRun(decodeURIComponent(runMatch[1])));
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
    runtime.cancelRun(runId);
    send(res, 202, { runId, status: runtime.getRun(runId).status });
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
    const snapshot = runtime.getRun(runId);
    snapshot.events.forEach((event, index) => {
      if (index <= afterIndex || ended) return;
      res.write(`id: ${index}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    if (terminal(snapshot.status)) {
      end();
      return true;
    }
    unsubscribe = runtime.subscribe(runId, (event, index) => {
      if (ended) return;
      res.write(`id: ${index}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "run_status" && terminal(event.status)) end();
    }, snapshot.events.length - 1);
    req.on("close", end);
    return true;
  }
  return false;
}

export function createAgentServer(options: { runtime?: AgentRuntime } = {}): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    try {
      if (options.runtime && await handleRuntimeRoute(req, res, url, options.runtime)) return;
      const body = req.method === "POST" ? await readJson(req) : {};
      const response = handleAgentRoute(req.method, url.pathname, body);
      return send(res, response.status, response.payload);
    } catch (error) {
      return send(res, errorStatus(error), errorPayload(error));
    }
  });
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  void (async () => {
    const config = await loadAgentRuntimeConfig();
    const toolRegistry = new AgentToolRegistry(createBuildSimTools());
    const runtime = new AgentRuntime(
      [new DeepSeekProviderAdapter(config.deepseek)],
      new FileAgentSessionStore(),
      {
        maxTokens: config.deepseek.maxTokens,
        temperature: config.deepseek.temperature,
        toolRegistry,
        skillLoader: new AgentSkillLoader(path.resolve("skills"), toolRegistry),
        auditStore: new FileAgentRunAuditStore(),
      },
    );
    const port = config.port ?? DEFAULT_PORT;
    createAgentServer({ runtime }).listen(port, HOST, () => {
      console.log(`Build Sim Agent server listening on http://${HOST}:${port} (${config.enabled ? "enabled" : "disabled"})`);
    });
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : "Agent server failed to start");
    process.exitCode = 1;
  });
}

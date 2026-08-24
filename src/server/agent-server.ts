import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { evaluateBuildAuthoritatively } from "./evaluation-service";

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

export function createAgentServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const response = handleAgentRoute(req.method, url.pathname, body);
      return send(res, response.status, response.payload);
    } catch (error) {
      return send(res, 400, { error: "invalid_request", message: error instanceof Error ? error.message : "request failed" });
    }
  });
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.AGENT_SERVER_PORT ?? DEFAULT_PORT);
  createAgentServer().listen(port, HOST, () => {
    console.log(`Build Sim Agent server listening on http://${HOST}:${port}`);
  });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PortableConflictStrategy } from "../portability/runtime";
import type { ProductionWorkspacePortability } from "./portability-production";

const MAX_PORTABLE_UPLOAD_BYTES = 512 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  response.end(body);
}

async function readBoundedBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length; if (size > MAX_PORTABLE_UPLOAD_BYTES) throw new Error("portable upload is too large");
    chunks.push(bytes);
  }
  if (size === 0) throw new Error("portable upload is empty");
  return Buffer.concat(chunks);
}

/** Handles the two streaming portability boundaries before JSON parsing. */
export async function handleWorkspacePortabilityBinaryRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  portability?: ProductionWorkspacePortability;
  enabled: boolean;
}): Promise<boolean> {
  const download = /^\/api\/workspace\/portability\/exports\/([^/]+)\/download$/.exec(input.pathname);
  const stage = input.pathname === "/api/workspace/portability/imports/dry-run";
  if (!download && !stage) return false;
  if (!input.enabled) { sendJson(input.response, 404, { error: "portability_disabled" }); return true; }
  if (!input.portability) { sendJson(input.response, 503, { error: "portability_unavailable" }); return true; }
  try {
    if (download) {
      if (input.request.method !== "GET") { sendJson(input.response, 405, { error: "method_not_allowed" }); return true; }
      const exported = await input.portability.download(decodeURIComponent(download[1]!));
      input.response.writeHead(200, {
        "Content-Type": "application/vnd.buildsim.plan+json",
        "Content-Length": exported.bytes.length,
        "Content-Disposition": `attachment; filename="${exported.fileName}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      input.response.end(exported.bytes); return true;
    }
    if (input.request.method !== "POST") { sendJson(input.response, 405, { error: "method_not_allowed" }); return true; }
    const password = input.request.headers["x-buildsim-package-password"];
    const chosen = input.request.headers["x-buildsim-conflict-strategy"];
    const newPlanId = input.request.headers["x-buildsim-new-plan-id"];
    if (typeof password !== "string" || typeof chosen !== "string" || Array.isArray(newPlanId)) throw new TypeError("portable dry-run headers are invalid");
    const preview = await input.portability.stageImport(await readBoundedBytes(input.request), {
      password,
      strategy: chosen as PortableConflictStrategy,
      ...(typeof newPlanId === "string" && newPlanId ? { newPlanId } : {}),
    });
    sendJson(input.response, 200, preview); return true;
  } catch (error) {
    const status = error instanceof TypeError ? 400 : /not found|ENOENT/.test(error instanceof Error ? error.message : "") ? 404 : 409;
    sendJson(input.response, status, { error: "portability_request_failed", message: error instanceof Error ? error.message : "Portable request failed" });
    return true;
  }
}

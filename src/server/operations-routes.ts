import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProductionWorkspaceOperations } from "./operations-production";

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  response.end(body);
}

export async function handleWorkspaceOperationsBinaryRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  operations?: Pick<ProductionWorkspaceOperations, "downloadDiagnostic">;
  enabled: boolean;
}): Promise<boolean> {
  const match = /^\/api\/workspace\/diagnostics\/([^/]+)\/download$/.exec(input.pathname);
  if (!match) return false;
  if (!input.enabled) { sendJson(input.response, 404, { error: "doctor_disabled" }); return true; }
  if (!input.operations) { sendJson(input.response, 503, { error: "doctor_unavailable" }); return true; }
  if (input.request.method !== "GET") { sendJson(input.response, 405, { error: "method_not_allowed" }); return true; }
  try {
    const diagnostic = await input.operations.downloadDiagnostic(decodeURIComponent(match[1]!));
    input.response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": diagnostic.bytes.length,
      "Content-Disposition": `attachment; filename="${diagnostic.fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    input.response.end(diagnostic.bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Diagnostic download failed";
    sendJson(input.response, /not found|ENOENT/.test(message) ? 404 : error instanceof TypeError ? 400 : 409, { error: "diagnostic_download_failed", message });
  }
  return true;
}

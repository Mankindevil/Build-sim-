import { createHash } from "node:crypto";

/** Stable run identity shared by context preflight and AgentRuntime. */
export function agentRunIdForIdempotency(sessionId: string, idempotencyKey: string): string {
  if (typeof sessionId !== "string" || !sessionId || typeof idempotencyKey !== "string" || !idempotencyKey) throw new Error("Agent run binding identity is invalid");
  return `run-${createHash("sha256").update(`${sessionId}\0${idempotencyKey}`, "utf8").digest("hex").slice(0, 32)}`;
}

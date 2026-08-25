import { createHash } from "node:crypto";
import type { AgentRunAuditRecord } from "./contracts";
import { stableAgentJson } from "./evaluation-contract";

const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|cookie|set-cookie|password|secret|access[_-]?token|refresh[_-]?token|approval[_-]?token)$/i;

export function agentAuditHash(value: unknown): string {
  return createHash("sha256").update(stableAgentJson(value)).digest("hex");
}

export function redactAgentAuditText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

export function redactAgentAuditValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactAgentAuditText(value);
  if (Array.isArray(value)) return value.map((entry) => redactAgentAuditValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, redactAgentAuditValue(entry, name)]));
  }
  return value;
}

export function sealAgentRunAudit(record: Omit<AgentRunAuditRecord, "recordHash"> | AgentRunAuditRecord): AgentRunAuditRecord {
  const { recordHash: _ignored, ...unsigned } = record as AgentRunAuditRecord;
  const redacted = redactAgentAuditValue(unsigned) as Omit<AgentRunAuditRecord, "recordHash">;
  return { ...redacted, recordHash: agentAuditHash(redacted) };
}

export interface AgentRunAuditStore {
  get(runId: string): Promise<AgentRunAuditRecord | null>;
  put(record: AgentRunAuditRecord): Promise<void>;
}

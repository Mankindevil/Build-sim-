import { AGENT_CONTRACT_VERSION, type AgentWriteApprovalEnvelope } from "./contracts";

const ID = /^[A-Za-z0-9._:-]{8,160}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

export function validateWriteApprovalEnvelope(value: unknown, now = new Date()): string[] {
  const approval = value && typeof value === "object" ? value as Partial<AgentWriteApprovalEnvelope> : {};
  const errors: string[] = [];
  if (approval.contractVersion !== AGENT_CONTRACT_VERSION) errors.push("approval.contractVersion invalid");
  if (!ID.test(approval.approvalId ?? "")) errors.push("approval.approvalId invalid");
  if (!TOOL.test(approval.toolName ?? "")) errors.push("approval.toolName invalid");
  if (!HASH.test(approval.toolDefinitionHash ?? "")) errors.push("approval.toolDefinitionHash invalid");
  if (!ID.test(approval.sessionId ?? "")) errors.push("approval.sessionId invalid");
  if (!ID.test(approval.runId ?? "")) errors.push("approval.runId invalid");
  if (!HASH.test(approval.inputHash ?? "")) errors.push("approval.inputHash invalid");
  if (!ID.test(approval.idempotencyKey ?? "")) errors.push("approval.idempotencyKey invalid");
  if (!ID.test(approval.approvedBy ?? "")) errors.push("approval.approvedBy invalid");
  if (typeof approval.approvalToken !== "string" || approval.approvalToken.length < 32 || approval.approvalToken.length > 4_096) errors.push("approval.approvalToken invalid");
  const issued = Date.parse(approval.issuedAt ?? "");
  const expires = Date.parse(approval.expiresAt ?? "");
  if (!Number.isFinite(issued)) errors.push("approval.issuedAt invalid");
  if (!Number.isFinite(expires)) errors.push("approval.expiresAt invalid");
  if (Number.isFinite(issued) && Number.isFinite(expires)) {
    if (expires <= issued) errors.push("approval expiry must follow issuance");
    if (expires - issued > 15 * 60_000) errors.push("approval lifetime exceeds 15 minutes");
    if (expires <= now.getTime()) errors.push("approval expired");
    if (issued > now.getTime() + 60_000) errors.push("approval issued in the future");
  }
  if (approval.backup?.required !== true || typeof approval.backup.target !== "string" || !approval.backup.target.trim()) errors.push("approval backup plan required");
  if (approval.rollback?.required !== true || typeof approval.rollback.strategy !== "string" || !approval.rollback.strategy.trim()) errors.push("approval rollback plan required");
  return [...new Set(errors)];
}

export function approvalMatchesExecution(
  approval: AgentWriteApprovalEnvelope,
  execution: { toolName: string; toolDefinitionHash: string; sessionId: string; runId: string; inputHash: string },
): boolean {
  return approval.toolName === execution.toolName
    && approval.toolDefinitionHash === execution.toolDefinitionHash
    && approval.sessionId === execution.sessionId
    && approval.runId === execution.runId
    && approval.inputHash === execution.inputHash;
}

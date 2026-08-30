import type {
  AgentWriteApprovalBinding,
  ValidatedAgentWriteApprovalProof,
} from "../agent/write-approval-authority";
import {
  assertValidatedAgentWriteApprovalProofAtRoot,
  createAgentWriteApprovalBinding,
} from "../agent/write-approval-authority";
import { agentAuditHash } from "../agent/audit";
import { FilePlanAgentContextAuditStore } from "../plans/agent-context-audit";
import { confined } from "../runtime/fs.mjs";

export interface ClaimPromotionAuthorization {
  /** Ephemeral server-minted capability; a structural look-alike is rejected. */
  readonly proof?: ValidatedAgentWriteApprovalProof;
  /** The exact Tool input that the human reviewed. */
  readonly approvedInput: unknown;
}

interface ClaimPromotionApprovalExpectation {
  readonly activeRoot: string;
  readonly authorization: ClaimPromotionAuthorization | undefined;
  readonly kind: "official" | "third_party";
  readonly candidateId: string;
  readonly planId: string;
  readonly planConfigHash: string;
  readonly planDraftRevision: number;
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function assertApprovedInput(
  kind: ClaimPromotionApprovalExpectation["kind"],
  candidateId: string,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!ownRecord(input)) throw new Error("reviewed claim promotion Tool input is invalid");
  if (kind === "official") {
    if (!exactKeys(input, ["candidateId"]) || input.candidateId !== candidateId) {
      throw new Error("official claim promotion approval does not bind the exact candidate");
    }
    return;
  }
  const keys = input.targetFactId === undefined
    ? ["claimCandidateId", "intent"]
    : ["claimCandidateId", "intent", "targetFactId"];
  if (!exactKeys(input, keys) || input.claimCandidateId !== candidateId
    || !["create", "replace", "withdraw"].includes(String(input.intent ?? ""))) {
    throw new Error("third-party claim promotion approval does not bind the exact candidate");
  }
}

/**
 * Re-validates the human-reviewed execution and its workspace-issued plan
 * context inside the same active generation used by the authority writer.
 */
export async function assertClaimPromotionApprovalAtRoot(
  expectation: ClaimPromotionApprovalExpectation,
): Promise<AgentWriteApprovalBinding> {
  const { authorization } = expectation;
  if (!authorization?.proof) throw new Error("server-issued reviewed claim promotion approval is required");
  assertApprovedInput(expectation.kind, expectation.candidateId, authorization.approvedInput);
  const toolName = expectation.kind === "official" ? "archive_official_evidence" : "propose_fact_update";
  const execution = {
    toolName,
    toolDefinitionHash: authorization.proof.execution.toolDefinitionHash,
    sessionId: authorization.proof.execution.sessionId,
    runId: authorization.proof.execution.runId,
    inputHash: agentAuditHash(authorization.approvedInput),
    callId: authorization.proof.execution.callId,
  };
  const durable = await assertValidatedAgentWriteApprovalProofAtRoot(expectation.activeRoot, authorization.proof, execution);

  const audit = await new FilePlanAgentContextAuditStore({
    root: confined(expectation.activeRoot, "audit", "plan-agent-context"),
  }).get(execution.runId);
  if (!audit || audit.sessionId !== execution.sessionId || audit.runId !== execution.runId
    || audit.planId !== expectation.planId || audit.configHash !== expectation.planConfigHash
    || audit.draftRevision !== expectation.planDraftRevision) {
    throw new Error("reviewed claim promotion plan context is missing, cross-plan, or stale");
  }
  return createAgentWriteApprovalBinding(durable, audit.contextHash);
}

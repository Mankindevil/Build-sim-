import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentToolContext } from "../agent/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json } from "../runtime/fs.mjs";
import {
  validateGovernedAgentProposalEnvelopeRuntime,
  validateGovernedAgentProposalRuntime,
} from "./runtime-validation.mjs";

export const GOVERNED_AGENT_PROPOSAL_ACTIONS = [
  "archive_official_evidence",
  "propose_fact_update",
  "bind_fact_evidence",
  "resolve_fact_conflict",
] as const;
export type GovernedAgentProposalAction = typeof GOVERNED_AGENT_PROPOSAL_ACTIONS[number];

export interface GovernedAgentActionProposal {
  schemaVersion: "governed-agent-action-proposal-v1";
  proposalId: string;
  action: GovernedAgentProposalAction;
  planId: string;
  sessionId: string;
  runId: string;
  approvalId: string;
  approvedBy: string;
  requestHash: string;
  payload: unknown;
  status: "proposed";
  createdAt: string;
  contentHash: string;
}

interface ProposalEnvelope {
  schemaVersion: "governed-agent-action-proposal-envelope-v1";
  kind: "governed-agent-action-proposal";
  checksum: string;
  payload: GovernedAgentActionProposal;
}

export class GovernedAgentProposalError extends Error {
  constructor(readonly code: "approval_authority_required" | "not_found" | "conflict" | "corrupt_data" | "invalid_input", message: string) {
    super(message);
    this.name = "GovernedAgentProposalError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function clone<T>(value: T): T { return structuredClone(value); }

function finiteJson(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 2_048 && value.every((entry) => finiteJson(entry, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 512 && entries.every(([key, entry]) => key.length <= 256 && finiteJson(entry, depth + 1));
}

export class GovernedAgentProposalRepository {
  constructor(
    private readonly coordinator: RuntimeCoordinator,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private file(activeRoot: string, proposalId: string): string {
    if (!ID.test(proposalId)) throw new GovernedAgentProposalError("invalid_input", "governed proposal ID is invalid");
    return confined(activeRoot, "agent", "governed-proposals", `${proposalId}.json`);
  }

  private validate(value: GovernedAgentActionProposal): void {
    const errors = validateGovernedAgentProposalRuntime(value);
    if (errors.length) throw new GovernedAgentProposalError("corrupt_data", `governed action proposal integrity is invalid: ${errors.join("; ")}`);
  }

  private async readAt(activeRoot: string, proposalId: string, optional = false): Promise<GovernedAgentActionProposal | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.file(activeRoot, proposalId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return null;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new GovernedAgentProposalError("not_found", "governed action proposal was not found");
      throw new GovernedAgentProposalError("corrupt_data", "governed action proposal cannot be read");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GovernedAgentProposalError("corrupt_data", "governed action proposal envelope is invalid");
    const envelope = parsed as Partial<ProposalEnvelope>;
    const errors = validateGovernedAgentProposalEnvelopeRuntime(envelope, proposalId);
    if (errors.length) throw new GovernedAgentProposalError("corrupt_data", `governed action proposal envelope integrity is invalid: ${errors.join("; ")}`);
    this.validate(envelope.payload!);
    return clone(envelope.payload!);
  }

  async put(input: {
    action: GovernedAgentProposalAction;
    planId: string;
    payload: unknown;
    context: AgentToolContext;
  }): Promise<GovernedAgentActionProposal> {
    if (!input.context.approval) throw new GovernedAgentProposalError("approval_authority_required", "governed proposal requires dispatcher-bound approval authority");
    if (!ID.test(input.planId) || !finiteJson(input.payload)) throw new GovernedAgentProposalError("invalid_input", "governed proposal plan or payload is invalid");
    const approval = input.context.approval;
    const requestHash = sha256Json({ action: input.action, planId: input.planId, payload: input.payload });
    const proposalId = `agent-proposal-${digest(`${input.context.sessionId}\0${approval.idempotencyKey}\0${input.action}`)}`;
    await this.coordinator.initialize();
    return (await this.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const existing = await this.readAt(activeRoot, proposalId, true);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.action !== input.action || existing.planId !== input.planId
          || existing.sessionId !== input.context.sessionId || existing.approvalId !== approval.approvalId) {
          throw new GovernedAgentProposalError("conflict", "governed proposal idempotency key is already bound to another request");
        }
        return existing;
      }
      const material = {
        schemaVersion: "governed-agent-action-proposal-v1" as const,
        proposalId,
        action: input.action,
        planId: input.planId,
        sessionId: input.context.sessionId,
        runId: input.context.runId,
        approvalId: approval.approvalId,
        approvedBy: approval.approvedBy,
        requestHash,
        payload: clone(input.payload),
        status: "proposed" as const,
        createdAt: this.now(),
      };
      const proposal: GovernedAgentActionProposal = { ...material, contentHash: sha256Json(material) };
      this.validate(proposal);
      const envelope: ProposalEnvelope = {
        schemaVersion: "governed-agent-action-proposal-envelope-v1",
        kind: "governed-agent-action-proposal",
        checksum: sha256Json(proposal),
        payload: proposal,
      };
      await atomicWriteJson(this.file(activeRoot, proposalId), envelope);
      return clone(proposal);
    })).result;
  }

  async get(proposalId: string): Promise<GovernedAgentActionProposal> {
    await this.coordinator.initialize();
    return (await this.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const proposal = await this.readAt(activeRoot, proposalId);
      return proposal!;
    })).result;
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { validateRuntimeJobSideEffectFence } from "../jobs/runtime-validation.mjs";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, readJson, sha256Json } from "../runtime/fs.mjs";
import { validateEvidenceAdapterCandidate, verifyEvidenceAdapterCandidate } from "./adapters/contracts";
import {
  createFilePlanClaimCandidateAuthority,
  type OfficialClaimCandidatePlanAuthority,
} from "./claim-candidate-repository";
import { validateOfficialClaimCandidateEnvelopeRuntime } from "./claim-candidate-runtime.mjs";
import {
  validateEvidenceBindingProposalEnvelopeRuntime,
  validateEvidenceBindingProposalRecordRuntime,
  validateEvidenceBindingProposalRuntime,
  type EvidenceBindingProposal,
  type EvidenceBindingProposalRecord,
} from "./binding-proposal-runtime.mjs";
import type { EvidenceJobArtifactFence } from "./jobs/artifact-store";
import {
  validateEvidenceStageResult,
  verifyEvidencePipelineRequest,
  type EvidencePipelineRequest,
  type EvidenceStageResult,
} from "./jobs/contracts";
import { validateThirdPartyClaimCandidateEnvelopeRuntime } from "./third-party-claim-candidate-runtime.mjs";

const JOB_ENVELOPE_SCHEMA = "job-store-envelope-v1";
const PROPOSAL_ID = /^evidence-binding-proposal-sha256-([a-f0-9]{64})$/;
const ARTIFACT_MEDIA_TYPE = "application/vnd.buildsim.evidence-job+json";

interface ProposalEnvelope {
  readonly schemaVersion: "evidence-binding-proposal-envelope-v1";
  readonly kind: "evidence-binding-proposal";
  readonly checksum: string;
  readonly payload: EvidenceBindingProposalRecord;
}

export interface EvidenceBindingProposalSink {
  putFromStageResult(
    result: EvidenceStageResult,
    resultArtifactRef: string,
    fence: EvidenceJobArtifactFence,
  ): Promise<EvidenceBindingProposalRecord | null>;
}

export class EvidenceBindingProposalRepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input" | "fenced" | "cross_plan",
    message: string,
  ) {
    super(message);
    this.name = "EvidenceBindingProposalRepositoryError";
  }
}

function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }
function clone<T>(value: T): T { return structuredClone(value); }
function parse(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength > 4 * 1024 * 1024) throw new EvidenceBindingProposalRepositoryError("corrupt_data", `${label} is too large`);
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new EvidenceBindingProposalRepositoryError("corrupt_data", `${label} is not valid JSON`); }
}

export class EvidenceBindingProposalRepository implements EvidenceBindingProposalSink {
  private readonly planAuthority: OfficialClaimCandidatePlanAuthority;

  constructor(private readonly options: {
    readonly coordinator: RuntimeCoordinator;
    readonly runtimeRoot: string;
    readonly planAuthority?: OfficialClaimCandidatePlanAuthority;
    readonly topologyV3Enabled?: boolean;
    readonly now?: () => string;
  }) {
    if (path.resolve(options.runtimeRoot) !== options.coordinator.root) {
      throw new TypeError("evidence binding proposal runtimeRoot must match RuntimeCoordinator");
    }
    this.planAuthority = options.planAuthority ?? createFilePlanClaimCandidateAuthority({
      ...(options.topologyV3Enabled === undefined ? {} : { topologyV3Enabled: options.topologyV3Enabled }),
    });
  }

  private file(activeRoot: string, proposalId: string): string {
    const match = PROPOSAL_ID.exec(proposalId);
    if (!match) throw new EvidenceBindingProposalRepositoryError("invalid_input", "evidence binding proposal ID is invalid");
    return confined(activeRoot, "evidence", "binding-proposals", match[1]!.slice(0, 2), `${proposalId}.json`);
  }

  private async readAt(activeRoot: string, proposalId: string, optional = false): Promise<EvidenceBindingProposalRecord | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.file(activeRoot, proposalId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return null;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new EvidenceBindingProposalRepositoryError("not_found", "evidence binding proposal was not found");
      throw new EvidenceBindingProposalRepositoryError("corrupt_data", "evidence binding proposal cannot be read");
    }
    const errors = validateEvidenceBindingProposalEnvelopeRuntime(value, proposalId);
    if (errors.length) throw new EvidenceBindingProposalRepositoryError("corrupt_data", `evidence binding proposal integrity is invalid: ${errors.join("; ")}`);
    return clone((value as ProposalEnvelope).payload);
  }

  private async artifactAt(activeRoot: string, ref: string): Promise<EvidenceStageResult> {
    const root = confined(activeRoot, "artifacts");
    const artifact = await new FileArtifactRepository({ root }).getAt(root, ref, { initialize: false });
    if (!artifact || artifact.record.kind !== "evidence-stage-result" || artifact.record.mediaType !== ARTIFACT_MEDIA_TYPE) {
      throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal stage artifact authority is missing");
    }
    const result = parse(artifact.bytes, "evidence stage result");
    if (!validateEvidenceStageResult(result)) throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal stage artifact is invalid");
    return result;
  }

  private async requestAt(activeRoot: string, ref: string): Promise<EvidencePipelineRequest> {
    const root = confined(activeRoot, "artifacts");
    const artifact = await new FileArtifactRepository({ root }).getAt(root, ref, { initialize: false });
    const value = artifact && artifact.record.kind === "evidence-pipeline-request" ? parse(artifact.bytes, "evidence pipeline request") : null;
    if (!artifact || artifact.record.mediaType !== ARTIFACT_MEDIA_TYPE || !await verifyEvidencePipelineRequest(value)) {
      throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal request authority is missing or invalid");
    }
    return value as EvidencePipelineRequest;
  }

  private async candidateAt(activeRoot: string, candidateId: string) {
    const thirdParty = candidateId.startsWith("third-party-");
    const hash = candidateId.slice(candidateId.lastIndexOf("-") + 1);
    const file = confined(activeRoot, "evidence", thirdParty ? "third-party-claim-candidates" : "claim-candidates",
      hash.slice(0, 2), `${candidateId}.json`);
    let envelope: unknown;
    try { envelope = JSON.parse(await readFile(file, "utf8")); }
    catch { throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal claim candidate authority is missing"); }
    const errors = thirdParty
      ? validateThirdPartyClaimCandidateEnvelopeRuntime(envelope, candidateId)
      : validateOfficialClaimCandidateEnvelopeRuntime(envelope, candidateId);
    if (errors.length) throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal claim candidate authority is invalid");
    return (envelope as { payload: { planId: string; claim: { subject: Parameters<OfficialClaimCandidatePlanAuthority["resolveAtRoot"]>[2]["subject"] }; catalogIdentity: { brand: string; category: string } } }).payload;
  }

  private async closureAt(activeRoot: string, record: EvidenceBindingProposalRecord): Promise<void> {
    const result = await this.artifactAt(activeRoot, record.resultArtifactRef);
    if (result.stage !== "binding_proposal" || result.status !== "completed" || result.jobId !== record.jobId
      || !same(result.output, record.proposal)) throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal/result closure is invalid");
    const requestRef = result.inputRefs[0];
    if (!requestRef) throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal request ref is missing");
    const request = await this.requestAt(activeRoot, requestRef);
    if (request.planId !== record.proposal.planId || request.pipelineId !== record.proposal.pipelineId
      || !same(request.subject, record.proposal.subject)) throw new EvidenceBindingProposalRepositoryError("cross_plan", "binding proposal request/plan/subject closure is invalid");
    const claimResult = await this.artifactAt(activeRoot, record.claimResultArtifactRef);
    if (!(["claim_extraction", "third_party_fallback"].includes(claimResult.stage)) || claimResult.status !== "completed"
      || !same([...record.proposal.claimCandidateIds].sort(), [...(claimResult.output.claimCandidateIds as string[])].sort())) {
      throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal claim result closure is invalid");
    }
    const adapterResult = await this.artifactAt(activeRoot, record.adapterResultArtifactRef);
    const adapter = adapterResult.output;
    if (adapterResult.stage !== "adapter_generation" || adapterResult.status !== "completed"
      || adapter.candidateId !== record.proposal.adapterCandidateId || adapter.contentHash !== record.proposal.adapterCandidateHash
      || validateEvidenceAdapterCandidate(adapter).length || !await verifyEvidenceAdapterCandidate(adapter)) {
      throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal adapter candidate closure is invalid");
    }
    for (const candidateId of record.proposal.claimCandidateIds) {
      const candidate = await this.candidateAt(activeRoot, candidateId);
      if (candidate.planId !== record.proposal.planId) throw new EvidenceBindingProposalRepositoryError("cross_plan", "binding proposal contains a cross-plan candidate");
    }
    const lead = await this.candidateAt(activeRoot, record.proposal.claimCandidateIds[0]!);
    const authority = await this.planAuthority.resolveAtRoot(activeRoot, record.proposal.planId, {
      subject: lead.claim.subject,
      brand: record.proposal.subject.brand,
      category: record.proposal.subject.category,
    });
    if (authority.configHash !== record.planConfigHash || authority.plan.draftRevision !== record.planDraftRevision) {
      throw new EvidenceBindingProposalRepositoryError("cross_plan", "binding proposal active plan authority changed");
    }
  }

  async putFromStageResult(result: EvidenceStageResult, resultArtifactRef: string, fence: EvidenceJobArtifactFence): Promise<EvidenceBindingProposalRecord | null> {
    if (result.stage !== "binding_proposal" || result.status !== "completed") return null;
    const proposal = result.output as unknown as EvidenceBindingProposal;
    const proposalErrors = validateEvidenceBindingProposalRuntime(proposal);
    if (proposalErrors.length) throw new EvidenceBindingProposalRepositoryError("invalid_input", proposalErrors.join("; "));
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withWrite(async ({ activeRoot, state }: { activeRoot: string; state: { runtimeGeneration: number } }) => {
      const jobEnvelope = await readJson(confined(activeRoot, "jobs", "records", `${fence.jobId}.json`));
      if (state.runtimeGeneration !== fence.runtimeGeneration || result.jobId !== fence.jobId
        || jobEnvelope?.schemaVersion !== JOB_ENVELOPE_SCHEMA || jobEnvelope.kind !== "background-job"
        || jobEnvelope.checksum !== sha256Json(jobEnvelope.payload)
        || validateRuntimeJobSideEffectFence(jobEnvelope.payload, {
          jobId: fence.jobId, expectedRevision: fence.expectedRevision, leaseToken: fence.leaseToken,
          runtimeGeneration: fence.runtimeGeneration,
        }, (this.options.now ?? (() => new Date().toISOString()))()).length) {
        throw new EvidenceBindingProposalRepositoryError("fenced", "binding proposal belongs to a stale job lease or runtime generation");
      }
      const persistedResult = await this.artifactAt(activeRoot, resultArtifactRef);
      if (!same(persistedResult, result)) throw new EvidenceBindingProposalRepositoryError("corrupt_data", "binding proposal result artifact changed");
      const refs = result.inputRefs.slice(1);
      const priorResults = await Promise.all(refs.map(async (ref) => ({ ref, result: await this.artifactAt(activeRoot, ref) })));
      const claimResult = [...priorResults].reverse().find(({ result: prior }) => ["claim_extraction", "third_party_fallback"].includes(prior.stage)
        && prior.status === "completed" && Array.isArray(prior.output.claimCandidateIds)
        && same([...prior.output.claimCandidateIds as string[]].sort(), [...proposal.claimCandidateIds].sort()));
      const adapterResult = priorResults.find(({ result: prior }) => prior.stage === "adapter_generation" && prior.status === "completed"
        && prior.output.candidateId === proposal.adapterCandidateId && prior.output.contentHash === proposal.adapterCandidateHash);
      if (!claimResult || !adapterResult) throw new EvidenceBindingProposalRepositoryError("invalid_input", "binding proposal prior result authority is missing");
      const lead = await this.candidateAt(activeRoot, proposal.claimCandidateIds[0]!);
      const authority = await this.planAuthority.resolveAtRoot(activeRoot, proposal.planId, {
        subject: lead.claim.subject,
        brand: proposal.subject.brand,
        category: proposal.subject.category,
      });
      const material = {
        schemaVersion: "evidence-binding-proposal-record-v1" as const,
        proposal: clone(proposal),
        planConfigHash: authority.configHash,
        planDraftRevision: authority.plan.draftRevision,
        jobId: result.jobId,
        runtimeGeneration: fence.runtimeGeneration,
        resultArtifactRef,
        claimResultArtifactRef: claimResult.ref,
        adapterResultArtifactRef: adapterResult.ref,
      };
      const record: EvidenceBindingProposalRecord = { ...material, recordHash: sha256Json(material) };
      const errors = validateEvidenceBindingProposalRecordRuntime(record);
      if (errors.length) throw new EvidenceBindingProposalRepositoryError("invalid_input", errors.join("; "));
      await this.closureAt(activeRoot, record);
      const existing = await this.readAt(activeRoot, proposal.bindingProposalId, true);
      if (existing) {
        if (!same(existing, record)) throw new EvidenceBindingProposalRepositoryError("conflict", "immutable binding proposal ID collision");
        return existing;
      }
      const envelope: ProposalEnvelope = {
        schemaVersion: "evidence-binding-proposal-envelope-v1",
        kind: "evidence-binding-proposal",
        checksum: sha256Json(record),
        payload: record,
      };
      await atomicWriteJson(this.file(activeRoot, proposal.bindingProposalId), envelope);
      return clone(record);
    })).result;
  }

  async get(proposalId: string): Promise<EvidenceBindingProposalRecord | null> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) =>
      this.readAt(activeRoot, proposalId, true))).result;
  }

  async getForPlan(proposalId: string, planId: string): Promise<EvidenceBindingProposalRecord> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) => {
      const record = await this.readAt(activeRoot, proposalId);
      if (!record) throw new EvidenceBindingProposalRepositoryError("not_found", "evidence binding proposal was not found");
      if (record.proposal.planId !== planId) throw new EvidenceBindingProposalRepositoryError("cross_plan", "evidence binding proposal belongs to another plan");
      await this.closureAt(activeRoot, record);
      return clone(record);
    })).result;
  }
}

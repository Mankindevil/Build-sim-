import type { EvidencePipelineSubject } from "./jobs/contracts";

export interface EvidenceBindingProposal {
  readonly schemaVersion: "evidence-binding-proposal-v1";
  readonly bindingProposalId: `evidence-binding-proposal-sha256-${string}`;
  readonly planId: string;
  readonly pipelineId: `evidence-pipeline-sha256-${string}`;
  readonly subject: EvidencePipelineSubject;
  readonly claimCandidateIds: readonly string[];
  readonly adapterCandidateId: `evidence-adapter-candidate-sha256-${string}`;
  readonly adapterCandidateHash: string;
  readonly approvalRequired: true;
  readonly createdAt: string;
  readonly contentHash: string;
}

export interface EvidenceBindingProposalRecord {
  readonly schemaVersion: "evidence-binding-proposal-record-v1";
  readonly proposal: EvidenceBindingProposal;
  readonly planConfigHash: string;
  readonly planDraftRevision: number;
  readonly jobId: string;
  readonly runtimeGeneration: number;
  readonly resultArtifactRef: string;
  readonly claimResultArtifactRef: string;
  readonly adapterResultArtifactRef: string;
  readonly recordHash: string;
}

export function createEvidenceBindingProposalRuntime(input: {
  readonly planId: string;
  readonly pipelineId: string;
  readonly subject: EvidencePipelineSubject;
  readonly claimCandidateIds: readonly string[];
  readonly adapterCandidateId: string;
  readonly adapterCandidateHash: string;
  readonly createdAt: string;
}): EvidenceBindingProposal | null;
export function validateEvidenceBindingProposalRuntime(value: unknown): string[];
export function validateEvidenceBindingProposalRecordRuntime(value: unknown): string[];
export function validateEvidenceBindingProposalEnvelopeRuntime(value: unknown, expectedProposalId?: string): string[];
export function evidenceBindingProposalReferencesRuntime(value: unknown): ReadonlyArray<{
  readonly ref: string;
  readonly necessity: "required_for_replay";
}> | null;

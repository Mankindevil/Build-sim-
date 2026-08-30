import type { EvidenceClaim } from "./contracts";
import type { ThirdPartyEvidenceSource, ThirdPartyIndependenceAssessment } from "./ladder.mjs";

export interface ThirdPartyClaimCandidateRecord {
  readonly schemaVersion: "third-party-claim-candidate-v1";
  readonly candidateId: `third-party-claim-candidate-sha256-${string}`;
  readonly planId: string;
  readonly planConfigHash: string;
  readonly planDraftRevision: number;
  readonly catalogIdentity: { readonly skuId: string; readonly brand: string; readonly category: string; readonly model: string };
  readonly pipelineId: `evidence-pipeline-sha256-${string}`;
  readonly jobId: string;
  readonly runtimeGeneration: number;
  readonly resultArtifactRef: string;
  readonly candidateIndex: number;
  readonly claim: EvidenceClaim;
  readonly source: ThirdPartyEvidenceSource;
  readonly assessment: ThirdPartyIndependenceAssessment;
  readonly originalCaptureId: EvidenceClaim["source"]["captureId"];
  readonly createdAt: string;
  readonly contentHash: string;
}

export function thirdPartyClaimCandidateIdRuntime(input: {
  readonly planId: string;
  readonly pipelineId: string;
  readonly candidateIndex: number;
  readonly claimId: string;
  readonly sourceId: string;
  readonly assessmentId: string;
}): `third-party-claim-candidate-sha256-${string}` | null;
export function validateThirdPartyClaimCandidateRuntime(value: unknown): string[];
export function validateThirdPartyClaimCandidateEnvelopeRuntime(value: unknown, expectedCandidateId?: string): string[];
export function thirdPartyClaimCandidateReferencesRuntime(value: unknown): ReadonlyArray<{
  readonly ref: string;
  readonly necessity: "required_for_replay";
}> | null;

import type { EvidenceClaim } from "./contracts";
import type { OfficialDocumentPromotion, OfficialDocumentPromotionInput } from "./ladder.mjs";

export interface OfficialClaimCandidateRecord {
  readonly schemaVersion: "official-claim-candidate-v1";
  readonly candidateId: `claim-candidate-sha256-${string}`;
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
  readonly promotionInput: OfficialDocumentPromotionInput;
  readonly promotion: Extract<OfficialDocumentPromotion, { eligible: true }>;
  readonly originalCaptureId: EvidenceClaim["source"]["captureId"];
  readonly createdAt: string;
  readonly contentHash: string;
}

export function officialClaimCandidateIdRuntime(input: {
  readonly planId: string;
  readonly pipelineId: string;
  readonly candidateIndex: number;
  readonly claimId: string;
  readonly confirmationId: string;
}): `claim-candidate-sha256-${string}` | null;
export function validateOfficialClaimCandidateRuntime(value: unknown): string[];
export function validateOfficialClaimCandidateEnvelopeRuntime(value: unknown, expectedCandidateId?: string): string[];
export function officialClaimCandidateReferencesRuntime(value: unknown): ReadonlyArray<{
  readonly ref: string;
  readonly necessity: "required_for_replay";
}> | null;

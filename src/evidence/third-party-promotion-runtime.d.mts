import type { AgentWriteApprovalBinding } from "../agent/write-approval-authority";

export interface ThirdPartyClaimPromotionRecord {
  readonly schemaVersion: "third-party-claim-promotion-v1";
  readonly promotionId: `third-party-promotion-sha256-${string}`;
  readonly candidateId: `third-party-claim-candidate-sha256-${string}`;
  readonly candidateHash: string;
  readonly planId: string;
  readonly assessmentId: `third-party-assessment-sha256-${string}`;
  readonly assessmentHash: string;
  readonly originalCaptureId: string;
  readonly promotedCaptureId: string;
  readonly activeClaimId: string;
  readonly activeClaimHash: string;
  readonly approval: AgentWriteApprovalBinding;
  readonly promotedAt: string;
  readonly contentHash: string;
}
export function createThirdPartyClaimPromotionRuntime(input: Omit<ThirdPartyClaimPromotionRecord, "promotionId" | "contentHash">): ThirdPartyClaimPromotionRecord | null;
export function validateThirdPartyClaimPromotionRuntime(value: unknown): string[];
export function validateThirdPartyClaimPromotionEnvelopeRuntime(value: unknown, expectedPromotionId?: string): string[];
export function thirdPartyClaimPromotionReferencesRuntime(value: unknown): ReadonlyArray<{ readonly ref: string; readonly necessity: "required_for_replay" }> | null;

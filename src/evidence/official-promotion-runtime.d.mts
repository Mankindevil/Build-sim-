import type { AgentWriteApprovalBinding } from "../agent/write-approval-authority";

export interface OfficialClaimPromotionRecord {
  readonly schemaVersion: "official-claim-promotion-v1";
  readonly promotionId: `official-promotion-sha256-${string}`;
  readonly candidateId: `claim-candidate-sha256-${string}`;
  readonly candidateHash: string;
  readonly planId: string;
  readonly confirmationId: `official-confirmation-sha256-${string}`;
  readonly confirmationHash: string;
  readonly originalCaptureId: string;
  readonly promotedCaptureId: string;
  readonly activeClaimId: string;
  readonly activeClaimHash: string;
  readonly approval: AgentWriteApprovalBinding;
  readonly promotedAt: string;
  readonly contentHash: string;
}

export function createOfficialClaimPromotionRuntime(
  input: Omit<OfficialClaimPromotionRecord, "promotionId" | "contentHash">,
): OfficialClaimPromotionRecord | null;
export function validateOfficialClaimPromotionRuntime(value: unknown): string[];
export function officialClaimPromotionReferencesRuntime(value: unknown): ReadonlyArray<{
  readonly ref: string;
  readonly necessity: "required_for_replay";
}> | null;

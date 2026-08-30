export interface RuntimeValidationOptions {
  uploadId?: string;
  maxBytes?: number;
}

export interface RuntimeReference {
  ref: string;
  necessity: "required_for_replay" | "optional_for_audit";
}

export function validateGovernedAgentProposalRuntime(value: unknown): string[];
export function validateGovernedAgentProposalEnvelopeRuntime(value: unknown, expectedProposalId?: string): string[];
export function governedAgentProposalReferencesRuntime(value: unknown): RuntimeReference[] | null;
export function validateStagedUploadRecordRuntime(value: unknown, options?: RuntimeValidationOptions): string[];
export function validateStagedUploadEnvelopeRuntime(value: unknown, options?: RuntimeValidationOptions): string[];
export function stagedUploadReferencesRuntime(value: unknown): RuntimeReference[] | null;

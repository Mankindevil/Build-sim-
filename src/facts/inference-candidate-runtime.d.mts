import type { FactRecord } from "./contracts";
import type { ReplayableInferenceTrace } from "./inference-policy";

export interface GovernedInferenceRuleArtifact {
  readonly schemaVersion: "governed-inference-rule-v1";
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly implementationId: string;
  /** SHA-256 of the exact executable module bytes used by the server allowlist. */
  readonly implementationHash: string;
  readonly engine: "rule";
  readonly targetFieldId: string;
  readonly inputFieldIds: readonly string[];
  readonly formula: string;
  readonly parameters: unknown;
  readonly assumptions: readonly string[];
  readonly confidence: number;
  readonly invalidationConditions: readonly string[];
}

export type InferenceCandidateSafetyDisposition = "planning_only" | "blocked_requires_non_inference_evidence";

export interface FactInferenceCandidateRecord {
  readonly schemaVersion: "fact-inference-candidate-v1";
  readonly candidateId: `fact-inference-candidate-sha256-${string}`;
  readonly planId: string;
  readonly planConfigHash: string;
  readonly planDraftRevision: number;
  /** Immutable provenance only. Restore may replay in a later generation after full revalidation. */
  readonly runtimeGeneration: number;
  /** Durable server-issued approval artifact for the exact propose Tool call. */
  readonly proposalApprovalRef?: `sha256:${string}`;
  readonly ruleArtifactRef: `sha256:${string}`;
  readonly rule: GovernedInferenceRuleArtifact;
  readonly target: { readonly fieldId: string };
  /** Embedded until approval; not an active FactRepository trace. */
  readonly trace: ReplayableInferenceTrace;
  /** Prospective record only; candidateStatus keeps it inactive until approval. */
  readonly proposedFact: FactRecord;
  readonly candidateStatus: "pending_approval";
  readonly safetyDisposition: InferenceCandidateSafetyDisposition;
  readonly maySupportSafetyPass: false;
  readonly createdAt: string;
  readonly contentHash: string;
}

export interface InferenceApprovalTransactionRecord {
  readonly schemaVersion: "fact-inference-approval-transaction-v1";
  readonly transactionId: `inference-approval-sha256-${string}`;
  readonly candidateId: `fact-inference-candidate-sha256-${string}`;
  readonly candidateHash: string;
  /** Durable server-issued approval artifact for the exact approve Tool call. */
  readonly approvalAuthorityRef?: `sha256:${string}`;
  readonly status: "pending" | "committed" | "aborted_stale";
  readonly trace: ReplayableInferenceTrace;
  readonly fact: FactRecord;
  readonly createdAt: string;
  readonly committedAt?: string;
  readonly abortedAt?: string;
  readonly abortReason?: "authority_or_input_stale";
  readonly contentHash: string;
}

export function validateGovernedInferenceRuleArtifactRuntime(value: unknown): string[];
export function factInferenceCandidateIdRuntime(input: {
  readonly planId: string;
  readonly planDraftRevision: number;
  readonly ruleArtifactRef: string;
  readonly inferenceTraceId: string;
  readonly proposedFactId: string;
  readonly proposalApprovalRef?: string;
}): `fact-inference-candidate-sha256-${string}` | null;
export function validateFactInferenceCandidateRuntime(value: unknown): string[];
export function validateFactInferenceCandidateEnvelopeRuntime(value: unknown, expectedCandidateId?: string): string[];
export function inferenceCandidateReferencesRuntime(value: unknown): ReadonlyArray<{
  readonly ref: string;
  readonly necessity: "required_for_replay";
}> | null;
export function inferenceApprovalTransactionIdRuntime(
  candidateId: string,
  candidateHash: string,
  trace: ReplayableInferenceTrace,
  fact: FactRecord,
  approvalAuthorityRef?: string,
): `inference-approval-sha256-${string}` | null;
export function validateInferenceApprovalTransactionRuntime(value: unknown, expectedTransactionId?: string): string[];
export function validateInferenceApprovalEnvelopeRuntime(value: unknown, expectedTransactionId?: string): string[];

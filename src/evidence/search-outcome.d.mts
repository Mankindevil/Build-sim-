export const EVIDENCE_SEARCH_REASONS: readonly [
  "official_not_published",
  "official_page_found_field_missing",
  "official_identity_unresolved",
  "official_access_blocked",
  "official_parse_failed",
  "official_sources_conflict",
  "official_search_exhausted",
];

export type EvidenceSearchReason = typeof EVIDENCE_SEARCH_REASONS[number];
export type EvidenceSearchAttemptStage = "discovery" | "acquisition" | "identity" | "parse" | "field_lookup" | "comparison";
export type EvidenceSearchAttemptResult =
  | "success"
  | "not_published"
  | "field_missing"
  | "identity_unresolved"
  | "access_blocked"
  | "parse_failed"
  | "sources_conflict"
  | "exhausted";

export const EVIDENCE_SEARCH_ATTEMPT_SCHEMA_VERSION: "evidence-search-attempt-v1";
export const EVIDENCE_SEARCH_OUTCOME_SCHEMA_VERSION: "evidence-search-outcome-v1";

export type EvidenceSearchSubject =
  | {
      readonly kind: "product";
      readonly skuId: string;
      readonly familyId?: string;
      readonly modelId?: string;
      readonly variantId?: string;
      readonly revision?: string;
      readonly region?: string;
    }
  | {
      readonly kind: "plan_subject";
      readonly planId: string;
      readonly subjectRef: Readonly<Record<string, unknown>>;
    };

export interface EvidenceSearchAttemptInput {
  readonly authority: "official";
  readonly stage: EvidenceSearchAttemptStage;
  readonly result: EvidenceSearchAttemptResult;
  readonly officialUrl: string;
  readonly evidenceRefs: readonly string[];
  readonly errorCode?: string;
  readonly detail: string;
  readonly attemptedAt: string;
}

export interface EvidenceSearchAttempt extends EvidenceSearchAttemptInput {
  readonly schemaVersion: typeof EVIDENCE_SEARCH_ATTEMPT_SCHEMA_VERSION;
  readonly attemptId: `search-attempt-sha256-${string}`;
  readonly contentHash: string;
}

export interface EvidenceSearchOutcomeInput {
  readonly subject: EvidenceSearchSubject;
  readonly field: string;
  readonly attempts: readonly EvidenceSearchAttempt[];
  /** Optional assertion; when present it must equal the derived terminal reason. */
  readonly reason?: EvidenceSearchReason;
  readonly exhaustive: boolean;
  readonly thirdPartyEvidenceRefs?: readonly string[];
  readonly detail: string;
  readonly manualAction: string;
  readonly searchedAt: string;
}

/** Immutable, content-addressed failure record consumed by durable evidence jobs. */
export interface EvidenceSearchOutcome {
  readonly schemaVersion: typeof EVIDENCE_SEARCH_OUTCOME_SCHEMA_VERSION;
  readonly searchOutcomeId: `search-outcome-sha256-${string}`;
  readonly subject: EvidenceSearchSubject;
  readonly field: string;
  readonly reason: EvidenceSearchReason;
  readonly officialEvidenceRefs: readonly string[];
  readonly thirdPartyEvidenceRefs: readonly string[];
  readonly searchAttemptRefs: readonly string[];
  readonly exhaustive: boolean;
  readonly searchedAt: string;
  readonly detail: string;
  readonly manualAction: string;
  readonly contentHash: string;
}

export class EvidenceSearchContractError extends TypeError {
  readonly code: string;
}

export function isEvidenceSearchReason(value: unknown): value is EvidenceSearchReason;
export function validateEvidenceSearchAttempt(value: unknown): string[];
export function createEvidenceSearchAttempt(input: EvidenceSearchAttemptInput): EvidenceSearchAttempt;
export function classifyEvidenceSearchReason(attempts: readonly EvidenceSearchAttempt[]): EvidenceSearchReason;
export function validateEvidenceSearchOutcome(value: unknown): string[];
export function createEvidenceSearchOutcome(input: EvidenceSearchOutcomeInput): EvidenceSearchOutcome;
export function evidenceSearchReasonForFailureCode(code: unknown): EvidenceSearchReason;

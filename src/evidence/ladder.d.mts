import type { EvidenceSearchReason } from "./search-outcome.mjs";

export const OFFICIAL_IDENTITY_CONFIRMATION_SCHEMA_VERSION: "official-document-identity-confirmation-v1";
export const THIRD_PARTY_EVIDENCE_SOURCE_SCHEMA_VERSION: "third-party-evidence-source-v1";
export const THIRD_PARTY_INDEPENDENCE_ASSESSMENT_SCHEMA_VERSION: "third-party-independence-assessment-v1";

export type EvidenceAuthority = "official" | "third_party" | "agent_inference";
export type EvidenceIdentityScope = "family" | "model" | "variant" | "revision";

export interface EvidenceLadderLevel {
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly key:
    | "official_exact_revision_document"
    | "official_exact_model_technical"
    | "official_family_invariant"
    | "third_party_professional_measurement"
    | "third_party_independent_corroboration"
    | "agent_replayable_inference";
  readonly authority: EvidenceAuthority;
  readonly identityScope: EvidenceIdentityScope | "derived";
  readonly description: string;
}

export const EVIDENCE_LADDER_LEVELS: readonly [
  EvidenceLadderLevel,
  EvidenceLadderLevel,
  EvidenceLadderLevel,
  EvidenceLadderLevel,
  EvidenceLadderLevel,
  EvidenceLadderLevel,
];

export interface GovernedEvidenceIdentity {
  readonly brand: string;
  readonly skuId: string;
  readonly familyId: string;
  readonly modelId: string;
  readonly variantId?: string;
  readonly revision?: string;
  readonly region?: string;
}

export interface OfficialDocumentIdentityConfirmationInput {
  readonly authority: "official";
  readonly documentSha256: string;
  readonly pageKind: "manual" | "errata" | "support" | "qvl" | "firmware" | "technical_specification" | "product";
  readonly scope: Exclude<EvidenceIdentityScope, "family">;
  readonly identity: GovernedEvidenceIdentity;
  readonly locator: { readonly page?: number; readonly section?: string; readonly excerpt: string };
  readonly matchedTokens: { readonly model: string; readonly variant?: string; readonly revision?: string };
  readonly extractor: { readonly id: string; readonly version: string };
  readonly confirmedAt: string;
}

export interface OfficialDocumentIdentityConfirmation extends Omit<OfficialDocumentIdentityConfirmationInput, "locator"> {
  readonly schemaVersion: typeof OFFICIAL_IDENTITY_CONFIRMATION_SCHEMA_VERSION;
  readonly confirmationId: `official-confirmation-sha256-${string}`;
  readonly locator: OfficialDocumentIdentityConfirmationInput["locator"] & { readonly excerptHash: string };
  readonly contentHash: string;
}

export type OfficialDocumentPromotion =
  | {
      readonly eligible: true;
      readonly authority: "official";
      readonly kindBasis: "content-verified";
      readonly reason: null;
      readonly confirmationId: string;
      readonly identity: GovernedEvidenceIdentity & { readonly basis: "official-document-explicit" };
      readonly detail: string;
    }
  | {
      readonly eligible: false;
      readonly authority: null;
      readonly kindBasis: "user-asserted";
      readonly reason: EvidenceSearchReason;
      readonly detail: string;
    };

export interface OfficialDocumentPromotionInput {
  readonly registryTrust: "trusted" | "proposal" | "untrusted";
  readonly documentSha256: string;
  readonly requiredScope: Exclude<EvidenceIdentityScope, "family">;
  readonly expectedIdentity: GovernedEvidenceIdentity & { readonly kind?: "product" };
  readonly confirmation: OfficialDocumentIdentityConfirmation;
}

export type ThirdPartySourceType = "professional_measurement" | "professional_review" | "technical_database" | "forum" | "retailer" | "repost";

export interface ThirdPartyEvidenceSourceInput {
  readonly authority: "third_party";
  readonly sourceType: ThirdPartySourceType;
  readonly canonicalUrl: string;
  readonly publisherId: string;
  readonly originalWorkId: string;
  readonly independenceGroupId: string;
  readonly editorialControl: "independent" | "vendor_controlled" | "unknown";
  readonly fundingDisclosure: "independent" | "sponsored" | "undisclosed";
  readonly subject: Omit<GovernedEvidenceIdentity, "brand"> & { readonly variantId: string; readonly revision: string };
  /** Exact revision of the tested object, not the article revision. */
  readonly objectRevision: string;
  readonly testMethod: {
    readonly kind: "measurement" | "bench_test" | "documented_inspection" | "reported";
    readonly description: string;
    readonly sampleSize: number;
    readonly equipment?: readonly string[];
    readonly conditions?: readonly string[];
  };
  readonly sourceContentHash: string;
  readonly retrievedAt: string;
}

export interface ThirdPartyEvidenceSource extends ThirdPartyEvidenceSourceInput {
  readonly schemaVersion: typeof THIRD_PARTY_EVIDENCE_SOURCE_SCHEMA_VERSION;
  readonly sourceId: `third-party-source-sha256-${string}`;
  readonly contentHash: string;
}

export interface ThirdPartyIndependenceAssessment {
  readonly schemaVersion: typeof THIRD_PARTY_INDEPENDENCE_ASSESSMENT_SCHEMA_VERSION;
  readonly assessmentId: `third-party-assessment-sha256-${string}`;
  readonly authority: "third_party";
  readonly sourceIds: readonly string[];
  readonly independentCount: number;
  readonly consistent: boolean;
  readonly conflicted: boolean;
  readonly confidence: "none" | "low" | "corroborated";
  readonly ladderLevel: 4 | 5 | null;
  readonly qualifyingSourceIds: readonly string[];
  readonly professionalMeasurementSourceIds: readonly string[];
  readonly duplicateSourceIds: readonly string[];
  readonly leadSourceIds: readonly string[];
  readonly findings: readonly ThirdPartyEvidenceFinding[];
  readonly assessedAt: string;
  readonly contentHash: string;
}

export interface ThirdPartyEvidenceFinding {
  readonly sourceId: string;
  readonly fieldId: string;
  /** Hash of the canonical extracted value/unit, never a free-form equality assertion. */
  readonly normalizedValueHash: string;
  readonly unit?: string;
}

export class EvidenceLadderContractError extends TypeError {
  readonly code: string;
  readonly reason: EvidenceSearchReason;
}

export function validateOfficialDocumentIdentityConfirmation(value: unknown): string[];
export function createOfficialDocumentIdentityConfirmation(input: OfficialDocumentIdentityConfirmationInput): OfficialDocumentIdentityConfirmation;
export function evaluateOfficialDocumentPromotion(input: OfficialDocumentPromotionInput): OfficialDocumentPromotion;
export function validateThirdPartyEvidenceSource(value: unknown): string[];
export function createThirdPartyEvidenceSource(input: ThirdPartyEvidenceSourceInput): ThirdPartyEvidenceSource;
export function assessThirdPartySourceIndependence(
  sources: readonly ThirdPartyEvidenceSource[],
  options: { readonly findings: readonly ThirdPartyEvidenceFinding[]; readonly assessedAt: string },
): ThirdPartyIndependenceAssessment;
export function validateThirdPartyIndependenceAssessment(value: unknown): string[];

export interface OfficialLadderCandidate {
  readonly authority: "official";
  readonly registryTrust: "trusted";
  readonly explicitIdentity: true;
  readonly identityScope: EvidenceIdentityScope;
  readonly kind: "manual" | "errata" | "support" | "qvl" | "firmware" | "technical_specification" | "product";
  readonly fieldInvariant?: boolean;
  readonly evidenceRef: string;
}

export interface ReplayableInferenceCandidate {
  readonly authority: "agent_inference";
  readonly replayable: true;
  readonly inputFactIds: readonly string[];
  readonly ruleOrModelVersion: string;
}

export function resolveEvidenceLadder(input?: {
  readonly officialCandidates?: readonly OfficialLadderCandidate[];
  readonly thirdPartyAssessment?: ThirdPartyIndependenceAssessment;
  readonly inference?: ReplayableInferenceCandidate;
}): EvidenceLadderLevel | {
  readonly level: null;
  readonly authority: null;
  readonly key: "unresolved";
  readonly identityScope: null;
  readonly description: string;
};

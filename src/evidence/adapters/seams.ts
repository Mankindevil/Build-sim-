import type { EvidenceClaimInput } from "../claims";
import type { EvidencePipelineRequest, EvidenceStageResult } from "../jobs/contracts";
import type { OfficialDocumentPromotionInput, ThirdPartyEvidenceFinding, ThirdPartyEvidenceSource } from "../ladder.mjs";
import { createEvidenceAdapterCandidate } from "./candidate";
import {
  extractOfficialClaimsWithVendorAdapter,
  type OfficialVendorClaimExtractorInput,
} from "./extractor";
import {
  extractProductionThirdPartyClaimsWithVendorAdapter,
  type ProductionThirdPartyVendorClaimExtractorInput,
} from "./third-party-production";

export interface ProductionAdapterGeneratorInput {
  readonly request: EvidencePipelineRequest;
  readonly claims: readonly EvidenceClaimInput[];
  readonly priorResults: readonly EvidenceStageResult[];
}

/** Direct constructor seams for ProductionEvidenceJobRuntime. */
export interface GovernedEvidenceAdapterSeams {
  readonly officialClaimExtractor: typeof extractOfficialClaimsWithVendorAdapter;
  readonly thirdPartyClaimExtractor: typeof extractProductionThirdPartyClaimsWithVendorAdapter;
  readonly adapterGenerator: (input: ProductionAdapterGeneratorInput) => ReturnType<typeof createEvidenceAdapterCandidate>;
}

function outputFor(input: ProductionAdapterGeneratorInput, stage: EvidenceStageResult["stage"]): Readonly<Record<string, unknown>> | null {
  return [...input.priorResults].reverse().find((result) => result.stage === stage && result.status === "completed")?.output ?? null;
}

export function createGovernedEvidenceAdapterSeams(): GovernedEvidenceAdapterSeams {
  return Object.freeze({
    officialClaimExtractor: (input: OfficialVendorClaimExtractorInput) => extractOfficialClaimsWithVendorAdapter(input),
    thirdPartyClaimExtractor: (input: ProductionThirdPartyVendorClaimExtractorInput) => extractProductionThirdPartyClaimsWithVendorAdapter(input),
    adapterGenerator: (input: ProductionAdapterGeneratorInput) => {
      const official = outputFor(input, "claim_extraction");
      const thirdParty = outputFor(input, "third_party_fallback");
      const archiveArtifactRefs = [...new Set(input.priorResults.flatMap((result) => result.resultRefs)
        .filter((ref): ref is `sha256:${string}` => /^sha256:[a-f0-9]{64}$/.test(ref)))].sort();
      return createEvidenceAdapterCandidate({
        request: input.request,
        claims: input.claims,
        ...(official?.officialPromotionInput === undefined ? {} : {
          officialPromotionInput: official.officialPromotionInput as OfficialDocumentPromotionInput,
        }),
        ...(Array.isArray(thirdParty?.thirdPartySources) && Array.isArray(thirdParty?.thirdPartyFindings)
          && typeof thirdParty?.assessedAt === "string" ? {
            thirdPartyEvidence: {
              sources: thirdParty.thirdPartySources as ThirdPartyEvidenceSource[],
              findings: thirdParty.thirdPartyFindings as ThirdPartyEvidenceFinding[],
              assessedAt: thirdParty.assessedAt,
            },
          } : {}),
        archiveArtifactRefs,
      });
    },
  });
}

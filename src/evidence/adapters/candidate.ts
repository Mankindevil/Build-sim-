import { factFieldPolicy } from "../../facts/field-registry";
import { hashContent } from "../../hash";
import type { EvidenceClaimInput } from "../claims";
import { createEvidenceClaim } from "../claims";
import type { EvidencePipelineRequest } from "../jobs/contracts";
import {
  assessThirdPartySourceIndependence,
  type OfficialDocumentPromotionInput,
  type ThirdPartyEvidenceFinding,
  type ThirdPartyEvidenceSource,
} from "../ladder.mjs";
import {
  EVIDENCE_ADAPTER_CANDIDATE_SCHEMA_VERSION,
  createEvidenceAdapterOfficialPromotionProof,
  createEvidenceAdapterThirdPartyProof,
  finalizeEvidenceAdapterCandidate,
  verifyEvidenceAdapterCandidate,
  type EvidenceAdapterCandidate,
  type EvidenceAdapterCapability,
  type EvidenceAdapterUnresolvedField,
} from "./contracts";
import { evidenceVendorAdapterForSubject } from "./registry";

export interface CreateEvidenceAdapterCandidateInput {
  readonly request: EvidencePipelineRequest;
  readonly claims: readonly EvidenceClaimInput[];
  readonly officialPromotionInput?: OfficialDocumentPromotionInput;
  readonly thirdPartyEvidence?: {
    readonly sources: readonly ThirdPartyEvidenceSource[];
    readonly findings: readonly ThirdPartyEvidenceFinding[];
    readonly assessedAt: string;
  };
  readonly archiveArtifactRefs?: readonly `sha256:${string}`[];
}

function sameSubject(claim: EvidenceClaimInput, request: EvidencePipelineRequest): boolean {
  const subject = request.subject;
  return claim.scope === "revision" && claim.subject.skuId === subject.skuId && claim.subject.familyId === subject.familyId
    && claim.subject.modelId === subject.modelId && claim.subject.variantId === subject.variantId
    && claim.subject.revision === subject.revision && claim.subject.region === subject.region;
}

async function governedValueHash(fieldId: string, value: unknown, unit: string | undefined): Promise<string> {
  return hashContent({
    schemaVersion: "artifact-payload-v1",
    artifactId: `adapter-capability:${fieldId}`,
    mediaType: "application/vnd.buildsim.adapter-capability-value+json",
    payload: { fieldId, value, ...(unit === undefined ? {} : { unit }) },
  }, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
}

function entityKey(fieldId: string, value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "scalar";
  const record = value as Record<string, unknown>;
  const key = fieldId === "system.requirement" ? record.requirementId
    : fieldId === "io.port_topology" ? record.endpointId
      : fieldId === "package.cable_count" ? record.cableId
        : fieldId === "package.fastener_count" ? record.fastenerId
          : fieldId === "package.tool_required" ? record.toolId
            : fieldId === "compatibility.qvl_entry" ? record.componentSkuId
              : fieldId === "firmware.cpu_support" ? record.cpuSkuId
                : fieldId === "thermal.fan_curve" ? record.curveId : undefined;
  return typeof key === "string" ? key : "scalar";
}

function unresolved(
  fieldId: string,
  reason: EvidenceAdapterUnresolvedField["reason"],
): EvidenceAdapterUnresolvedField {
  return {
    fieldId,
    reason,
    action: reason === "claim_conflict" ? "resolve_claim_conflict"
      : reason === "promotion_proof_missing" || reason === "third_party_proof_missing"
        ? "review_evidence_promotion" : "review_official_excerpt",
  };
}

export async function createEvidenceAdapterCandidate(
  input: CreateEvidenceAdapterCandidateInput,
): Promise<EvidenceAdapterCandidate> {
  const manifest = await evidenceVendorAdapterForSubject(input.request.subject);
  if (!manifest) throw new TypeError("No governed evidence adapter matches the exact subject");
  const requestedFieldIds = [...new Set(input.request.requestedFieldIds)].sort();
  if (requestedFieldIds.some((fieldId) => !manifest.supportedFieldIds.includes(fieldId))) {
    throw new TypeError("Evidence adapter candidate request contains unsupported fields");
  }
  const governedClaims = await Promise.all(input.claims.map(async (claim) => {
    if (!sameSubject(claim, input.request) || !requestedFieldIds.includes(claim.fieldId)) {
      throw new TypeError("Evidence adapter claim does not match the exact request identity/field closure");
    }
    return createEvidenceClaim(claim);
  }));
  governedClaims.sort((left, right) => left.claimId.localeCompare(right.claimId));
  const officialPromotionProof = input.officialPromotionInput === undefined ? null
    : await createEvidenceAdapterOfficialPromotionProof(input.officialPromotionInput);
  const thirdPartyAssessment = input.thirdPartyEvidence === undefined ? null
    : assessThirdPartySourceIndependence(input.thirdPartyEvidence.sources, {
      findings: input.thirdPartyEvidence.findings,
      assessedAt: input.thirdPartyEvidence.assessedAt,
    });
  const thirdPartyProof = thirdPartyAssessment === null ? null : await createEvidenceAdapterThirdPartyProof({
    sources: input.thirdPartyEvidence!.sources,
    assessment: thirdPartyAssessment,
  });
  const officialDocumentSha256 = officialPromotionProof?.promotionInput.documentSha256;
  const thirdPartySources = thirdPartyProof?.sources ?? [];
  const hasPromotionProof = (claim: (typeof governedClaims)[number]): boolean => claim.authority === "official"
    ? officialDocumentSha256 === claim.source.documentSha256
    : thirdPartySources.some((source) => source.sourceContentHash === claim.source.documentSha256
      && source.subject.skuId === claim.subject.skuId && source.subject.familyId === claim.subject.familyId
      && source.subject.modelId === claim.subject.modelId && source.subject.variantId === claim.subject.variantId
      && source.subject.revision === claim.subject.revision && source.subject.region === claim.subject.region);
  const capabilities: EvidenceAdapterCapability[] = [];
  const pending: EvidenceAdapterUnresolvedField[] = [];

  for (const fieldId of requestedFieldIds) {
    const policy = factFieldPolicy(fieldId);
    if (!policy) throw new TypeError(`Evidence adapter field is not governed: ${fieldId}`);
    const claims = governedClaims.filter((claim) => claim.fieldId === fieldId);
    if (!claims.length) {
      pending.push(unresolved(fieldId, "claim_missing"));
      continue;
    }
    const authorityEligible = claims.filter((claim) => policy.passAuthorities.includes(claim.authority));
    const eligible = authorityEligible.filter(hasPromotionProof);
    const strongest = eligible.some((claim) => claim.authority === "official")
      ? eligible.filter((claim) => claim.authority === "official")
      : eligible.filter((claim) => claim.authority === "third_party");
    if (!strongest.length) {
      const prooflessOfficial = authorityEligible.some((claim) => claim.authority === "official");
      const prooflessThirdParty = authorityEligible.some((claim) => claim.authority === "third_party");
      pending.push(unresolved(fieldId, prooflessOfficial ? "promotion_proof_missing"
        : prooflessThirdParty ? "third_party_proof_missing" : "official_authority_required"));
      continue;
    }
    const byEntity = new Map<string, typeof strongest>();
    for (const claim of strongest) {
      const key = entityKey(fieldId, claim.value);
      const group = byEntity.get(key) ?? [];
      group.push(claim);
      byEntity.set(key, group);
    }
    let conflicted = false;
    for (const claimsForEntity of byEntity.values()) {
      const values = await Promise.all(claimsForEntity.map(async (claim) => ({
        claim,
        hash: await governedValueHash(fieldId, claim.value, claim.unit),
      })));
      const hashes = [...new Set(values.map(({ hash }) => hash))];
      if (hashes.length !== 1) {
        conflicted = true;
        continue;
      }
      const first = values[0]!.claim;
      capabilities.push({
        fieldId,
        value: structuredClone(first.value),
        ...(first.unit === undefined ? {} : { unit: first.unit }),
        authority: first.authority,
        sourceClaimIds: Object.freeze(values.map(({ claim }) => claim.claimId).sort()),
      });
    }
    if (conflicted) {
      pending.push(unresolved(fieldId, "claim_conflict"));
      for (let index = capabilities.length - 1; index >= 0; index -= 1) {
        if (capabilities[index]!.fieldId === fieldId) capabilities.splice(index, 1);
      }
    }
  }

  capabilities.sort((left, right) => left.fieldId.localeCompare(right.fieldId)
    || JSON.stringify(left.value).localeCompare(JSON.stringify(right.value)));
  pending.sort((left, right) => left.fieldId.localeCompare(right.fieldId) || left.reason.localeCompare(right.reason));
  const authorities = [...new Set(governedClaims.map((claim) => claim.authority))].sort() as Array<"official" | "third_party">;
  const claimSources = governedClaims.map((claim) => ({
    claimId: claim.claimId,
    authority: claim.authority,
    documentId: claim.source.documentId,
    documentSha256: claim.source.documentSha256,
    captureId: claim.source.captureId,
  }));
  const archiveArtifactRefs = [...new Set(input.archiveArtifactRefs ?? [])].sort();
  return finalizeEvidenceAdapterCandidate({
    schemaVersion: EVIDENCE_ADAPTER_CANDIDATE_SCHEMA_VERSION,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    extractionManifestRef: manifest.manifestRef,
    subject: structuredClone(input.request.subject),
    requestedFieldIds: Object.freeze(requestedFieldIds),
    claimRefs: Object.freeze(governedClaims.map((claim) => claim.claimId)),
    claimSources: Object.freeze(claimSources),
    archiveArtifactRefs: Object.freeze(archiveArtifactRefs),
    officialPromotionProof,
    thirdPartyProof,
    authorities: Object.freeze(authorities),
    capabilities: Object.freeze(capabilities),
    unresolved: Object.freeze(pending),
    candidateStatus: pending.length ? "needs_review" : "ready_for_review",
    approvalRequired: true,
  });
}

export async function replayEvidenceAdapterCandidate(
  input: CreateEvidenceAdapterCandidateInput,
  expected: EvidenceAdapterCandidate,
): Promise<EvidenceAdapterCandidate> {
  if (!await verifyEvidenceAdapterCandidate(expected)) throw new TypeError("Evidence adapter replay expected candidate is invalid");
  const replay = await createEvidenceAdapterCandidate(input);
  if (replay.contentHash !== expected.contentHash || replay.candidateId !== expected.candidateId) {
    throw new TypeError("Evidence adapter replay did not reproduce the expected content hash");
  }
  return replay;
}

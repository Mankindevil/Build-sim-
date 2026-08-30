import type { EvidenceClaim, EvidenceClaimScope } from "../evidence/contracts";
import { verifyEvidenceClaim } from "../evidence/claims";
import { hashContent } from "../hash";
import { validateIdentityResolution, type IdentityResolution } from "./contracts";

export interface ClaimIdentityRequest {
  subjectText: string;
  scope: EvidenceClaimScope;
  claims: readonly EvidenceClaim[];
  expectedSkuId?: string;
  expectedRevision?: string;
  expectedRegion?: string;
  evaluatedAt: string;
}

function claimHasScope(claim: EvidenceClaim, scope: EvidenceClaimScope): boolean {
  const rank: Record<EvidenceClaimScope, number> = { family: 0, model: 1, variant: 2, revision: 3 };
  if (rank[claim.scope] < rank[scope]) return false;
  if (scope === "family") return Boolean(claim.subject.familyId);
  if (scope === "model") return Boolean(claim.subject.modelId);
  if (scope === "variant") return Boolean(claim.subject.modelId && claim.subject.variantId && claim.subject.skuId);
  return Boolean(claim.subject.modelId && claim.subject.variantId && claim.subject.skuId && claim.subject.revision && claim.subject.region);
}

function scopedIdentityKey(claim: EvidenceClaim, scope: EvidenceClaimScope): string {
  const parts = [claim.subject.familyId];
  if (scope === "model" || scope === "variant" || scope === "revision") parts.push(claim.subject.modelId ?? "");
  if (scope === "variant" || scope === "revision") parts.push(claim.subject.variantId ?? "", claim.subject.skuId);
  if (scope === "revision") parts.push(claim.subject.revision ?? "", claim.subject.region ?? "");
  return parts.join("\0");
}

export async function resolveClaimIdentity(request: ClaimIdentityRequest): Promise<IdentityResolution> {
  const evaluatedAt = Date.parse(request.evaluatedAt);
  if (!Number.isFinite(evaluatedAt)) throw new TypeError("identity resolution evaluatedAt must be an ISO timestamp");
  const supersededClaimIds = new Set(request.claims.flatMap((claim) => claim.supersedesClaimId ? [claim.supersedesClaimId] : []));
  const active: EvidenceClaim[] = [];
  for (const claim of request.claims) {
    const retrievedAt = Date.parse(claim.retrievedAt);
    const validFrom = claim.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(claim.validFrom);
    const validUntil = claim.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(claim.validUntil);
    if (claim.status === "active" && !supersededClaimIds.has(claim.claimId)
      && Number.isFinite(retrievedAt) && retrievedAt <= evaluatedAt
      && !Number.isNaN(validFrom) && !Number.isNaN(validUntil) && validFrom <= evaluatedAt && evaluatedAt <= validUntil
      && claimHasScope(claim, request.scope) && await verifyEvidenceClaim(claim)) active.push(claim);
  }
  const scoped = active.filter((claim) => {
    if (request.expectedSkuId !== undefined && claim.subject.skuId !== request.expectedSkuId) return false;
    if (request.expectedRevision !== undefined && claim.subject.revision !== request.expectedRevision) return false;
    if (request.expectedRegion !== undefined && claim.subject.region !== request.expectedRegion) return false;
    return true;
  });
  const skuIds = [...new Set(scoped.map((claim) => claim.subject.skuId))].sort();
  const identityKeys = new Set(scoped.map((claim) => scopedIdentityKey(claim, request.scope)));
  const identityClaimIds = scoped.map((claim) => claim.claimId).sort();
  const status = identityKeys.size === 1 && skuIds.length === 1
    ? "resolved"
    : scoped.length > 0 && (identityKeys.size > 1 || skuIds.length > 1) ? "ambiguous" : "unresolved";
  const unresolvedFieldIds: string[] = [];
  if (scoped.length === 0) unresolvedFieldIds.push(request.scope === "family" ? "familyId" : request.scope === "model" ? "modelId" : request.scope === "variant" ? "variantId" : "revision");
  if (status === "ambiguous" && skuIds.length > 1) unresolvedFieldIds.push("skuId");
  if (request.scope === "revision" && new Set(scoped.map((claim) => claim.subject.revision).filter(Boolean)).size !== 1) unresolvedFieldIds.push("revision");
  const regionValues = new Set(scoped.map((claim) => claim.subject.region ?? ""));
  if (request.scope === "revision" && (request.expectedRegion !== undefined
    ? !scoped.some((claim) => claim.subject.region === request.expectedRegion)
    : regionValues.size > 1)) unresolvedFieldIds.push("region");
  const canonicalUnresolvedFieldIds = [...new Set(unresolvedFieldIds)].sort();
  const resolvedClaimSubject = status === "resolved" ? scoped[0]!.subject : null;
  const resolvedSubject = resolvedClaimSubject ? {
    kind: "product" as const,
    skuId: resolvedClaimSubject.skuId,
    familyId: resolvedClaimSubject.familyId,
    ...(request.scope === "model" || request.scope === "variant" || request.scope === "revision"
      ? { modelId: resolvedClaimSubject.modelId! } : {}),
    ...(request.scope === "variant" || request.scope === "revision"
      ? { variantId: resolvedClaimSubject.variantId! } : {}),
    ...(request.scope === "revision"
      ? { revision: resolvedClaimSubject.revision!, region: resolvedClaimSubject.region! } : {}),
  } : null;
  const digest = await hashContent({
    subjectText: request.subjectText.normalize("NFC"), scope: request.scope, expectedSkuId: request.expectedSkuId ?? null,
    expectedRevision: request.expectedRevision ?? null, expectedRegion: request.expectedRegion ?? null, identityClaimIds,
  }, { domain: "fact-identity", schemaVersion: "fact-identity-v1" });
  const resolution: IdentityResolution = {
    identityResolutionId: `identity-sha256-${digest}`,
    subjectText: request.subjectText.normalize("NFC"),
    status,
    scope: request.scope,
    ...(status === "resolved" ? { resolvedSkuId: skuIds[0]! } : {}),
    ...(resolvedSubject ? { resolvedSubject } : {}),
    candidateSkuIds: skuIds,
    identityClaimIds,
    unresolvedFieldIds: canonicalUnresolvedFieldIds,
    evaluatedAt: request.evaluatedAt,
  };
  const errors = validateIdentityResolution(resolution);
  if (errors.length) throw new TypeError(`Invalid IdentityResolution: ${errors.join("; ")}`);
  return resolution;
}

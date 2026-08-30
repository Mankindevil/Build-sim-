import { isComponentKindId, validateFacetPredicate, type ComponentKindId, type GovernedFacetPredicate } from "../contracts/registries";
import { canonicalize, hashContent, isSha256Hex, isSnapshotHashes, type SnapshotHashes } from "../hash";
import type { FactSnapshot } from "../facts/contracts";
import type { FactRecord } from "../facts/contracts";
import { verifyFactRecord } from "../facts/hash";
import type { EvidenceClaim } from "../evidence/contracts";
import { verifyEvidenceClaim } from "../evidence/claims";
import { validateCapabilityRecord, verifyCapabilityRecord, type CapabilityRecord } from "../capabilities/facets";
import {
  buildRequirementCapabilityIndex,
  queryRequirementCapabilityIndex,
  validateRequirementCapabilityIndex,
  verifyRequirementCapabilityIndex,
  type RequirementCapabilityIndex,
  type RequirementCapabilityIndexEntry,
} from "../capabilities/requirement-index";
import { capabilityFactSnapshotRef, type CapabilityFactSnapshotRef } from "../capabilities/facets";
import { compareCanonical, containsNonNfcText, deepFreeze, hasExactKeys, isPortableId, safeRecord } from "../capabilities/validation";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";

export interface RootBoundCapabilityIndexClosure {
  planId: string;
  factSnapshot: FactSnapshot;
  capabilityRecords: CapabilityRecord[];
}

/** Server authority: callers never submit capability records, facts, or snapshot hashes. */
export interface RootBoundCapabilityIndexAuthority {
  readonly authorityKind: "root-bound-capability-index-authority-v1";
  resolveAtRoot(activeRoot: string, planId: string, expectedFactSnapshotHash?: string): Promise<RootBoundCapabilityIndexClosure>;
  /** Re-read immutable authorities at the exact coordinator root. */
  getFactAtRoot(activeRoot: string, factId: string): Promise<FactRecord | null>;
  getEvidenceClaimAtRoot(activeRoot: string, claimId: string): Promise<EvidenceClaim | null>;
}

export interface AuthoritativeCapabilityCandidateRequest {
  planId: string;
  componentKindId: ComponentKindId;
  predicates: GovernedFacetPredicate[];
  expectedFactSnapshotHash?: string;
}

export interface AuthoritativeCapabilityCandidateResultMaterial {
  schemaVersion: "authoritative-capability-candidates-v1";
  planId: string;
  runtimeGeneration: number;
  runtimeRevision: number;
  factSnapshotRef: CapabilityFactSnapshotRef;
  capabilityRecords: CapabilityRecord[];
  index: RequirementCapabilityIndex;
  indexHash: string;
  query: {
    componentKindId: ComponentKindId;
    predicates: GovernedFacetPredicate[];
  };
  candidates: RequirementCapabilityIndexEntry[];
  candidateAuthorities: Array<{
    subjectSkuId: string;
    capabilityRecordHash: string;
    sourceFactRefs: Array<{ factId: string; contentHash: string }>;
    identityClaimRefs: Array<{
      claimId: string;
      contentHash: string;
      sourceFactId: string;
      sourceFactHash: string;
    }>;
  }>;
}

export interface AuthoritativeCapabilityCandidateResult extends AuthoritativeCapabilityCandidateResultMaterial {
  contentHash: string;
}

const CONTRACT = Object.freeze({ domain: "artifact.rule-set", schemaVersion: "1.0.0" } as const);
const authoritativeCandidateServices = new WeakSet<object>();

function validateRequest(value: unknown): string[] {
  const request = safeRecord(value);
  if (!request) return ["capability candidate request must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(request, ["planId", "componentKindId", "predicates"], ["expectedFactSnapshotHash"])) {
    errors.push("capability candidate request contains unknown fields");
  }
  if (containsNonNfcText(request)) errors.push("capability candidate request contains non-NFC text");
  if (!isPortableId(request.planId)) errors.push("capability candidate request planId invalid");
  if (!isComponentKindId(request.componentKindId)) errors.push("capability candidate request componentKindId invalid");
  if (request.expectedFactSnapshotHash !== undefined && !isSha256Hex(request.expectedFactSnapshotHash)) {
    errors.push("capability candidate request expectedFactSnapshotHash invalid");
  }
  if (!Array.isArray(request.predicates)) errors.push("capability candidate request predicates invalid");
  else {
    request.predicates.forEach((predicate, index) => {
      try { errors.push(...validateFacetPredicate(predicate).map((error) => `predicates.${index}: ${error}`)); }
      catch { errors.push(`predicates.${index}: inaccessible predicate`); }
    });
    const fields = request.predicates.map((predicate) => safeRecord(predicate)?.facetId);
    if (new Set(fields).size !== fields.length) errors.push("capability candidate request predicates must use unique facet IDs");
  }
  return errors;
}

function resultMaterial(value: AuthoritativeCapabilityCandidateResult): AuthoritativeCapabilityCandidateResultMaterial {
  return {
    schemaVersion: value.schemaVersion,
    planId: value.planId,
    runtimeGeneration: value.runtimeGeneration,
    runtimeRevision: value.runtimeRevision,
    factSnapshotRef: value.factSnapshotRef,
    capabilityRecords: value.capabilityRecords,
    index: value.index,
    indexHash: value.indexHash,
    query: value.query,
    candidates: value.candidates,
    candidateAuthorities: value.candidateAuthorities,
  };
}

function productSubjectMaterial(subject: Extract<FactRecord["subject"], { kind: "product" }>) {
  const { kind: _kind, ...material } = subject;
  return material;
}

export function validateAuthoritativeCapabilityCandidateResult(value: unknown): string[] {
  try {
    const result = safeRecord(value);
    if (!result) return ["authoritative capability candidate result must be an object"];
    const errors: string[] = [];
    if (!hasExactKeys(result, [
      "schemaVersion", "planId", "runtimeGeneration", "runtimeRevision", "factSnapshotRef", "capabilityRecords", "index", "indexHash", "query", "candidates", "candidateAuthorities", "contentHash",
    ])) errors.push("authoritative capability candidate result contains unknown fields");
    if (containsNonNfcText(result)) errors.push("authoritative capability candidate result contains non-NFC text");
    if (result.schemaVersion !== "authoritative-capability-candidates-v1" || !isPortableId(result.planId)) errors.push("authoritative capability candidate result identity invalid");
    if (!Number.isInteger(result.runtimeGeneration) || Number(result.runtimeGeneration) <= 0
      || !Number.isInteger(result.runtimeRevision) || Number(result.runtimeRevision) < 0) errors.push("authoritative capability candidate result runtime state invalid");
    const ref = safeRecord(result.factSnapshotRef);
    if (!ref || !hasExactKeys(ref, ["snapshotId", "contentHash"]) || !isPortableId(ref.snapshotId) || !isSha256Hex(ref.contentHash)) {
      errors.push("authoritative capability candidate result fact snapshot ref invalid");
    }
    if (!isSha256Hex(result.indexHash) || !isSha256Hex(result.contentHash)) errors.push("authoritative capability candidate result hash invalid");
    if (!Array.isArray(result.capabilityRecords)) {
      errors.push("authoritative capability candidate result capabilityRecords invalid");
    } else {
      result.capabilityRecords.forEach((candidate, index) => {
        errors.push(...validateCapabilityRecord(candidate).map((error) => `capabilityRecords.${index}: ${error}`));
      });
      const hashes = result.capabilityRecords.map((candidate) => candidate.contentHash);
      if (new Set(hashes).size !== hashes.length || hashes.some((hash, index) => index > 0 && hashes[index - 1]! >= hash)) {
        errors.push("authoritative capability candidate records must be uniquely hash-ordered");
      }
    }
    errors.push(...validateRequirementCapabilityIndex(result.index).map((error) => `index: ${error}`));
    const index = safeRecord(result.index);
    if (index?.contentHash !== result.indexHash || canonicalize(index?.factSnapshotRef) !== canonicalize(result.factSnapshotRef)) {
      errors.push("authoritative capability candidate result index closure invalid");
    }
    if (Array.isArray(result.capabilityRecords) && Array.isArray(index?.entries)
      && canonicalize(result.capabilityRecords.map((candidate) => candidate.contentHash))
        !== canonicalize(index.entries.map((entry) => entry.capabilityRecordHash).sort(compareCanonical))) {
      errors.push("authoritative capability candidate records do not exactly close the index");
    }
    const query = safeRecord(result.query);
    if (!query || !hasExactKeys(query, ["componentKindId", "predicates"]) || !isComponentKindId(query.componentKindId)
      || !Array.isArray(query.predicates)) errors.push("authoritative capability candidate result query invalid");
    if (!Array.isArray(result.candidates)) errors.push("authoritative capability candidate result candidates invalid");
    if (!Array.isArray(result.candidateAuthorities)) errors.push("authoritative capability candidate result authority closure invalid");
    else {
      const candidates = Array.isArray(result.candidates) ? result.candidates.map((entry) => safeRecord(entry)) : [];
      const candidateBySku = new Map(candidates.filter(Boolean).map((entry) => [entry!.subjectSkuId, entry]));
      result.candidateAuthorities.forEach((raw, index) => {
        const item = safeRecord(raw);
        const candidate = item ? candidateBySku.get(item.subjectSkuId) : undefined;
        if (!item || !hasExactKeys(item, ["subjectSkuId", "capabilityRecordHash", "sourceFactRefs", "identityClaimRefs"])
          || !isPortableId(item.subjectSkuId) || !isSha256Hex(item.capabilityRecordHash)
          || !candidate || candidate.capabilityRecordHash !== item.capabilityRecordHash) {
          errors.push(`authoritative capability candidate result candidateAuthorities.${index} invalid`);
          return;
        }
        const sourceFactRefs = Array.isArray(item.sourceFactRefs) ? item.sourceFactRefs : [];
        const identityClaimRefs = Array.isArray(item.identityClaimRefs) ? item.identityClaimRefs : [];
        if (sourceFactRefs.length === 0 || sourceFactRefs.some((rawRef) => {
          const ref = safeRecord(rawRef);
          return !ref || !hasExactKeys(ref, ["factId", "contentHash"]) || !isPortableId(ref.factId) || !isSha256Hex(ref.contentHash);
        }) || new Set(sourceFactRefs.map((ref) => safeRecord(ref)?.factId)).size !== sourceFactRefs.length) {
          errors.push(`authoritative capability candidate result candidateAuthorities.${index}.sourceFactRefs invalid`);
        }
        const sourceById = new Map(sourceFactRefs.map((ref) => [safeRecord(ref)?.factId, safeRecord(ref)]));
        if (identityClaimRefs.some((rawRef) => {
          const ref = safeRecord(rawRef);
          const source = ref ? sourceById.get(ref.sourceFactId) : undefined;
          return !ref || !hasExactKeys(ref, ["claimId", "contentHash", "sourceFactId", "sourceFactHash"])
            || typeof ref.claimId !== "string" || ref.claimId !== `claim-sha256-${String(ref.contentHash)}`
            || !isSha256Hex(ref.contentHash) || !isPortableId(ref.sourceFactId) || !isSha256Hex(ref.sourceFactHash)
            || !source || source.contentHash !== ref.sourceFactHash;
        }) || new Set(identityClaimRefs.map((ref) => safeRecord(ref)?.claimId)).size !== identityClaimRefs.length) {
          errors.push(`authoritative capability candidate result candidateAuthorities.${index}.identityClaimRefs invalid`);
        }
      });
      const ids = result.candidateAuthorities.map((item) => safeRecord(item)?.subjectSkuId);
      if (new Set(ids).size !== ids.length || ids.length !== candidates.length) {
        errors.push("authoritative capability candidate result candidate authority subjects must exactly cover candidates");
      }
    }
    return errors;
  } catch {
    return ["authoritative capability candidate result is inaccessible or invalid"];
  }
}

export async function verifyAuthoritativeCapabilityCandidateResult(value: unknown): Promise<boolean> {
  if (validateAuthoritativeCapabilityCandidateResult(value).length) return false;
  const result = value as AuthoritativeCapabilityCandidateResult;
  if (!(await Promise.all(result.capabilityRecords.map(verifyCapabilityRecord))).every(Boolean)) return false;
  if (!await verifyRequirementCapabilityIndex(result.index)) return false;
  const replay = await queryRequirementCapabilityIndex(result.index, {
    factSnapshotRef: result.factSnapshotRef,
    componentKindId: result.query.componentKindId,
    predicates: result.query.predicates,
  }).catch(() => null);
  return replay !== null && canonicalize(replay) === canonicalize(result.candidates)
    && result.contentHash === await hashContent(resultMaterial(result), CONTRACT);
}

export function assertCapabilityCandidatesMatchEvaluationLock(
  result: AuthoritativeCapabilityCandidateResult,
  snapshotHashes: SnapshotHashes,
): void {
  if (!isSnapshotHashes(snapshotHashes) || validateAuthoritativeCapabilityCandidateResult(result).length
    || result.factSnapshotRef.contentHash !== snapshotHashes.factSnapshotHash) {
    throw new Error("capability candidates do not match the authoritative evaluation fact snapshot");
  }
}

export class AuthoritativeCapabilityCandidateService {
  readonly authorityKind = "authoritative-capability-candidate-service-v1" as const;

  constructor(private readonly options: {
    coordinator: RuntimeCoordinator;
    authority: RootBoundCapabilityIndexAuthority;
  }) {
    if (!options.authority || options.authority.authorityKind !== "root-bound-capability-index-authority-v1") {
      throw new TypeError("root-bound capability index authority is required");
    }
    if (typeof options.authority.getFactAtRoot !== "function" || typeof options.authority.getEvidenceClaimAtRoot !== "function") {
      throw new TypeError("root-bound fact and EvidenceClaim authorities are required");
    }
    authoritativeCandidateServices.add(this);
  }

  async query(request: AuthoritativeCapabilityCandidateRequest): Promise<AuthoritativeCapabilityCandidateResult> {
    const errors = validateRequest(request);
    if (errors.length) throw new TypeError(`Invalid capability candidate request: ${errors.join("; ")}`);
    const { state, result } = await this.options.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number; revision: number };
      activeRoot: string;
    }) => (
      this.queryAtRoot(activeRoot, state.runtimeGeneration, state.revision, request)
    ));
    if (result.runtimeGeneration !== state.runtimeGeneration || result.runtimeRevision !== state.revision) {
      throw new Error("capability candidate result runtime binding changed");
    }
    return result;
  }

  async queryAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    runtimeRevision: number,
    request: AuthoritativeCapabilityCandidateRequest,
  ): Promise<AuthoritativeCapabilityCandidateResult> {
    const errors = validateRequest(request);
    if (errors.length) throw new TypeError(`Invalid capability candidate request: ${errors.join("; ")}`);
    if (!Number.isInteger(runtimeGeneration) || runtimeGeneration <= 0 || !Number.isInteger(runtimeRevision) || runtimeRevision < 0) {
      throw new TypeError("runtime generation/revision invalid");
    }
    const closure = structuredClone(await this.options.authority.resolveAtRoot(
      activeRoot,
      request.planId,
      request.expectedFactSnapshotHash,
    ));
    if (!closure || closure.planId !== request.planId || !Array.isArray(closure.capabilityRecords)) {
      throw new Error("capability index authority crossed plan ownership");
    }
    const factSnapshotRef = capabilityFactSnapshotRef(closure.factSnapshot);
    if (request.expectedFactSnapshotHash !== undefined && request.expectedFactSnapshotHash !== factSnapshotRef.contentHash) {
      throw new Error("capability candidate fact snapshot conflict");
    }
    const index: RequirementCapabilityIndex = await buildRequirementCapabilityIndex(closure.capabilityRecords, closure.factSnapshot);
    if (!await verifyRequirementCapabilityIndex(index)) throw new Error("capability index authority produced a corrupt index");
    const candidates = await queryRequirementCapabilityIndex(index, {
      factSnapshotRef,
      componentKindId: request.componentKindId,
      predicates: structuredClone(request.predicates),
    });
    const snapshotFactById = new Map(closure.factSnapshot.factRefs.map((ref) => [ref.factId, ref]));
    const candidateAuthorities = await Promise.all(candidates.map(async (candidate) => {
      const sourceFactIds = [...new Set(candidate.facets.flatMap((facet) => facet.sourceFactIds))].sort(compareCanonical);
      const sourceFacts = await Promise.all(sourceFactIds.map(async (factId) => {
        const snapshotRef = snapshotFactById.get(factId);
        const fact = await this.options.authority.getFactAtRoot(activeRoot, factId);
        if (!snapshotRef || !fact || fact.factId !== factId || fact.contentHash !== snapshotRef.contentHash
          || !await verifyFactRecord(fact) || fact.subject.kind !== "product" || fact.subject.skuId !== candidate.subjectSkuId) {
          throw new Error("capability candidate source fact closure is missing, corrupt, or cross-subject");
        }
        return fact;
      }));
      const identityClaimRefs: AuthoritativeCapabilityCandidateResultMaterial["candidateAuthorities"][number]["identityClaimRefs"] = [];
      for (const fact of sourceFacts) {
        for (const claimId of fact.evidenceRefs.filter((ref) => /^claim-sha256-[a-f0-9]{64}$/.test(ref)).sort(compareCanonical)) {
          const claim = await this.options.authority.getEvidenceClaimAtRoot(activeRoot, claimId);
          const evaluatedAt = Date.parse(closure.factSnapshot.createdAt);
          const validFrom = claim?.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(claim.validFrom);
          const validUntil = claim?.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(claim.validUntil);
          if (!claim || claim.claimId !== claimId || !await verifyEvidenceClaim(claim) || claim.status !== "active"
            || claim.subject.skuId !== candidate.subjectSkuId || claim.fieldId !== fact.field || claim.scope !== fact.scope
            || fact.subject.kind !== "product" || claim.authority !== fact.authority
            || canonicalize(claim.subject) !== canonicalize(productSubjectMaterial(fact.subject))
            || canonicalize(claim.value) !== canonicalize(fact.value) || claim.unit !== fact.unit
            || Date.parse(claim.retrievedAt) > evaluatedAt || validFrom > evaluatedAt || validUntil < evaluatedAt) {
            throw new Error("capability candidate EvidenceClaim closure is missing, stale, or mismatched");
          }
          identityClaimRefs.push({
            claimId: claim.claimId,
            contentHash: claim.contentHash,
            sourceFactId: fact.factId,
            sourceFactHash: fact.contentHash,
          });
        }
      }
      identityClaimRefs.sort((left, right) => compareCanonical(left.claimId, right.claimId));
      return {
        subjectSkuId: candidate.subjectSkuId,
        capabilityRecordHash: candidate.capabilityRecordHash,
        sourceFactRefs: sourceFacts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash }))
          .sort((left, right) => compareCanonical(left.factId, right.factId)),
        identityClaimRefs,
      };
    }));
    const material: AuthoritativeCapabilityCandidateResultMaterial = {
      schemaVersion: "authoritative-capability-candidates-v1",
      planId: request.planId,
      runtimeGeneration,
      runtimeRevision,
      factSnapshotRef,
      capabilityRecords: structuredClone(closure.capabilityRecords)
        .sort((left, right) => compareCanonical(left.contentHash, right.contentHash)),
      index: structuredClone(index),
      indexHash: index.contentHash,
      query: { componentKindId: request.componentKindId, predicates: structuredClone(request.predicates) },
      candidates,
      candidateAuthorities,
    };
    const result: AuthoritativeCapabilityCandidateResult = {
      ...material,
      contentHash: await hashContent(material, CONTRACT),
    };
    if (!await verifyAuthoritativeCapabilityCandidateResult(result)) throw new Error("capability candidate result could not be verified");
    return deepFreeze(result) as AuthoritativeCapabilityCandidateResult;
  }
}

/** Object-identity gate; a caller cannot satisfy solver authority with JSON. */
export function assertAuthoritativeCapabilityCandidateService(
  value: unknown,
): asserts value is AuthoritativeCapabilityCandidateService {
  if (!value || typeof value !== "object" || !authoritativeCandidateServices.has(value as object)
    || (value as Partial<AuthoritativeCapabilityCandidateService>).authorityKind !== "authoritative-capability-candidate-service-v1") {
    throw new TypeError("server-issued authoritative capability candidate service is required");
  }
}

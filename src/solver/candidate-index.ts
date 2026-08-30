import type { ComponentKindId, GovernedFacetPredicate } from "../contracts/registries";
import { canonicalize, hashContent, type SnapshotHashes } from "../hash";
import type { RequirementCapabilityIndexEntry } from "../capabilities/requirement-index";
import type { CapabilityRecord } from "../capabilities/facets";
import {
  AuthoritativeCapabilityCandidateService,
  assertAuthoritativeCapabilityCandidateService,
  assertCapabilityCandidatesMatchEvaluationLock,
  verifyAuthoritativeCapabilityCandidateResult,
  type AuthoritativeCapabilityCandidateResult,
} from "./capability-candidates";

/**
 * Solver-facing requirement projection. Compatibility/requirement engines own
 * the semantics; the solver receives only a governed component kind and
 * allowlisted facet predicates.
 */
export interface SolverComponentRequirement {
  requirementId: string;
  componentKindId: ComponentKindId;
  role: string;
  predicates: GovernedFacetPredicate[];
  quantity: number;
  hardConstraintIds: string[];
  /** Existing instances that already satisfy this requirement. */
  satisfiedByInstanceIds?: string[];
}

export interface SolverIndexedCandidate extends RequirementCapabilityIndexEntry {
  requirementId: string;
  indexHash: string;
  factSnapshotRef: { snapshotId: string; contentHash: string };
  sourceFactRefs: Array<{ factId: string; contentHash: string }>;
  identityClaimRefs: Array<{
    claimId: string;
    contentHash: string;
    sourceFactId: string;
    sourceFactHash: string;
  }>;
  identityClaimIds: string[];
}

export interface SolverRequirementCandidatePool {
  requirement: SolverComponentRequirement;
  candidates: SolverIndexedCandidate[];
  source: {
    indexHash: string;
    factSnapshotRef: { snapshotId: string; contentHash: string };
    runtimeGeneration: number;
    /** Exact complete record set from which the authoritative index was built. */
    capabilityRecordHashes: string[];
  };
  truncated: boolean;
  /** Matching SKUs withheld because exact EvidenceClaim identity closure is unavailable. */
  blockedIdentitySkuIds: string[];
}

export interface SolverCandidateIndex {
  schemaVersion: "solver-candidate-index-v1";
  planId: string;
  factSnapshotRef: { snapshotId: string; contentHash: string };
  capabilityRecords: CapabilityRecord[];
  pools: SolverRequirementCandidatePool[];
  contentHash: string;
}

type SolverCandidateIndexMaterial = Omit<SolverCandidateIndex, "contentHash">;
const INDEX_HASH_CONTRACT = Object.freeze({ domain: "artifact.rule-set", schemaVersion: "1.0.0" } as const);

export function solverCandidateIndexMaterial(index: SolverCandidateIndex): SolverCandidateIndexMaterial {
  return {
    schemaVersion: index.schemaVersion,
    planId: index.planId,
    factSnapshotRef: structuredClone(index.factSnapshotRef),
    capabilityRecords: structuredClone(index.capabilityRecords),
    pools: structuredClone(index.pools),
  };
}

export async function solverCandidateIndexContentHash(index: SolverCandidateIndexMaterial | SolverCandidateIndex): Promise<string> {
  const material = "contentHash" in index ? solverCandidateIndexMaterial(index) : index;
  return hashContent(material, INDEX_HASH_CONTRACT);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeSolverComponentRequirement(requirement: SolverComponentRequirement): SolverComponentRequirement {
  if (!requirement.requirementId.trim() || !requirement.role.trim()) {
    throw new TypeError("solver component requirement identity is missing");
  }
  if (!Number.isSafeInteger(requirement.quantity) || requirement.quantity < 0) {
    throw new TypeError(`solver requirement ${requirement.requirementId} quantity is invalid`);
  }
  if (!Array.isArray(requirement.predicates) || !Array.isArray(requirement.hardConstraintIds)) {
    throw new TypeError(`solver requirement ${requirement.requirementId} predicates/constraints are invalid`);
  }
  const hardConstraintIds = [...requirement.hardConstraintIds]
    .map((id) => id.normalize("NFC"))
    .sort(compareText);
  if (hardConstraintIds.some((id) => !id) || new Set(hardConstraintIds).size !== hardConstraintIds.length) {
    throw new TypeError(`solver requirement ${requirement.requirementId} hard constraint IDs are invalid`);
  }
  const satisfiedByInstanceIds = [...(requirement.satisfiedByInstanceIds ?? [])]
    .map((id) => id.normalize("NFC"))
    .sort(compareText);
  if (satisfiedByInstanceIds.some((id) => !id) || new Set(satisfiedByInstanceIds).size !== satisfiedByInstanceIds.length) {
    throw new TypeError(`solver requirement ${requirement.requirementId} satisfying instance IDs are invalid`);
  }
  return {
    requirementId: requirement.requirementId.normalize("NFC"),
    componentKindId: requirement.componentKindId,
    role: requirement.role.normalize("NFC"),
    predicates: structuredClone(requirement.predicates)
      .sort((left, right) => compareText(canonicalize(left), canonicalize(right))),
    quantity: requirement.quantity,
    hardConstraintIds,
    ...(satisfiedByInstanceIds.length ? { satisfiedByInstanceIds } : {}),
  };
}

function projectCandidates(
  result: AuthoritativeCapabilityCandidateResult,
  requirementId: string,
): { candidates: SolverIndexedCandidate[]; blockedIdentitySkuIds: string[] } {
  const identityBySku = new Map(result.candidateAuthorities.map((item) => [item.subjectSkuId, item]));
  const blockedIdentitySkuIds: string[] = [];
  const candidates = result.candidates.flatMap((entry) => {
    const identity = identityBySku.get(entry.subjectSkuId);
    if (!identity || identity.capabilityRecordHash !== entry.capabilityRecordHash || identity.identityClaimRefs.length === 0) {
      blockedIdentitySkuIds.push(entry.subjectSkuId);
      return [];
    }
    return [{
    ...structuredClone(entry),
    requirementId,
    indexHash: result.indexHash,
    factSnapshotRef: structuredClone(result.factSnapshotRef),
    sourceFactRefs: structuredClone(identity.sourceFactRefs),
    identityClaimRefs: structuredClone(identity.identityClaimRefs),
    identityClaimIds: identity.identityClaimRefs.map((ref) => ref.claimId),
  }];
  }).sort((left, right) => compareText(left.subjectSkuId, right.subjectSkuId)
    || compareText(left.capabilityRecordHash, right.capabilityRecordHash));
  return { candidates, blockedIdentitySkuIds: blockedIdentitySkuIds.sort(compareText) };
}

/**
 * Builds all pools exclusively through the root-bound capability service. A
 * result from another FactSnapshot is rejected even when its content is
 * otherwise valid. Truncation is explicit so it can never support an unsat
 * proof.
 */
export async function buildSolverCandidateIndex(input: {
  planId: string;
  requirements: readonly SolverComponentRequirement[];
  snapshotHashes: SnapshotHashes;
  maxCandidatesPerRequirement: number;
  service: AuthoritativeCapabilityCandidateService;
}): Promise<SolverCandidateIndex> {
  if (!input.planId.trim()) throw new TypeError("solver candidate index planId is missing");
  assertAuthoritativeCapabilityCandidateService(input.service);
  if (!Number.isSafeInteger(input.maxCandidatesPerRequirement) || input.maxCandidatesPerRequirement < 1) {
    throw new TypeError("solver candidate index limit is invalid");
  }
  const requirements = input.requirements.map(normalizeSolverComponentRequirement)
    .sort((left, right) => compareText(left.requirementId, right.requirementId));
  if (new Set(requirements.map((item) => item.requirementId)).size !== requirements.length) {
    throw new TypeError("solver component requirement IDs must be unique");
  }
  const pools: SolverRequirementCandidatePool[] = [];
  const capabilityRecords = new Map<string, CapabilityRecord>();
  for (const requirement of requirements) {
    const result = await input.service.query({
      planId: input.planId,
      componentKindId: requirement.componentKindId,
      predicates: structuredClone(requirement.predicates),
      expectedFactSnapshotHash: input.snapshotHashes.factSnapshotHash,
    });
    if (!await verifyAuthoritativeCapabilityCandidateResult(result)) {
      throw new Error(`authoritative candidate result for ${requirement.requirementId} is invalid`);
    }
    if (result.planId !== input.planId || result.query.componentKindId !== requirement.componentKindId
      || canonicalize(result.query.predicates) !== canonicalize(requirement.predicates)) {
      throw new Error(`authoritative candidate result for ${requirement.requirementId} crossed its exact plan/query authority`);
    }
    assertCapabilityCandidatesMatchEvaluationLock(result, input.snapshotHashes);
    for (const record of result.capabilityRecords) {
      const previous = capabilityRecords.get(record.contentHash);
      if (previous && canonicalize(previous) !== canonicalize(record)) {
        throw new Error("solver candidate pools disagreed on capability record bytes");
      }
      capabilityRecords.set(record.contentHash, structuredClone(record));
    }
    const projected = projectCandidates(result, requirement.requirementId);
    const allCandidates = projected.candidates;
    pools.push({
      requirement,
      candidates: allCandidates.slice(0, input.maxCandidatesPerRequirement),
      source: {
        indexHash: result.indexHash,
        factSnapshotRef: structuredClone(result.factSnapshotRef),
        runtimeGeneration: result.runtimeGeneration,
        capabilityRecordHashes: result.index.entries.map((entry) => entry.capabilityRecordHash).sort(compareText),
      },
      truncated: allCandidates.length > input.maxCandidatesPerRequirement,
      blockedIdentitySkuIds: projected.blockedIdentitySkuIds,
    });
  }
  if (pools.some((pool) => pool.source.factSnapshotRef.contentHash !== input.snapshotHashes.factSnapshotHash)) {
    throw new Error("solver candidate pools crossed FactSnapshot authority");
  }
  if (pools.some((pool) => pool.source.runtimeGeneration !== pools[0]?.source.runtimeGeneration)) {
    throw new Error("solver candidate pools crossed runtime-generation authority");
  }
  if (pools.some((pool) => pool.source.indexHash !== pools[0]?.source.indexHash
    || canonicalize(pool.source.capabilityRecordHashes) !== canonicalize(pools[0]?.source.capabilityRecordHashes))) {
    throw new Error("solver candidate pools crossed capability-index authority");
  }
  const material: SolverCandidateIndexMaterial = {
    schemaVersion: "solver-candidate-index-v1",
    planId: input.planId.normalize("NFC"),
    factSnapshotRef: pools[0]?.source.factSnapshotRef ?? {
      snapshotId: `fact-snapshot-sha256-${input.snapshotHashes.factSnapshotHash}`,
      contentHash: input.snapshotHashes.factSnapshotHash,
    },
    capabilityRecords: [...capabilityRecords.values()]
      .sort((left, right) => compareText(left.contentHash, right.contentHash)),
    pools: structuredClone(pools),
  };
  return Object.freeze({ ...material, contentHash: await solverCandidateIndexContentHash(material) });
}

/** Number still required after explicitly satisfying instances are conserved. */
export function residualRequirementQuantity(requirement: SolverComponentRequirement): number {
  return Math.max(0, requirement.quantity - (requirement.satisfiedByInstanceIds?.length ?? 0));
}

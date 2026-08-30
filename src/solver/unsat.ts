import { canonicalize, sha256Hex, type SnapshotHashes } from "../hash";
import type { UnsatProof } from "./contracts";
import type { SolverCandidateIndex } from "./candidate-index";

export interface SolverSearchRejection {
  assignmentHash: string;
  hardConstraintIds: string[];
  evaluationReceiptRef?: string;
}

export interface ExhaustiveUnsatMaterial {
  schemaVersion: "solver-exhaustive-unsat-material-v1";
  solverVersion: string;
  seed: string;
  basePlanVersionId: string;
  baseSnapshotHashes: SnapshotHashes;
  candidateIndex: SolverCandidateIndex;
  totalAssignments: number;
  exploredAssignmentHashes: string[];
  rejections: SolverSearchRejection[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Domain-separated, deterministic exhaustive search-space proof hash. */
export async function exhaustiveSearchSpaceHash(material: ExhaustiveUnsatMaterial): Promise<string> {
  if (!Number.isSafeInteger(material.totalAssignments) || material.totalAssignments < 0) {
    throw new TypeError("unsat proof totalAssignments is invalid");
  }
  if (material.exploredAssignmentHashes.length !== material.totalAssignments
    || new Set(material.exploredAssignmentHashes).size !== material.exploredAssignmentHashes.length) {
    throw new Error("unsat proof does not enumerate the complete search space exactly once");
  }
  if (material.candidateIndex.pools.some((pool) => pool.truncated || pool.blockedIdentitySkuIds.length > 0)) {
    throw new Error("a truncated or identity-blocked capability candidate pool cannot support unsat_proven");
  }
  const explored = [...material.exploredAssignmentHashes].sort(compareText);
  const rejected = new Set(material.rejections.map((item) => item.assignmentHash));
  if (explored.some((hash) => !rejected.has(hash))) {
    throw new Error("unsat proof is missing an authoritative rejection for an explored assignment");
  }
  return sha256Hex(`buildsim\0solver-exhaustive-unsat-v1\0${canonicalize({
    ...material,
    exploredAssignmentHashes: explored,
    rejections: [...material.rejections].map((item) => ({
      ...item,
      hardConstraintIds: [...item.hardConstraintIds].sort(compareText),
    })).sort((left, right) => compareText(left.assignmentHash, right.assignmentHash)),
  })}`);
}

export async function createExhaustiveUnsatProof(material: ExhaustiveUnsatMaterial): Promise<UnsatProof> {
  return { kind: "exhaustive", exploredSearchSpaceHash: await exhaustiveSearchSpaceHash(material) };
}

/**
 * Only singleton empty-pool conflicts are intrinsically irreducible here.
 * Larger evaluator conflicts are returned as unsatisfied IDs unless a formal
 * minimization layer proves them elsewhere.
 */
export function provenSingletonConflictSets(index: SolverCandidateIndex): string[][] {
  return index.pools
    .filter((pool) => pool.candidates.length === 0 && pool.blockedIdentitySkuIds.length === 0
      && pool.requirement.quantity > (pool.requirement.satisfiedByInstanceIds?.length ?? 0))
    .flatMap((pool) => pool.requirement.hardConstraintIds.length
      ? pool.requirement.hardConstraintIds.map((id) => [id])
      : [[pool.requirement.requirementId]])
    .sort((left, right) => compareText(left[0]!, right[0]!));
}

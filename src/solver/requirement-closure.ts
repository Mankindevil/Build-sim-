import {
  computeRequirementClosure,
  type RequirementClosureInput,
  type RequirementClosureResult,
} from "../requirements/closure";
import type { RequirementNode } from "../requirements/contracts";

export {
  computeRequirementClosure,
  type RequirementClosureEdge,
  type RequirementClosureInput,
  type RequirementClosureResult,
  type RequirementClosureRule,
  type RequirementClosureRuleRef,
  type RequirementClosureSnapshot,
  type RequirementDerivation,
} from "../requirements/closure";

export interface SolverRequirementClosureProjection {
  schemaVersion: "solver-requirement-closure-projection-v1";
  closureRefHash: string;
  requirements: RequirementNode[];
  blockedRequirementIds: string[];
  cyclePaths: string[][];
  readyForSearch: boolean;
}

/**
 * U6 has one fixed-point/cycle implementation. This solver entry point is a
 * compatibility alias to the requirements-domain implementation, not a second
 * closure algorithm.
 */
export function closeRequirements(input: RequirementClosureInput): RequirementClosureResult {
  return computeRequirementClosure(input);
}

/** Search-specific read-only projection of the authoritative closure. */
export function projectRequirementClosureForSearch(
  closure: RequirementClosureResult,
): SolverRequirementClosureProjection {
  return Object.freeze({
    schemaVersion: "solver-requirement-closure-projection-v1",
    closureRefHash: closure.contentHash,
    requirements: structuredClone(closure.requirements),
    blockedRequirementIds: [...closure.blockedRequirementIds],
    cyclePaths: structuredClone(closure.cycles),
    readyForSearch: closure.reachedFixedPoint && closure.blockedRequirementIds.length === 0,
  });
}

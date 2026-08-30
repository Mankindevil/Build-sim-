import type { RequirementNode } from "./contracts";
import { computeRequirementClosureRuntime } from "./runtime.mjs";

export interface RequirementClosureEdge {
  fromRequirementId: string;
  toRequirementId: string;
  ruleId: string;
  ruleVersion: string;
}

export interface RequirementClosureRuleRef {
  ruleId: string;
  ruleVersion: string;
}

export interface RequirementDerivation {
  requirement: RequirementNode;
  /** Defaults to the requirement passed to `expand`. */
  parentRequirementIds?: readonly string[];
}

export interface RequirementClosureSnapshot {
  iteration: number;
  requirements: readonly RequirementNode[];
  edges: readonly RequirementClosureEdge[];
}

/**
 * A governed rule is executable code identified by an immutable rule/version
 * pair. The result persists only those identities and derived JSON, never the
 * callback itself.
 */
export interface RequirementClosureRule {
  ruleId: string;
  ruleVersion: string;
  expand(
    requirement: Readonly<RequirementNode>,
    snapshot: Readonly<RequirementClosureSnapshot>,
  ): readonly (RequirementNode | RequirementDerivation)[];
}

export interface RequirementClosureInput {
  roots: readonly RequirementNode[];
  rules: readonly RequirementClosureRule[];
  maxIterations?: number;
  maxRequirements?: number;
}

export interface RequirementClosureResult {
  schemaVersion: "requirement-closure-v1";
  rootRequirementIds: string[];
  requirements: RequirementNode[];
  edges: RequirementClosureEdge[];
  cycles: string[][];
  iterations: number;
  reachedFixedPoint: boolean;
  blockedRequirementIds: string[];
  ruleRefs: RequirementClosureRuleRef[];
  contentHash: string;
}

/**
 * Run candidate-induced requirements to a deterministic fixed point. The
 * implementation lives in runtime.mjs so TS, graph replay, Doctor, and restore
 * all execute one fixed-point/cycle authority.
 */
export function computeRequirementClosure(input: RequirementClosureInput): RequirementClosureResult {
  return computeRequirementClosureRuntime(input) as RequirementClosureResult;
}

export const closeRequirements = computeRequirementClosure;
export const deriveRequirementClosure = computeRequirementClosure;

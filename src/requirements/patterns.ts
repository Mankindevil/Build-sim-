import {
  deriveAssemblyResourceNeeds,
  verifyAssemblyResourcePattern,
  type AssemblyNeedKind,
  type AssemblyResourcePattern,
  type ResourceFacetPredicate,
} from "../assembly/resources";
import type { GovernedFacetPredicate } from "../contracts/registries";
import type { RequirementKind, RequirementNode } from "./contracts";
import type { RequirementClosureRule } from "./closure";
import { validateRequirementNodeRuntime } from "./runtime.mjs";

export interface AssemblyResourcePatternProjectionInput {
  pattern: AssemblyResourcePattern;
  ownerInstanceId: string;
  /** Concrete placed component(s) that consume the owner-scoped resource. */
  targetInstanceIds: readonly string[];
  mountStandardId: string;
  neededByStepId: string;
  requirementIdPrefix: string;
  region?: string;
  revision?: string;
}

export interface AssemblyResourcePatternRuleInput extends AssemblyResourcePatternProjectionInput {
  triggerRequirementIds: readonly string[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value === value.normalize("NFC") && !/\s|[\u0000-\u001f\u007f]/u.test(value);
}

function requirementKind(kind: AssemblyNeedKind): RequirementKind {
  return kind === "standoff" || kind === "bracket" || kind === "adapter" ? "accessory" : kind;
}

function governedPredicate(predicate: ResourceFacetPredicate): GovernedFacetPredicate {
  return {
    facetId: predicate.facetId,
    operator: predicate.operator,
    value: Array.isArray(predicate.value) ? [...predicate.value] as [number, number] : predicate.value,
    ...(predicate.facetId === "fastener.length_mm" ? { unitId: "mm" } : {}),
  } as GovernedFacetPredicate;
}

/**
 * Project one locked adapter mount pattern into ordinary RequirementNode roots.
 * The pattern hash itself is the governed rule version used by closure replay.
 */
export async function projectAssemblyResourcePatternRequirements(
  input: AssemblyResourcePatternProjectionInput,
): Promise<RequirementNode[]> {
  if (!portableId(input.ownerInstanceId)) throw new TypeError("assembly pattern ownerInstanceId invalid");
  if (!Array.isArray(input.targetInstanceIds) || input.targetInstanceIds.length === 0
    || input.targetInstanceIds.some((instanceId) => !portableId(instanceId))
    || new Set(input.targetInstanceIds).size !== input.targetInstanceIds.length) {
    throw new TypeError("assembly pattern targetInstanceIds invalid");
  }
  if (!await verifyAssemblyResourcePattern(input.pattern)) throw new TypeError("assembly resource pattern invalid or content hash mismatch");
  const needs = await deriveAssemblyResourceNeeds(input.pattern, {
    mountStandardId: input.mountStandardId,
    neededByStepId: input.neededByStepId,
    requirementIdPrefix: input.requirementIdPrefix,
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
  });
  return needs.map((need) => {
    const requirement: RequirementNode = {
      requirementId: need.needId,
      kind: requirementKind(need.kind),
      predicates: need.specification.map(governedPredicate),
      quantity: need.quantity,
      criticality: need.criticality,
      requiredBefore: need.requiredBefore,
      producedBy: {
        ruleId: `assembly.resource-pattern.${input.pattern.patternId}`,
        ruleVersion: input.pattern.contentHash,
        instanceIds: [...new Set([input.ownerInstanceId, ...input.targetInstanceIds])].sort(compare),
      },
      evidenceRefs: [...need.evidenceFactIds].sort(compare),
    };
    const errors = validateRequirementNodeRuntime(requirement);
    if (errors.length) throw new TypeError(`projected assembly requirement invalid: ${errors.join("; ")}`);
    return requirement;
  }).sort((left, right) => compare(left.requirementId, right.requirementId));
}

/**
 * Build a closure rule for candidate-driven expansion. Callers supply exact
 * trigger requirement IDs; an unrelated component can never activate a mount pattern.
 */
export async function createAssemblyResourcePatternClosureRule(
  input: AssemblyResourcePatternRuleInput,
): Promise<RequirementClosureRule> {
  const triggers = [...input.triggerRequirementIds].sort(compare);
  if (triggers.length === 0 || triggers.some((id) => !portableId(id)) || new Set(triggers).size !== triggers.length) {
    throw new TypeError("assembly resource pattern triggerRequirementIds invalid");
  }
  const projected = await projectAssemblyResourcePatternRequirements(input);
  const triggerSet = new Set(triggers);
  return Object.freeze({
    ruleId: `assembly.resource-pattern.${input.pattern.patternId}`,
    ruleVersion: input.pattern.contentHash,
    expand(requirement: Readonly<RequirementNode>) {
      if (!triggerSet.has(requirement.requirementId)) return [];
      return projected.map((node) => ({ requirement: structuredClone(node), parentRequirementIds: [requirement.requirementId] }));
    },
  });
}

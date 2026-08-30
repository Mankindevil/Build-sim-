import type { GovernedFacetPredicate } from "../contracts/registries";
import type {
  EvaluationDecision,
  RequirementKind,
  RequirementNode,
} from "../requirements/contracts";
import type { CompatibilityDomain, RuleSafetyClass } from "./contracts";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function token(value: string): string {
  const normalized = value.normalize("NFC").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "item";
}

export interface RequirementDraftInput {
  ruleId: string;
  ruleVersion: string;
  discriminator: string;
  kind: RequirementKind;
  predicates?: GovernedFacetPredicate[];
  quantity?: number;
  criticality: RequirementNode["criticality"];
  requiredBefore?: RequirementNode["requiredBefore"];
  instanceIds?: string[];
  evidenceRefs?: string[];
}

export function compatibilityRequirement(input: RequirementDraftInput): RequirementNode {
  return {
    requirementId: `requirement-${token(input.ruleId)}-${token(input.discriminator)}`,
    kind: input.kind,
    predicates: [...(input.predicates ?? [])].sort((left, right) => compare(
      `${left.facetId}\0${left.operator}\0${JSON.stringify(left.value)}\0${left.unitId ?? ""}`,
      `${right.facetId}\0${right.operator}\0${JSON.stringify(right.value)}\0${right.unitId ?? ""}`,
    )),
    quantity: input.quantity ?? 1,
    criticality: input.criticality,
    ...(input.requiredBefore !== undefined ? { requiredBefore: input.requiredBefore } : {}),
    producedBy: {
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion,
      instanceIds: [...new Set(input.instanceIds ?? [])].sort(compare),
    },
    evidenceRefs: [...new Set(input.evidenceRefs ?? [])].sort(compare),
  };
}

export interface DecisionDraftInput {
  ruleId: string;
  ruleVersion: string;
  discriminator: string;
  verdict: EvaluationDecision["verdict"];
  domain: CompatibilityDomain;
  message: string;
  instanceIds?: string[];
  factIds?: string[];
  assumptions?: string[];
  remediation?: RequirementNode[];
}

export function compatibilityDecision(input: DecisionDraftInput): EvaluationDecision {
  return {
    decisionId: `decision-${token(input.ruleId)}-${token(input.discriminator)}`,
    verdict: input.verdict,
    domain: input.domain,
    message: input.message.normalize("NFC"),
    instanceIds: [...new Set(input.instanceIds ?? [])].sort(compare),
    factIds: [...new Set(input.factIds ?? [])].sort(compare),
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    assumptions: [...new Set(input.assumptions ?? [])].sort(compare),
    remediation: [...(input.remediation ?? [])].sort((left, right) => compare(left.requirementId, right.requirementId)),
  };
}

export function requirementCriticalityForRule(safetyClass: RuleSafetyClass): RequirementNode["criticality"] {
  return safetyClass === "electrical_safety" ? "safety" : safetyClass === "boot" ? "boot" : "normal";
}

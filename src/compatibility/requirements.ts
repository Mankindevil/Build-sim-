import type { ComponentKindId } from "../contracts/registries";
import type { RequirementNode } from "../requirements/contracts";
import type {
  CompatibilityRuleDefinition,
  MissingRuleInput,
  RequiredComponentKindDeclaration,
  RequiredFactDeclaration,
  RuleSafetyClass,
} from "./contracts";
import { compatibilityRequirement, requirementCriticalityForRule } from "./explain";

function beforeForSafety(safetyClass: RuleSafetyClass): RequirementNode["requiredBefore"] | undefined {
  return safetyClass === "electrical_safety" ? "pre_power" : safetyClass === "boot" ? "first_boot" : undefined;
}

export function missingComponentRequirement(
  definition: CompatibilityRuleDefinition,
  declaration: RequiredComponentKindDeclaration,
  ordinal: number,
): RequirementNode {
  return compatibilityRequirement({
    ruleId: definition.ruleId,
    ruleVersion: definition.ruleVersion,
    discriminator: `component-${declaration.componentKind}-${ordinal}`,
    kind: "component",
    predicates: [{ facetId: "identity.category", operator: "eq", value: declaration.componentKind }],
    quantity: declaration.minCount,
    criticality: declaration.missing.criticality,
    ...(declaration.missing.requiredBefore !== undefined ? { requiredBefore: declaration.missing.requiredBefore } : {}),
  });
}

export function missingFactRequirement(
  definition: CompatibilityRuleDefinition,
  declaration: RequiredFactDeclaration,
  instanceId: string,
): RequirementNode {
  return compatibilityRequirement({
    ruleId: definition.ruleId,
    ruleVersion: definition.ruleVersion,
    discriminator: `fact-${declaration.field}-${instanceId}`,
    kind: declaration.missingRequirementKind,
    criticality: requirementCriticalityForRule(declaration.safetyClass),
    ...(beforeForSafety(declaration.safetyClass) !== undefined ? { requiredBefore: beforeForSafety(declaration.safetyClass) } : {}),
    instanceIds: [instanceId],
  });
}

export function missingTopologyRequirement(
  definition: CompatibilityRuleDefinition,
  kind: "placement" | "connection" | "system_profile",
  ref: string,
  instanceIds: string[],
): RequirementNode {
  const requirementKind = kind === "connection" ? "cable" : kind === "system_profile" ? "system_action" : "user_decision";
  return compatibilityRequirement({
    ruleId: definition.ruleId,
    ruleVersion: definition.ruleVersion,
    discriminator: `${kind}-${ref}`,
    kind: requirementKind,
    criticality: requirementCriticalityForRule(definition.safetyClass),
    ...(beforeForSafety(definition.safetyClass) !== undefined ? { requiredBefore: beforeForSafety(definition.safetyClass) } : {}),
    instanceIds,
  });
}

export function safetyRemediationForKnownFailure(
  definition: CompatibilityRuleDefinition,
  discriminator: string,
  instanceIds: string[],
  componentKind?: ComponentKindId,
): RequirementNode {
  return compatibilityRequirement({
    ruleId: definition.ruleId,
    ruleVersion: definition.ruleVersion,
    discriminator,
    kind: componentKind === "cable" ? "cable" : "component",
    ...(componentKind !== undefined ? { predicates: [{ facetId: "identity.category", operator: "eq", value: componentKind }] } : {}),
    criticality: requirementCriticalityForRule(definition.safetyClass),
    ...(beforeForSafety(definition.safetyClass) !== undefined ? { requiredBefore: beforeForSafety(definition.safetyClass) } : {}),
    instanceIds,
  });
}

export function missingInputKey(input: MissingRuleInput): string {
  return `${input.kind}\0${input.ref}\0${input.instanceIds.join("\0")}`;
}

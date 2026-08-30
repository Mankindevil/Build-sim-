import type { RequirementNode, RequirementSatisfaction } from "./contracts";
import type { RequirementClosureResult } from "./closure";

export interface RequirementExplanation {
  requirementId: string;
  status: RequirementSatisfaction["status"] | "unallocated";
  summary: string;
  producedBy: string;
  dependencyPath: string[];
  evidenceRefs: string[];
  residualQuantity: number;
}

function dependencyPath(closure: RequirementClosureResult, targetId: string): string[] {
  const roots = new Set(closure.rootRequirementIds);
  if (roots.has(targetId)) return [targetId];
  const incoming = new Map<string, string[]>();
  for (const edge of closure.edges) incoming.set(edge.toRequirementId, [...(incoming.get(edge.toRequirementId) ?? []), edge.fromRequirementId]);
  for (const parents of incoming.values()) parents.sort();
  const queue: Array<{ id: string; reversed: string[] }> = [{ id: targetId, reversed: [targetId] }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    for (const parent of incoming.get(current.id) ?? []) {
      const reversed = [...current.reversed, parent];
      if (roots.has(parent)) return reversed.reverse();
      queue.push({ id: parent, reversed });
    }
  }
  return [targetId];
}

export function explainRequirement(
  closure: RequirementClosureResult,
  requirement: RequirementNode,
  satisfaction?: RequirementSatisfaction,
): RequirementExplanation {
  const residual = satisfaction?.residualQuantity ?? requirement.quantity;
  const blockedByCycle = closure.blockedRequirementIds.includes(requirement.requirementId);
  const summary = blockedByCycle
    ? `${requirement.requirementId} is blocked by a cyclic or bounded closure dependency.`
    : residual === 0
      ? `${requirement.requirementId} is fully allocated (${requirement.quantity}/${requirement.quantity}).`
      : `${requirement.requirementId} still needs ${residual} of ${requirement.quantity}.`;
  return {
    requirementId: requirement.requirementId,
    status: satisfaction?.status ?? "unallocated",
    summary,
    producedBy: `${requirement.producedBy.ruleId}@${requirement.producedBy.ruleVersion}`,
    dependencyPath: dependencyPath(closure, requirement.requirementId),
    evidenceRefs: [...requirement.evidenceRefs].sort(),
    residualQuantity: residual,
  };
}

export function explainRequirementClosure(
  closure: RequirementClosureResult,
  satisfactions: readonly RequirementSatisfaction[] = [],
): RequirementExplanation[] {
  const byId = new Map(satisfactions.map((satisfaction) => [satisfaction.requirementId, satisfaction]));
  return closure.requirements.map((requirement) => explainRequirement(closure, requirement, byId.get(requirement.requirementId)));
}

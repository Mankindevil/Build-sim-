import {
  validateGovernedPatchOperation,
  type PatchValidationContext,
  type TopologyV3PatchOperation,
} from "../contracts/registries";
import { validateBuildConfigV3, type BuildConfigV3 } from "../topology/contracts";
import { normalizeBuildConfigV3 } from "../topology/normalize";
import { applyScenarioTopologyPatchRuntime, normalizeScenarioAuthorityValue, validateScenarioPatchAuthority } from "./runtime-validation.mjs";

export type ScenarioPatchErrorCode =
  | "invalid_base"
  | "invalid_operation"
  | "target_exists"
  | "target_missing"
  | "invalid_result";

export class ScenarioPatchError extends Error {
  constructor(readonly code: ScenarioPatchErrorCode, message: string) {
    super(message);
    this.name = "ScenarioPatchError";
  }
}

/**
 * Apply governed V3 operations in order against a clone. Stable selectors are
 * resolved at each step; array indexes are never part of the persisted patch.
 * Only the final topology is validated so one transaction can remove dependent
 * edges before removing their component.
 */
export function applyTopologyV3Patch(
  base: BuildConfigV3,
  operations: readonly TopologyV3PatchOperation[],
  context: PatchValidationContext = { actor: "user" },
): BuildConfigV3 {
  const baseErrors = validateBuildConfigV3(base);
  if (baseErrors.length) throw new ScenarioPatchError("invalid_base", `base config invalid: ${baseErrors.join("; ")}`);
  const normalizedOperations = operations.map((operation) => normalizeScenarioAuthorityValue(operation) as TopologyV3PatchOperation);
  normalizedOperations.forEach((operation, index) => {
    const errors = validateGovernedPatchOperation("plan-v3", operation, context);
    errors.push(...validateScenarioPatchAuthority([operation], undefined, context.actor));
    if (errors.length) throw new ScenarioPatchError("invalid_operation", `patch.${index}: ${errors.join("; ")}`);
  });
  let result: BuildConfigV3;
  try {
    result = applyScenarioTopologyPatchRuntime(normalizeBuildConfigV3(base), normalizedOperations) as BuildConfigV3;
  } catch (error) {
    const message = error instanceof Error ? error.message : "scenario patch replay failed";
    const code: ScenarioPatchErrorCode = message.includes("already exists") ? "target_exists"
      : message.includes("missing") ? "target_missing" : "invalid_operation";
    throw new ScenarioPatchError(code, message);
  }
  const resultErrors = validateBuildConfigV3(result);
  if (resultErrors.length) throw new ScenarioPatchError("invalid_result", `patched config invalid: ${resultErrors.join("; ")}`);
  return normalizeBuildConfigV3(result);
}

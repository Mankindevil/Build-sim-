import type {
  GovernedInferenceRuleExecutionContext,
  GovernedInferenceRuleExecutionResult,
} from "../inference-candidate-service";

export function executeGpuLengthClearanceV1(
  context: GovernedInferenceRuleExecutionContext,
): GovernedInferenceRuleExecutionResult;

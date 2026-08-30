export function evaluateAssemblySafetyRuntime(input: unknown): unknown;
export function assemblyResourceAssertionHashRuntime(value: unknown): string | null;
export function assemblyCheckAssertionHashRuntime(value: unknown): string | null;
export function evaluateAssemblySafety(input: unknown): unknown;
export function validateAssemblySafetyInput(value: unknown): string[];
export function validateAssemblySafetyEvaluationRuntime(value: unknown): string[];
export function projectVerifiedAssemblySuppliesRuntime(value: unknown): readonly unknown[] | null;
export function validateRequirementAllocationGeneratedSupplyClosureRuntime(
  value: unknown,
  context: { packageBindings: readonly unknown[]; assemblyEvaluations: readonly unknown[] },
): string[];
export function assemblySafetyReferencesRuntime(value: unknown): {
  instanceIds: readonly string[];
  factIds: readonly string[];
  observationIds: readonly string[];
  requirementIds: readonly string[];
} | null;

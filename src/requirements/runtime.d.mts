export function requirementArtifactContentHashRuntime(value: unknown, schemaVersion: unknown): string | null;
export function validateRequirementNodeRuntime(value: unknown): string[];
export interface RequirementClosureRuntimeRule {
  ruleId: string;
  ruleVersion: string;
  // Runtime intentionally accepts the caller's governed RequirementNode
  // specialization while retaining a JS-only implementation.
  expand(requirement: any, snapshot: any): readonly unknown[];
}
export function computeRequirementClosureRuntime(input: {
  roots: readonly unknown[];
  rules: readonly RequirementClosureRuntimeRule[];
  maxIterations?: number;
  maxRequirements?: number;
}): unknown;
export function validateRequirementClosureReplayRuntime(value: unknown, input: {
  roots: readonly unknown[];
  rules: readonly RequirementClosureRuntimeRule[];
  maxIterations?: number;
  maxRequirements?: number;
}): string[];
export function validateRequirementSatisfactionRuntime(requirement: unknown, satisfaction: unknown, checkpointRefs?: readonly unknown[]): string[];
export function validateRequirementClosureRuntime(value: unknown): string[];
export function validateRequirementAllocationResultRuntime(value: unknown): string[];
export function validateRequirementAllocationReplayRuntime(value: unknown, context: {
  blockedRequirementIds: readonly string[];
  checkpointBindings: readonly {
    checkpoint: unknown;
    context: {
      planVersionId: string;
      procedureId: string;
      expectedDependencyHash: string;
      expectedProcedureSafetyHash: string;
    };
  }[];
}): string[];
export function allocateRequirementSuppliesRuntime(requirements: unknown, supplies: unknown, options?: unknown): unknown;
export function validateRequirementAllocationPackageClosureRuntime(value: unknown, bindings: readonly {
  ownerInstanceId: string;
  manifest: unknown;
}[]): string[];
export function validateRequirementAllocationCheckpointClosureRuntime(value: unknown, bindings: readonly {
  checkpoint: unknown;
  context: {
    planVersionId: string;
    procedureId: string;
    expectedDependencyHash: string;
    expectedProcedureSafetyHash: string;
  };
}[]): string[];
export function validateRequirementReadinessRuntime(value: unknown, allocation: unknown): string[];
export function requirementClosureReferencesRuntime(value: unknown): {
  instanceIds: readonly string[];
  evidenceRefs: readonly string[];
  ruleRefs: readonly string[];
} | null;
export function requirementAllocationReferencesRuntime(value: unknown): {
  ownerInstanceIds: readonly string[];
  evidenceRefs: readonly string[];
  observationRefs: readonly string[];
  checkpointIds: readonly string[];
  blockedRequirementIds: readonly string[];
  checkpointRefs: readonly Readonly<{
    checkpointId: string;
    requirementId: string;
    planVersionId: string;
    procedureId: string;
    dependencyHash: string;
    procedureSafetyHash: string;
    confirmedAt: string;
    actor: "user";
  }>[];
  packageSupplyRefs: readonly Readonly<{
    ownerInstanceId: string;
    bundleItemId: string;
    manifestHash: string;
    instanceSupplyId: string;
    instanceSupplyHash: string;
    bundleItemHash: string;
    ownerSkuId: string;
  }>[];
  manifestHashes: readonly string[];
} | null;

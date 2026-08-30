export function validateCompatibilityRuleDefinitionRuntime(value: unknown): string[];
export function compatibilityRuleDefinitionHashRuntime(value: unknown): string | null;
export const BUILTIN_COMPATIBILITY_RULE_MANIFEST_HASH_RUNTIME: string;
export function compatibilityRuleManifestHashRuntime(value: unknown): string | null;
export function firmwareCapabilityTupleKeyRuntime(value: unknown): string | null;
export function firmwareExecutableFactIdsRuntime(evaluation: unknown, capability: unknown): readonly string[] | null;
export function firmwareExecutableFactAuthorityErrorsRuntime(
  evaluation: unknown,
  capability: unknown,
  facts: unknown,
): string[];
export function validateProgressiveBuildEvaluationRuntime(value: unknown): string[];
export function isProgressiveBuildEvaluationRuntime(value: unknown): boolean;
export function projectProgressivePriceRuntime(
  topologyBom: readonly unknown[],
  priceSnapshot: unknown,
): unknown | null;
export interface ProgressiveEvaluationAuthorityContextRuntime {
  evaluationLock: unknown;
  artifactLockfile: unknown;
  ruleSetPayload: unknown;
  enginePayload: unknown;
  adapterSnapshotPayload: unknown;
}
export function validateProgressiveBuildEvaluationAuthorityRuntime(
  value: unknown,
  context: ProgressiveEvaluationAuthorityContextRuntime,
): string[];
export function validateAssemblyObservationBindingsRuntime(
  evaluations: readonly unknown[],
  observationClosure: unknown,
  config: unknown,
  configHash: string,
): string[];
export interface ProgressiveEvaluationClosureContextRuntime {
  config: unknown;
  evaluationLock: unknown;
  artifactLockfile: unknown;
  ruleSetPayload: unknown;
  enginePayload: unknown;
  adapterSnapshotPayload: unknown;
  priceSnapshot: unknown;
  factClosure?: unknown;
  observationClosure?: unknown;
  firmwareCapabilities?: readonly unknown[];
  /** Raw repository/root-resolved path inputs; availableRequirementIds must be absent or empty. */
  firmwarePathInputs?: readonly unknown[];
  /** Static fixed-point roots reconstructed before firmware-derived requirements are selected. */
  firmwareFixedPointRootRequirements?: readonly unknown[];
  assemblySafetyInputs?: readonly unknown[];
  /** Exact roots reconstructed by the governed executor, not copied from the persisted closure. */
  requirementRoots?: readonly unknown[];
  checkpointBindings?: readonly {
    checkpoint: unknown;
    context: {
      planVersionId: string;
      procedureId: string;
      expectedDependencyHash: string;
      expectedProcedureSafetyHash: string;
    };
  }[];
}
export function validateProgressiveBuildEvaluationClosureRuntime(
  value: unknown,
  context: ProgressiveEvaluationClosureContextRuntime,
): string[];
export interface ProgressiveEvaluationReferencesRuntime {
  factIds: readonly string[];
  instanceIds: readonly string[];
  conflictSetIds: readonly string[];
  requirementIds: readonly string[];
  evidenceRefs: readonly string[];
  observationRefs: readonly string[];
  checkpointIds: readonly string[];
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
  authorityRefs: readonly string[];
  authorityHashes: readonly string[];
  firmwareCapabilityHashes: readonly string[];
  firmwareFactSnapshotRefs: readonly string[];
}
export function progressiveEvaluationReferencesRuntime(
  value: unknown,
  firmwareCapabilities?: readonly unknown[],
): ProgressiveEvaluationReferencesRuntime | null;

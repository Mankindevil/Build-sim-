export function firmwareCapabilityContentHashRuntime(value: unknown): string | null;
export function firmwarePathEvaluationContentHashRuntime(value: unknown): string | null;
export function firmwareRequirementIdRuntime(instanceId: unknown, sourceRequirementId: unknown): string | null;
export function projectFirmwareCandidateRequirementsRuntime(input: unknown): unknown[];
export function validateFirmwareCapabilityRuntime(value: unknown): string[];
export function verifyFirmwareCapabilityRuntime(value: unknown): boolean;
export function evaluateFirmwarePathRuntime(input: unknown): unknown;
export function validateFirmwarePathEvaluationRuntime(value: unknown, capability: unknown): string[];
export function validateFirmwarePathRequirementClosureRuntime(value: unknown, allocation: unknown): string[];
export function firmwarePathReferencesRuntime(value: unknown, capability: unknown): {
  capabilityHash: string;
  factSnapshotRef: Readonly<{ snapshotId: string; contentHash: string }>;
  observationIds: readonly string[];
  factIds: readonly string[];
  requirementIds: readonly string[];
} | null;

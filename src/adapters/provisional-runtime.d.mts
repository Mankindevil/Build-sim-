export interface ProvisionalRuntimeReference {
  readonly ref: string;
  readonly necessity: "required_for_replay" | "optional_for_audit";
}

export function validateProvisionalCaseAdapterPlanAuthorityRuntime(value: unknown): string[];
export function validateCaseAdapterEvidenceLocatorArtifactRuntime(value: unknown): string[];
export function provisionalCaseAdapterCandidateContentHashRuntime(value: unknown): string | null;
export function validateProvisionalCaseAdapterCandidateRuntime(value: unknown): string[];
export function provisionalCaseAdapterCandidateReferencesRuntime(value: unknown): ProvisionalRuntimeReference[] | null;
export function hydrateProvisionalCaseAdapterCandidateArtifactRuntime(value: unknown, ref: unknown): unknown | null;

export function runtimeCaseAdapterRegistrationContentHashRuntime(value: unknown): string | null;
export function validateRuntimeCaseAdapterRegistrationRuntime(value: unknown): string[];
export function runtimeCaseAdapterRegistryContentHashRuntime(value: unknown): string | null;
export function validateRuntimeCaseAdapterRegistryRuntime(value: unknown): string[];
export function runtimeCaseAdapterRegistryReferencesRuntime(value: unknown): ProvisionalRuntimeReference[] | null;
export function hydrateRuntimeCaseAdapterRegistryArtifactRuntime(value: unknown, ref: unknown): unknown | null;

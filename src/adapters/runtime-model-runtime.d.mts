import type { CaseAdapterManifest } from "./contracts";

export interface CaseRuntimeModelSnapshotReferences {
  manifestHash: string;
  runtimeModelHash: string;
  sourceRefs: readonly string[];
  factIds: readonly string[];
  derivationIds: readonly string[];
  evidenceContentHashes: readonly string[];
}

export function caseRuntimeModelCanonicalBytesRuntime(value: unknown): string | null;
export function caseRuntimeModelContentHashRuntime(value: unknown): string | null;
export function validateCaseRuntimeDocumentsRuntime(value: unknown, manifest?: CaseAdapterManifest | null): string[];
export function validateCaseRuntimeModelInputRuntime(value: unknown, manifest?: CaseAdapterManifest | null): string[];
export function validateCaseRuntimeModelRuntime(value: unknown, manifest?: CaseAdapterManifest | null): string[];
export function verifyCaseRuntimeModelRuntime(value: unknown, manifest?: CaseAdapterManifest | null): boolean;
export function runtimeModelSnapshotReferencesRuntime(value: unknown, manifest?: CaseAdapterManifest | null): CaseRuntimeModelSnapshotReferences | null;

export interface RuntimeCaseInstanceOverrideEntry {
  readonly observationId: string;
  readonly observationRecordHash: string;
  readonly subjectRef: Readonly<Record<string, unknown>>;
  readonly subjectRevisionHash: string;
  readonly fieldId: string;
  readonly targetKind: "envelope" | "anchor" | "routing" | "clearance" | "pose";
  readonly property: string;
  readonly value: number;
  readonly unit: "mm" | "degree";
  readonly uncertainty: Readonly<Record<string, number>>;
}

export const OBSERVATION_FIELD_RUNTIME: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export const CASE_INSTANCE_OVERRIDE_FIELD_RUNTIME: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export function validateUserObservationRuntime(value: unknown): string[];
export function verifyUserObservationRuntime(value: unknown): boolean;
export function validateUserObservationSnapshotRuntime(value: unknown): string[];
export function verifyUserObservationSnapshotRuntime(value: unknown): boolean;
export function validateObservationSupersessionRuntime(value: unknown, options?: { planId?: string; replacementObservationId?: string }): string[];
export function currentObservationIdsRuntime(observations: unknown): { errors: string[]; currentIds: Set<string> };
export function validateCaseInstanceOverridesRuntime(value: unknown): string[];
export function verifyCaseInstanceOverridesRuntime(value: unknown): boolean;

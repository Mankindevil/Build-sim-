export interface PlanAgentRunContextAuditRuntimeRecord {
  readonly schemaVersion: "1.0.0";
  readonly sessionId: string;
  readonly runId: string;
  readonly planId: string;
  readonly planVersionId: string | null;
  readonly draftRevision: number;
  readonly configHash: string;
  readonly evaluationHash: string;
  readonly spatialSelection: {
    readonly partId: string;
    readonly view: string;
    readonly findingId?: string;
  } | null;
  readonly contextHash: string;
  readonly recordedAt: string;
}

export function validatePlanAgentRunContextAuditRuntime(value: unknown): string[];
export function validatePlanAgentRunContextAuditEnvelopeRuntime(value: unknown, expectedRunId?: string): string[];
export function planAgentRunContextAuditReferencesRuntime(value: unknown): ReadonlyArray<{
  readonly ref: string;
  readonly necessity: "required_for_replay" | "optional_for_audit";
}> | null;

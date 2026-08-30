export interface WorkspaceCaseAdapterSnapshotRuntimeReference {
  readonly ref: string;
  readonly necessity: "required_for_replay" | "optional_for_audit";
}

export declare function validateWorkspaceCaseAdapterSnapshotRuntime(value: unknown): string[];
export declare function workspaceCaseAdapterSnapshotReferencesRuntime(
  value: unknown,
): WorkspaceCaseAdapterSnapshotRuntimeReference[] | null;

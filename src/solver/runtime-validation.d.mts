export type SolverArtifactReference = { ref: string; necessity: "required_for_replay" | "optional_for_audit" };
export function validatePersistedSolverCandidateRuntime(value: unknown, options?: { artifactMaterial?: boolean }): string[];
export function solverCandidateReferencesRuntime(value: unknown): SolverArtifactReference[];
export function validateSolverCandidateClosureRuntime(
  candidateEntry: { ref: string; value: unknown },
  request: unknown,
  baseConfigEntry: { ref: string; value: unknown },
  candidateConfigEntry: { ref: string; value: unknown },
  operationsEntry: { ref: string; value: unknown },
): string[];
export function validateSolverSearchCheckpointRuntime(value: unknown): string[];
export function validateSolverCandidateIndexRuntime(value: unknown): boolean;
export function solverCandidateIndexAuthorityReferencesRuntime(value: unknown): SolverArtifactReference[];
export function validateSolverCandidateIndexAuthorityClosureRuntime(value: unknown, closure: unknown): string[];
export function validateSolverRequestArtifactRuntime(value: unknown): string[];
export function solverRequestReferencesRuntime(value: unknown): SolverArtifactReference[];
export function validateSolverJobCheckpointRuntime(value: unknown): string[];
export function solverJobCheckpointReferencesRuntime(value: unknown): SolverArtifactReference[];
export function validateSolverResultArtifactRuntime(value: unknown): string[];
export function solverResultReferencesRuntime(value: unknown): SolverArtifactReference[];
export function validateSolverUnsatClosureRuntime(
  value: unknown,
  checkpointEntry: { ref: string; value: unknown },
  candidateIndexEntry: { ref: string; value: unknown },
): string[];
export function validateSolverApprovalArtifactRuntime(value: unknown): string[];
export function solverApprovalReferencesRuntime(value: unknown): SolverArtifactReference[];
export function validateSolverApprovalClosureRuntime(
  value: unknown,
  pending: unknown,
  request: unknown,
  result: unknown,
  proposal: unknown,
  candidateEntry: { ref: string; value: unknown },
  operationsEntry: { ref: string; value: unknown },
): string[];
export function validateSolverWhatIfArtifactRuntime(value: unknown): string[];
export function validateSolverWhatIfDiffClosureRuntime(decision: unknown, domainDiffs: readonly unknown[]): string[];
export function validateSolverWhatIfClosureRuntime(
  value: unknown,
  decisionEntry: { ref: string; value: unknown },
  domainEntries: readonly { ref: string; value: unknown }[],
): string[];
export function solverWhatIfReferencesRuntime(value: unknown): SolverArtifactReference[];
export function validateSolverProgressiveEvaluationClosureRuntime(receipt: unknown, coverageArtifact: unknown): string[];
export function validateSolverArtifactRuntime(kind: string, value: unknown): string[];
export function solverArtifactReferencesRuntime(kind: string, value: unknown): SolverArtifactReference[];

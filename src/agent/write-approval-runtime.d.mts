export interface AgentWriteApprovalRuntimeReference {
  ref: string;
  necessity: "required_for_replay";
}
export function agentWriteApprovalArtifactKindRuntime(schemaVersion: unknown): string | null;
export function agentWriteApprovalArtifactMetadataRuntime(value: unknown): { kind: string; mediaType: string; privacyClass: "runtime_internal" } | null;
export function agentWriteApprovalExecutionRuntime(value: unknown): {
  toolName: string; toolDefinitionHash: string; sessionId: string; runId: string; inputHash: string; callId: string;
} | null;
export function validateAgentWriteApprovalArtifactRuntime(value: unknown): string[];
export function agentWriteApprovalArtifactReferencesRuntime(value: unknown): AgentWriteApprovalRuntimeReference[] | null;
export function validateAgentWriteApprovalArtifactClosureRuntime(value: unknown, referenced: unknown): string[];
export function validateAgentWriteApprovalBindingRuntime(value: unknown): string[];
export function agentWriteApprovalBindingReferencesRuntime(value: unknown): AgentWriteApprovalRuntimeReference[] | null;
export function validateAgentWriteApprovalBindingClosureRuntime(binding: unknown, confirmed: unknown, pending: unknown): string[];

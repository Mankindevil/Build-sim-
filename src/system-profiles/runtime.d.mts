export function validateSystemProfileDefinitionRuntime(value: unknown): string[];
export function validateSystemProfileRegistryRuntime(value: unknown): string[];
export function systemProfileRegistryContentHashRuntime(value: unknown): string | null;
export function validateWorkspaceSystemProfilePayloadRuntime(value: unknown): string[];
export function workspaceSystemProfileReferencesRuntime(value: unknown): Array<{ ref: string; necessity: "informational" }> | null;

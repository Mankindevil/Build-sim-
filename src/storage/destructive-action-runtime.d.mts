export function validateDestructiveActionPlanShapeRuntime(value: unknown): string[];
export function destructiveActionPlanReferencesRuntime(value: unknown): Array<{
  ref: string;
  necessity: "required_for_replay";
}> | null;

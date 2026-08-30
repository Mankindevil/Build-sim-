const SHA256 = /^[a-f0-9]{64}$/;

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strings(value) { return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0); }

/** Strict JS-safe validator shared by TypeScript, graph, backup and restore. */
export function validateDestructiveActionPlanShapeRuntime(value) {
  if (!record(value)) return ["destructive action must be an object"];
  const allowed = ["actionId", "diskInstanceIds", "locatorObservationIds", "inputPlanId", "inputPlanVersionId", "inputConfigHash", "inputPlanRevisionHash", "inputProcedureSafetyHash", "confirmation", "confirmationAt"];
  const errors = [];
  if (Object.keys(value).some((key) => !allowed.includes(key))) errors.push("destructive action contains unknown fields");
  if (typeof value.actionId !== "string" || !value.actionId || typeof value.inputPlanId !== "string" || !value.inputPlanId
    || typeof value.inputPlanVersionId !== "string" || !value.inputPlanVersionId) errors.push("destructive action plan identity missing");
  if (!strings(value.diskInstanceIds) || new Set(value.diskInstanceIds ?? []).size !== value.diskInstanceIds?.length) errors.push("destructive action requires unique disk instances");
  if (!strings(value.locatorObservationIds) || value.locatorObservationIds?.length !== value.diskInstanceIds?.length
    || new Set(value.locatorObservationIds ?? []).size !== value.locatorObservationIds?.length) errors.push("every disk requires one unique locator observation");
  if (![value.inputConfigHash, value.inputPlanRevisionHash, value.inputProcedureSafetyHash].every((hash) => typeof hash === "string" && SHA256.test(hash))) errors.push("destructive action plan/config/safety hashes invalid");
  if (value.confirmation !== "required" && value.confirmation !== "confirmed") errors.push("destructive action confirmation state invalid");
  if (value.confirmation === "confirmed" && (typeof value.confirmationAt !== "string" || !Number.isFinite(Date.parse(value.confirmationAt)))) errors.push("destructive confirmation timestamp invalid");
  if (value.confirmation === "required" && Object.hasOwn(value, "confirmationAt")) errors.push("unconfirmed destructive action cannot carry confirmationAt");
  return errors;
}

export function destructiveActionPlanReferencesRuntime(value) {
  if (validateDestructiveActionPlanShapeRuntime(value).length) return null;
  return [
    { ref: `plan:${value.inputPlanId}`, necessity: "required_for_replay" },
    { ref: `plan-version:${value.inputPlanVersionId}`, necessity: "required_for_replay" },
    ...value.locatorObservationIds.map((observationId) => ({ ref: `observation:${observationId}`, necessity: "required_for_replay" })),
  ];
}

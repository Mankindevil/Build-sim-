/**
 * Executable bytes for the governed GPU length clearance rule. The production
 * registry hashes this complete module and binds that hash into rule metadata.
 *
 * @param {{
 *   planId: string,
 *   rule: { parameters: unknown },
 *   currentFacts: readonly Array<{ factId: string, field: string, value: unknown }>
 * }} context
 */
export function executeGpuLengthClearanceV1({ planId, rule, currentFacts }) {
  const caseLimits = currentFacts.filter((fact) => fact.field === "case.gpu_max_length");
  const gpuLengths = currentFacts.filter((fact) => fact.field === "gpu.length");
  if (caseLimits.length !== 1 || gpuLengths.length !== 1
    || typeof caseLimits[0].value !== "number" || typeof gpuLengths[0].value !== "number") {
    throw new Error("GPU clearance inference requires one exact case limit and one exact GPU length");
  }
  const parameters = /** @type {{ placementId: string, uncertaintyMm: number }} */ (rule.parameters);
  const value = caseLimits[0].value - gpuLengths[0].value;
  return {
    inputFactIds: [caseLimits[0].factId, gpuLengths[0].factId],
    subject: { kind: "plan_subject", planId, subjectRef: { kind: "placement", placementId: parameters.placementId } },
    scope: "plan_subject",
    value,
    unit: "mm",
    outputRange: { min: value - parameters.uncertaintyMm, max: value + parameters.uncertaintyMm, unit: "mm" },
  };
}

import { createHash } from "node:crypto";

function stableDefinition(value) {
  if (Array.isArray(value)) return `[${value.map(stableDefinition).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined && typeof item !== "function")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableDefinition(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME = "register_provisional_case_adapter";
export const REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_CONTRACT = Object.freeze({
  contractVersion: "1.0.0",
  name: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
  title: "注册临时机箱适配器",
  description: "Register one server-owned content-addressed provisional case adapter after exact plan, fact snapshot, manifest, registry CAS and durable human approval replay. The model cannot supply manifest bytes, evidence anchors or approval authority.",
  effect: "write",
  approval: "required",
  timeoutMs: 30_000,
  maxResultBytes: 160_000,
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      candidateId: { type: "string", pattern: "^provisional-case-adapter-sha256-[a-f0-9]{64}$" },
      planId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$" },
      caseComponentInstanceId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$" },
      planRevision: { type: "integer", minimum: 0 },
      configHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      manifestHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      factSnapshotHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      expectedPriorRegistrationHash: { pattern: "^[a-f0-9]{64}$" },
      expectedPriorRegistryRef: { pattern: "^sha256:[a-f0-9]{64}$" },
    }),
    required: Object.freeze([
      "candidateId", "planId", "caseComponentInstanceId", "planRevision", "configHash", "manifestHash",
      "factSnapshotHash", "expectedPriorRegistrationHash", "expectedPriorRegistryRef",
    ]),
    additionalProperties: false,
  }),
});
export const REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH = createHash("sha256")
  .update(stableDefinition(REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_CONTRACT))
  .digest("hex");

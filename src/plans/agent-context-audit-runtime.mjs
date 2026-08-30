import { sha256Json } from "../runtime/fs.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const PLAN_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;

function total(operation, fallback) {
  try { return operation(); } catch { return fallback; }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, allowed, required = allowed) {
  return record(value)
    && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalIso(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && total(() => new Date(value).toISOString() === value, false);
}

function unicodeScalar(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function governedText(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && unicodeScalar(value) && value === value.trim() && value === value.normalize("NFC")
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validSpatialSelection(value) {
  if (value === null) return true;
  if (!exact(value, ["partId", "view", "findingId"], ["partId", "view"])) return false;
  return governedText(value.partId)
    && governedText(value.view, 80)
    && (value.findingId === undefined || governedText(value.findingId));
}

export function validatePlanAgentRunContextAuditRuntime(value) {
  return total(() => {
    const keys = [
      "schemaVersion", "sessionId", "runId", "planId", "planVersionId", "draftRevision",
      "configHash", "evaluationHash", "spatialSelection", "contextHash", "recordedAt",
    ];
    if (!exact(value, keys)) return ["plan Agent context audit fields invalid"];
    const errors = [];
    if (value.schemaVersion !== "1.0.0" || !AGENT_ID.test(String(value.sessionId ?? ""))
      || !AGENT_ID.test(String(value.runId ?? "")) || !PLAN_ID.test(String(value.planId ?? ""))
      || (value.planVersionId !== null && !PLAN_ID.test(String(value.planVersionId ?? "")))) {
      errors.push("plan Agent context audit identity invalid");
    }
    if (!Number.isSafeInteger(value.draftRevision) || value.draftRevision < 0
      || !SHA256.test(String(value.configHash ?? "")) || !SHA256.test(String(value.evaluationHash ?? ""))
      || !SHA256.test(String(value.contextHash ?? ""))) {
      errors.push("plan Agent context audit revision/hash invalid");
    }
    if (!validSpatialSelection(value.spatialSelection)) errors.push("plan Agent context audit spatial selection invalid");
    if (!canonicalIso(value.recordedAt)) errors.push("plan Agent context audit timestamp invalid");
    return errors;
  }, ["plan Agent context audit validation failed closed"]);
}

export function validatePlanAgentRunContextAuditEnvelopeRuntime(value, expectedRunId) {
  return total(() => {
    if (!exact(value, ["schemaVersion", "kind", "checksum", "payload"])) {
      return ["plan Agent context audit envelope fields invalid"];
    }
    const errors = validatePlanAgentRunContextAuditRuntime(value.payload);
    if (value.schemaVersion !== "plan-agent-context-audit-envelope-v1"
      || value.kind !== "plan-agent-context-audit" || !SHA256.test(String(value.checksum ?? ""))
      || value.checksum !== sha256Json(value.payload)) {
      errors.push("plan Agent context audit envelope integrity invalid");
    }
    if (expectedRunId !== undefined && value.payload?.runId !== expectedRunId) {
      errors.push("plan Agent context audit path binding invalid");
    }
    return errors;
  }, ["plan Agent context audit envelope validation failed closed"]);
}

export function planAgentRunContextAuditReferencesRuntime(value) {
  if (validatePlanAgentRunContextAuditRuntime(value).length) return null;
  return [
    { ref: `plan:${value.planId}`, necessity: "required_for_replay" },
    ...(value.planVersionId
      ? [{ ref: `plan-version:${value.planVersionId}`, necessity: "required_for_replay" }]
      : []),
    { ref: `evaluation:${value.evaluationHash}`, necessity: "optional_for_audit" },
  ];
}

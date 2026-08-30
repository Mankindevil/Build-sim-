import { createHash } from "node:crypto";

const REF = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{8,160}$/;
const CALL_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const NONCE = /^nonce-[a-f0-9]{64}$/;
const MEDIA_TYPE = "application/vnd.buildsim.agent-write-approval+json";

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("approval value is not finite JSON");
  return encoded;
}
function hash(value) { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }
function rawHash(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function same(left, right) { try { return canonical(left) === canonical(right); } catch { return false; } }

export function agentWriteApprovalArtifactKindRuntime(schemaVersion) {
  if (schemaVersion === "agent-write-approval-pending-v1") return "agent-write-approval-pending";
  if (schemaVersion === "agent-write-approval-confirmed-v1") return "agent-write-approval-confirmed";
  if (schemaVersion === "agent-write-approval-consumed-v1") return "agent-write-approval-consumed";
  return null;
}

export function agentWriteApprovalArtifactMetadataRuntime(value) {
  const kind = agentWriteApprovalArtifactKindRuntime(value?.schemaVersion);
  return kind ? { kind, mediaType: MEDIA_TYPE, privacyClass: "runtime_internal" } : null;
}

export function agentWriteApprovalExecutionRuntime(pending) {
  if (!object(pending) || !object(pending.call)) return null;
  return {
    toolName: pending.call.name,
    toolDefinitionHash: pending.toolDefinitionHash,
    sessionId: pending.sessionId,
    runId: pending.runId,
    inputHash: pending.inputHash,
    callId: pending.call.id,
  };
}

function pendingErrors(pending) {
  const errors = [];
  if (!exact(pending, ["contractVersion", "status", "approvalId", "nonce", "runId", "sessionId", "call", "toolTitle", "toolDefinitionHash", "inputHash", "idempotencyKey", "requestedAt", "expiresAt", "backup", "rollback"])) return ["pending approval fields invalid"];
  if (pending.contractVersion !== "1.0.0" || pending.status !== "pending") errors.push("pending approval version/status invalid");
  if (!object(pending.call) || !exact(pending.call, ["id", "name", "input"]) || !CALL_ID.test(String(pending.call.id ?? "")) || !TOOL.test(String(pending.call.name ?? ""))) errors.push("pending approval call invalid");
  const execution = agentWriteApprovalExecutionRuntime(pending);
  const identity = execution ? hash({ contractVersion: "1.0.0", ...execution }) : "";
  if (pending.approvalId !== `approval-${identity}` || pending.idempotencyKey !== `agent-write-${identity}`) errors.push("pending approval identity invalid");
  if (!NONCE.test(String(pending.nonce ?? "")) || !ID.test(String(pending.runId ?? "")) || !ID.test(String(pending.sessionId ?? ""))) errors.push("pending approval nonce/run/session invalid");
  if (!HASH.test(String(pending.toolDefinitionHash ?? "")) || !HASH.test(String(pending.inputHash ?? "")) || (object(pending.call) && pending.inputHash !== hash(pending.call.input))) errors.push("pending approval execution hash invalid");
  if (typeof pending.toolTitle !== "string" || !pending.toolTitle.trim()) errors.push("pending approval title invalid");
  const requested = Date.parse(String(pending.requestedAt ?? "")); const expires = Date.parse(String(pending.expiresAt ?? ""));
  if (!Number.isFinite(requested) || !Number.isFinite(expires) || expires <= requested || expires - requested > 10 * 60_000) errors.push("pending approval lifetime invalid");
  if (!exact(pending.backup, ["required", "target"]) || pending.backup.required !== true || typeof pending.backup.target !== "string" || !pending.backup.target.trim()) errors.push("pending approval backup invalid");
  if (!exact(pending.rollback, ["required", "strategy"]) || pending.rollback.required !== true || typeof pending.rollback.strategy !== "string" || !pending.rollback.strategy.trim()) errors.push("pending approval rollback invalid");
  return [...new Set(errors)];
}

function envelopeErrors(envelope, pending) {
  const errors = [];
  if (!exact(envelope, ["contractVersion", "approvalId", "toolName", "toolDefinitionHash", "sessionId", "runId", "inputHash", "idempotencyKey", "issuedAt", "expiresAt", "approvedBy", "approvalToken", "backup", "rollback"])) return ["confirmed approval envelope fields invalid"];
  if (envelope.contractVersion !== "1.0.0" || !ID.test(String(envelope.approvalId ?? "")) || !TOOL.test(String(envelope.toolName ?? ""))
    || !HASH.test(String(envelope.toolDefinitionHash ?? "")) || !ID.test(String(envelope.sessionId ?? "")) || !ID.test(String(envelope.runId ?? ""))
    || !HASH.test(String(envelope.inputHash ?? "")) || !ID.test(String(envelope.idempotencyKey ?? "")) || !ID.test(String(envelope.approvedBy ?? ""))
    || typeof envelope.approvalToken !== "string" || envelope.approvalToken.length < 32 || envelope.approvalToken.length > 4096) errors.push("confirmed approval envelope identity invalid");
  const issued = Date.parse(String(envelope.issuedAt ?? "")); const expires = Date.parse(String(envelope.expiresAt ?? ""));
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > 15 * 60_000) errors.push("confirmed approval envelope lifetime invalid");
  if (!pending || envelope.approvalId !== pending.approvalId || envelope.toolName !== pending.call?.name || envelope.toolDefinitionHash !== pending.toolDefinitionHash
    || envelope.sessionId !== pending.sessionId || envelope.runId !== pending.runId || envelope.inputHash !== pending.inputHash
    || envelope.idempotencyKey !== pending.idempotencyKey || envelope.issuedAt !== pending.requestedAt || envelope.expiresAt !== pending.expiresAt
    || !same(envelope.backup, pending.backup) || !same(envelope.rollback, pending.rollback)) errors.push("confirmed approval envelope execution binding invalid");
  return [...new Set(errors)];
}

export function validateAgentWriteApprovalArtifactRuntime(value) {
  const errors = [];
  if (!object(value) || !agentWriteApprovalArtifactKindRuntime(value.schemaVersion)) return ["approval artifact schema invalid"];
  if (value.schemaVersion === "agent-write-approval-pending-v1") {
    if (!exact(value, ["schemaVersion", "pending"])) return ["pending approval artifact fields invalid"];
    return pendingErrors(value.pending);
  }
  if (value.schemaVersion === "agent-write-approval-confirmed-v1") {
    if (!exact(value, ["schemaVersion", "pendingRef", "pending", "envelope"]) || !REF.test(String(value.pendingRef ?? ""))) errors.push("confirmed approval artifact fields invalid");
    errors.push(...pendingErrors(value.pending), ...envelopeErrors(value.envelope, value.pending));
    const expectedToken = `server-${hash({ pendingRef: value.pendingRef, nonce: value.pending?.nonce, approvedBy: value.envelope?.approvedBy })}`;
    if (value.envelope?.approvalToken !== expectedToken) errors.push("confirmed approval token binding invalid");
    return [...new Set(errors)];
  }
  if (!exact(value, ["schemaVersion", "confirmedRef", "pending", "envelope", "resultHash", "consumedAt"]) || !REF.test(String(value.confirmedRef ?? ""))
    || !HASH.test(String(value.resultHash ?? "")) || !iso(value.consumedAt)) errors.push("consumed approval artifact fields invalid");
  errors.push(...pendingErrors(value.pending), ...envelopeErrors(value.envelope, value.pending));
  const consumed = Date.parse(String(value.consumedAt ?? ""));
  const issued = Date.parse(String(value.envelope?.issuedAt ?? ""));
  const expires = Date.parse(String(value.envelope?.expiresAt ?? ""));
  if (!Number.isFinite(consumed) || consumed < issued || consumed > expires) errors.push("consumed approval time binding invalid");
  return [...new Set(errors)];
}

export function agentWriteApprovalArtifactReferencesRuntime(value) {
  const errors = validateAgentWriteApprovalArtifactRuntime(value);
  if (errors.length) return null;
  if (value.schemaVersion === "agent-write-approval-pending-v1") return [];
  const ref = value.schemaVersion === "agent-write-approval-confirmed-v1" ? value.pendingRef : value.confirmedRef;
  return [{ ref, necessity: "required_for_replay" }];
}

export function validateAgentWriteApprovalArtifactClosureRuntime(value, referenced) {
  const errors = validateAgentWriteApprovalArtifactRuntime(value);
  if (errors.length) return errors;
  if (value.schemaVersion === "agent-write-approval-pending-v1") return [];
  if (!referenced || validateAgentWriteApprovalArtifactRuntime(referenced).length) return ["approval artifact referenced authority is invalid"];
  if (value.schemaVersion === "agent-write-approval-confirmed-v1") {
    if (referenced.schemaVersion !== "agent-write-approval-pending-v1" || !same(value.pending, referenced.pending)) return ["confirmed approval pending ref closure invalid"];
    return [];
  }
  if (referenced.schemaVersion !== "agent-write-approval-confirmed-v1" || !same(value.pending, referenced.pending) || !same(value.envelope, referenced.envelope)) return ["consumed approval confirmed ref closure invalid"];
  return [];
}

export function validateAgentWriteApprovalBindingRuntime(value) {
  if (!exact(value, [
    "schemaVersion", "confirmedAuthorityRef", "pendingRef", "approvalId", "approvedBy", "idempotencyKey",
    "toolName", "toolDefinitionHash", "sessionId", "runId", "inputHash", "callId", "issuedAt", "expiresAt",
    "runtimeGeneration", "jobId", "checkpointRef", "planContextHash", "contentHash",
  ])) return ["Agent write approval binding fields invalid"];
  const errors = [];
  if (value.schemaVersion !== "agent-write-approval-binding-v1") errors.push("Agent write approval binding schema invalid");
  if (!REF.test(String(value.confirmedAuthorityRef ?? "")) || !REF.test(String(value.pendingRef ?? ""))
    || value.checkpointRef !== value.confirmedAuthorityRef) errors.push("Agent write approval binding artifact refs invalid");
  if (!TOOL.test(String(value.toolName ?? "")) || !HASH.test(String(value.toolDefinitionHash ?? ""))
    || !ID.test(String(value.sessionId ?? "")) || !ID.test(String(value.runId ?? ""))
    || !HASH.test(String(value.inputHash ?? "")) || !CALL_ID.test(String(value.callId ?? ""))) {
    errors.push("Agent write approval binding execution invalid");
  }
  const execution = {
    toolName: value.toolName,
    toolDefinitionHash: value.toolDefinitionHash,
    sessionId: value.sessionId,
    runId: value.runId,
    inputHash: value.inputHash,
    callId: value.callId,
  };
  const identity = hash({ contractVersion: "1.0.0", ...execution });
  if (value.approvalId !== `approval-${identity}` || value.idempotencyKey !== `agent-write-${identity}`
    || !ID.test(String(value.approvedBy ?? ""))) errors.push("Agent write approval binding reviewer/identity invalid");
  const issued = Date.parse(String(value.issuedAt ?? "")); const expires = Date.parse(String(value.expiresAt ?? ""));
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > 10 * 60_000) {
    errors.push("Agent write approval binding lifetime invalid");
  }
  if (!Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
    || value.jobId !== `job-${rawHash(`agent-run:${value.runId}`)}` || !HASH.test(String(value.planContextHash ?? ""))) {
    errors.push("Agent write approval binding root/job/plan context invalid");
  }
  const { contentHash: _contentHash, ...unsigned } = value;
  if (!HASH.test(String(value.contentHash ?? "")) || value.contentHash !== hash(unsigned)) {
    errors.push("Agent write approval binding contentHash invalid");
  }
  return [...new Set(errors)];
}

export function agentWriteApprovalBindingReferencesRuntime(value) {
  if (validateAgentWriteApprovalBindingRuntime(value).length) return null;
  return [
    { ref: value.confirmedAuthorityRef, necessity: "required_for_replay" },
    { ref: value.pendingRef, necessity: "required_for_replay" },
    { ref: `plan-agent-context:${value.runId}`, necessity: "required_for_replay" },
    { ref: `job:${value.jobId}`, necessity: "required_for_replay" },
    { ref: `agent-session:${value.sessionId}`, necessity: "required_for_replay" },
    { ref: `agent-audit:${value.runId}`, necessity: "required_for_replay" },
  ];
}

/**
 * Verifies that a persisted domain binding is a lossless projection of the
 * exact server-issued confirmed -> pending approval authority chain.  This is
 * deliberately pure/JS-safe so backup, Doctor and restore can apply the same
 * closure rule without constructing an in-process capability.
 */
export function validateAgentWriteApprovalBindingClosureRuntime(binding, confirmed, pending) {
  const errors = [...validateAgentWriteApprovalBindingRuntime(binding)];
  if (!object(confirmed) || confirmed.schemaVersion !== "agent-write-approval-confirmed-v1"
    || validateAgentWriteApprovalArtifactRuntime(confirmed).length) {
    errors.push("Agent write approval binding confirmed authority invalid");
  }
  if (!object(pending) || pending.schemaVersion !== "agent-write-approval-pending-v1"
    || validateAgentWriteApprovalArtifactRuntime(pending).length) {
    errors.push("Agent write approval binding pending authority invalid");
  }
  if (errors.length) return [...new Set(errors)];

  const confirmedRef = `sha256:${rawHash(canonical(confirmed))}`;
  const pendingRef = `sha256:${rawHash(canonical(pending))}`;
  if (binding.confirmedAuthorityRef !== confirmedRef || binding.checkpointRef !== confirmedRef
    || binding.pendingRef !== pendingRef || confirmed.pendingRef !== pendingRef) {
    errors.push("Agent write approval binding artifact ref closure invalid");
  }
  errors.push(...validateAgentWriteApprovalArtifactClosureRuntime(confirmed, pending));

  const execution = agentWriteApprovalExecutionRuntime(pending.pending);
  const envelope = confirmed.envelope;
  if (!execution || !same({
    toolName: binding.toolName,
    toolDefinitionHash: binding.toolDefinitionHash,
    sessionId: binding.sessionId,
    runId: binding.runId,
    inputHash: binding.inputHash,
    callId: binding.callId,
  }, execution)) {
    errors.push("Agent write approval binding execution closure invalid");
  }
  if (binding.approvalId !== envelope.approvalId || binding.approvedBy !== envelope.approvedBy
    || binding.idempotencyKey !== envelope.idempotencyKey || binding.issuedAt !== envelope.issuedAt
    || binding.expiresAt !== envelope.expiresAt) {
    errors.push("Agent write approval binding reviewer/lifetime closure invalid");
  }
  return [...new Set(errors)];
}

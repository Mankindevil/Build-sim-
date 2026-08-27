import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  atomicWriteFile,
  atomicWriteJson,
  canonicalJson,
  confined,
  ensurePrivateDirectory,
  pathExists,
  sha256Bytes,
  sha256Json,
  withDirectoryLock,
} from "../../src/runtime/fs.mjs";
import {
  RUNTIME_ROOT_REGISTRY,
  RuntimeCoordinator,
} from "../../src/runtime/coordinator.mjs";
import { sanitizeTransactionRecordForPersistence } from "../price-server/transactions/archive.mjs";
import { assertProductCatalogRuntimeAuthority } from "../price-server/catalog/repository.mjs";

export const LEGACY_RUNTIME_MIGRATION_ID = "legacy-runtime-v1";
export const LEGACY_RUNTIME_MIGRATION_SCHEMA = "legacy-runtime-migration-v1";
const CATALOG_MIGRATION_ID = "catalog-user-data-v1";
const SHA256 = /^[a-f0-9]{64}$/;
const MANAGED_TOP_LEVEL = new Set(["control", "generations", "staging"]);
const REGISTERED_ROOTS = new Set(RUNTIME_ROOT_REGISTRY);
const JSON_RECORD_SUFFIXES = [".json", ".jsonl"];

function timestamp(now) {
  return (now ?? (() => new Date().toISOString()))();
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function clone(value) {
  return structuredClone(value);
}

function omitHash(value, field) {
  const next = { ...value };
  delete next[field];
  return next;
}

function signed(value, field) {
  return { ...value, [field]: sha256Json(omitHash(value, field)) };
}

function assertSigned(value, field, label) {
  if (!value || typeof value !== "object" || !SHA256.test(String(value[field] ?? ""))
    || sha256Json(omitHash(value, field)) !== value[field]) {
    throw new Error(`${label} integrity check failed`);
  }
  return value;
}

function isSecretLogicalPath(logicalPath) {
  const segments = logicalPath.toLocaleLowerCase().split("/");
  return segments.some((segment) => segment === ".env" || segment.startsWith(".env."))
    || segments.some((segment) => /^(?:cookies?|cookies?\.sqlite(?:-wal|-shm)?)$/u.test(segment))
    || segments.some((segment) => /^(?:provider[-_]?keys?|api[-_]?keys?|credentials?)$/u.test(segment))
    || segments.some((segment) => /browser[-_]?(?:profile|cache)/u.test(segment))
    || segments.some((segment, index) => segment === "browser" && /^(?:profile|profiles|cache)$/u.test(segments[index + 1] ?? ""));
}

function secretContentKind(bytes) {
  if (bytes.length > 8 * 1024 * 1024) return null;
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) return null;
  try {
    const value = JSON.parse(text);
    const keys = [];
    const visit = (item) => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) { for (const child of item) visit(child); return; }
      for (const [key, child] of Object.entries(item)) { keys.push(key); visit(child); }
    };
    visit(value);
    if (keys.some((key) => /^(?:cookie|cookies|cookieHeader|cookie_header)$/iu.test(key))) return "cookie";
    if (keys.some((key) => /^(?:apiKey|api_key|providerKey|provider_key|secret|password|accessToken|access_token|refreshToken|refresh_token)$/iu.test(key))) return "provider_key";
  } catch { /* Non-JSON records are checked as bounded text below. */ }
  if (/(?:^|\n)\s*(?:api[_-]?key|provider[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]/iu.test(text)) return "provider_key";
  if (/(?:^|\n)\s*cookies?\s*[:=]/iu.test(text)) return "cookie";
  return null;
}

function isEvidenceBackup(parts) {
  if (parts[0] !== "evidence") return false;
  return parts.slice(1).some((segment) => /^(?:backup|backups|rollback|rollbacks)$/iu.test(segment))
    || /(?:\.bak|\.backup)$/iu.test(parts.at(-1) ?? "");
}

function isAgentContextAudit(parts) {
  return parts.some((segment) => /^(?:\.agent-context-audit|agent-context-audit)$/iu.test(segment));
}

function quarantineDestination(logicalPath) {
  return `migrations/quarantine/${LEGACY_RUNTIME_MIGRATION_ID}/${logicalPath}`;
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validEnvelope(value, kind) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.schemaVersion === "1.0.0" && value.kind === kind
    && Object.prototype.hasOwnProperty.call(value, "payload")
    && value.checksum === sha256Json(value.payload);
}

const PLAN_ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const PLAN_DOCUMENT_ID = /^doc-sha256-[a-f0-9]{64}$/u;
const PLAN_CAPTURE_ID = /^capture-sha256-[a-f0-9]{64}$/u;
const PLAN_BINDING_ID = /^binding-sha256-[a-f0-9]{64}$/u;
const PLAN_EVIDENCE_PURPOSES = new Set(["identity", "compatibility", "geometry", "power", "wiring", "thermal", "assembly"]);
const PLAN_EVIDENCE_SUBJECTS = new Set(["plan", "sku", "case-profile", "component"]);
const PLAN_EVIDENCE_CATEGORIES = new Set(["case", "motherboard", "cpu", "psu", "cooler", "gpu", "memory", "storage", "hba", "fan", "accessory"]);

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// Keep this compatibility gate aligned with parseConfig(). Migration runs as
// plain Node before the TypeScript service is bootable, so records that cannot
// pass the production parser are quarantined instead of being made authority.
function validBuildConfig(value) {
  const input = objectRecord(value);
  if (!input || !["1", "1.0.0", "2.0.0"].includes(String(input.schemaVersion ?? ""))) return false;
  const selection = objectRecord(input.selection) ?? (String(input.schemaVersion) === "2.0.0" ? null : input);
  if (!input.id || !input.name || !input.updatedAt || !selection || !Array.isArray(input.bom)) return false;
  const diskCount = String(input.schemaVersion) === "2.0.0" ? selection.diskCount : Number(selection.diskCount);
  if (!Number.isInteger(diskCount) || diskCount < 0) return false;
  const psuTopology = selection.psuTopology ?? (String(input.schemaVersion) === "2.0.0" ? undefined : "auto");
  const boot = selection.boot ?? (String(input.schemaVersion) === "2.0.0" ? undefined : "bay");
  const hbaMode = selection.hbaMode ?? (String(input.schemaVersion) === "2.0.0" ? undefined : "auto");
  if (!["auto", "bottom", "dual"].includes(psuTopology)
    || !["bay", "m2", "usbssd"].includes(boot)
    || !["auto", "always"].includes(hbaMode)) return false;
  const fanMode = String(input.schemaVersion) === "2.0.0" ? selection.fanMode : "balanced";
  if (fanMode !== undefined && !["quiet", "balanced", "performance"].includes(fanMode)) return false;
  const fanGroups = String(input.schemaVersion) === "2.0.0" ? selection.fanGroups : [];
  if (fanGroups !== undefined) {
    if (!Array.isArray(fanGroups) || fanGroups.length > 16) return false;
    const mountIds = new Set();
    for (const group of fanGroups) {
      const item = objectRecord(group);
      if (!item || typeof item.mountId !== "string" || !item.mountId.trim() || mountIds.has(item.mountId)) return false;
      mountIds.add(item.mountId);
      if (![120, 140].includes(item.sizeMm) || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 16) return false;
      if (Object.keys(item).some((key) => !["mountId", "sizeMm", "count"].includes(key))) return false;
    }
  }
  return true;
}

function validPlanEvidenceLocator(value) {
  const input = objectRecord(value);
  if (!input) return false;
  if (input.page !== undefined && !(
    (Number.isSafeInteger(input.page) && input.page > 0)
    || (Array.isArray(input.page) && input.page.length > 0 && input.page.every((item) => Number.isSafeInteger(item) && item > 0))
  )) return false;
  if (input.printedPage !== undefined && !(
    (typeof input.printedPage === "string" && input.printedPage.trim())
    || (Array.isArray(input.printedPage) && input.printedPage.length > 0
      && input.printedPage.every((item) => typeof item === "string" && item.trim()))
  )) return false;
  for (const key of ["section", "field", "locator", "snippet"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) return false;
  }
  return ["page", "printedPage", "section", "field", "locator", "snippet"].some((key) => input[key] !== undefined);
}

function validPlanEvidenceBinding(value, ownerPlanId, versionId) {
  const input = objectRecord(value);
  if (!input || input.schemaVersion !== "1.0.0" || !PLAN_BINDING_ID.test(String(input.id ?? ""))
    || typeof input.planId !== "string" || !input.planId.trim() || input.planId !== ownerPlanId
    || (input.planVersionId !== undefined && input.planVersionId !== null
      && (typeof input.planVersionId !== "string" || !input.planVersionId))
    || (versionId !== undefined && input.planVersionId !== versionId)
    || !PLAN_DOCUMENT_ID.test(String(input.documentId ?? ""))
    || !SHA256.test(String(input.contentHash ?? ""))
    || (input.captureId !== undefined && !PLAN_CAPTURE_ID.test(String(input.captureId)))
    || !PLAN_ISO_DATE.test(String(input.boundAt ?? ""))
    || (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 500))) return false;
  const subject = objectRecord(input.subject);
  if (!subject || !PLAN_EVIDENCE_SUBJECTS.has(String(subject.kind))
    || typeof subject.id !== "string" || !subject.id.trim()
    || (subject.category !== undefined && !PLAN_EVIDENCE_CATEGORIES.has(String(subject.category)))) return false;
  if (!Array.isArray(input.purposes) || input.purposes.length === 0
    || new Set(input.purposes).size !== input.purposes.length
    || input.purposes.some((purpose) => !PLAN_EVIDENCE_PURPOSES.has(String(purpose)))) return false;
  if (input.locators !== undefined
    && (!Array.isArray(input.locators) || input.locators.length === 0 || input.locators.some((locator) => !validPlanEvidenceLocator(locator)))) return false;
  return true;
}

function validPlanEvidenceBindings(value, ownerPlanId, versionId) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  for (const binding of value) {
    if (!validPlanEvidenceBinding(binding, ownerPlanId, versionId) || ids.has(binding.id)) return false;
    ids.add(binding.id);
  }
  return true;
}

function validPlanInitialization(value) {
  const input = objectRecord(value);
  if (!input || !["pending", "initialized"].includes(input.status) || !["agent", "template", "manual"].includes(input.source)) return false;
  if (input.proposalId !== undefined && (typeof input.proposalId !== "string" || !input.proposalId)) return false;
  if (input.initializedAt !== undefined && !PLAN_ISO_DATE.test(String(input.initializedAt))) return false;
  if (input.intent !== undefined) {
    const intent = objectRecord(input.intent);
    if (!intent || typeof intent.useCase !== "string" || !intent.useCase.trim()) return false;
    if (intent.budgetCny !== undefined && intent.budgetCny !== null
      && (typeof intent.budgetCny !== "number" || !Number.isFinite(intent.budgetCny) || intent.budgetCny < 0)) return false;
  }
  return true;
}

function validPlanAuthority(value, destinationLogical) {
  const parts = destinationLogical.split("/");
  if (parts.includes(".rollback") || parts.includes(".trash")) return false;
  const file = parts.at(-1);
  const planId = parts[1];
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/u.test(planId ?? "")) return false;
  if (file === "plan.json") {
    if (!validEnvelope(value, "plan")) return false;
    const plan = value.payload;
    const draft = objectRecord(plan?.draft);
    const metadata = objectRecord(plan?.metadata);
    const evidenceBindings = draft?.evidenceBindings ?? [];
    return plan?.schemaVersion === "1.0.0" && plan.id === planId && typeof plan.name === "string" && plan.name.trim().length > 0
      && ["active", "archived"].includes(plan.status) && PLAN_ISO_DATE.test(String(plan.createdAt ?? "")) && PLAN_ISO_DATE.test(String(plan.updatedAt ?? ""))
      && (plan.activeVersionId === null || (typeof plan.activeVersionId === "string" && plan.activeVersionId.length > 0))
      && Number.isSafeInteger(plan.draftRevision) && plan.draftRevision >= 0 && Boolean(metadata)
      && (metadata.initialization === undefined || validPlanInitialization(metadata.initialization))
      && draft?.schemaVersion === "1.0.0" && (draft.baseVersionId === null || (typeof draft.baseVersionId === "string" && draft.baseVersionId.length > 0))
      && validBuildConfig(draft.config) && validPlanEvidenceBindings(evidenceBindings, planId)
      && typeof draft.dirty === "boolean" && PLAN_ISO_DATE.test(String(draft.updatedAt ?? ""));
  }
  if (parts.includes("versions") && /^version-[a-z0-9-]{8,80}\.json$/u.test(file ?? "")) {
    if (!validEnvelope(value, "version")) return false;
    const version = value.payload;
    const expectedId = file.slice(0, -5);
    const evidencePairPresent = version?.evidenceBindings !== undefined || version?.evidenceHash !== undefined;
    return version?.schemaVersion === "1.0.0" && version.id === expectedId && version.planId === planId
      && Number.isSafeInteger(version.versionNumber) && version.versionNumber > 0 && PLAN_ISO_DATE.test(String(version.createdAt ?? ""))
      && ["initial", "manual-save", "agent-proposal", "import", "restore"].includes(version.reason)
      && (version.summary === undefined || (typeof version.summary === "string" && version.summary.length <= 500))
      && validBuildConfig(version.config) && SHA256.test(String(version.configHash ?? ""))
      && version.configHash === sha256Json(version.config)
      && (!evidencePairPresent || (validPlanEvidenceBindings(version.evidenceBindings, planId, expectedId)
        && SHA256.test(String(version.evidenceHash ?? "")) && version.evidenceHash === sha256Json(version.evidenceBindings)))
      && (version.evaluationHash === undefined || SHA256.test(String(version.evaluationHash)))
      && (version.evaluatedAt === undefined || PLAN_ISO_DATE.test(String(version.evaluatedAt)))
      && (version.parentVersionId === null || (typeof version.parentVersionId === "string" && version.parentVersionId.length > 0));
  }
  if (parts.includes(".idempotency") && file?.endsWith(".json")) return validEnvelope(value, "idempotency");
  return false;
}

function validEvidenceAuthority(value, destinationLogical, bytes) {
  const documentMatch = /^evidence\/documents\/([a-f0-9]{2})\/(doc-sha256-([a-f0-9]{64}))\.json$/u.exec(destinationLogical);
  if (documentMatch) {
    if (!validEnvelope(value, "evidence-document")) return false;
    const document = value.payload;
    return document?.id === documentMatch[2] && document.sha256 === documentMatch[3]
      && documentMatch[1] === documentMatch[3].slice(0, 2) && Number.isSafeInteger(document.byteLength)
      && document.byteLength >= 0 && validIso(document.createdAt);
  }
  const captureMatch = /^evidence\/captures\/([a-f0-9]{2})\/(capture-sha256-([a-f0-9]{64}))\.json$/u.exec(destinationLogical);
  if (captureMatch) {
    if (!validEnvelope(value, "evidence-capture")) return false;
    const capture = value.payload;
    if (capture?.id !== captureMatch[2] || captureMatch[1] !== captureMatch[3].slice(0, 2)
      || !/^doc-sha256-[a-f0-9]{64}$/u.test(String(capture.documentId ?? "")) || !validIso(capture.retrievedAt)) return false;
    const unsigned = { ...capture };
    delete unsigned.id;
    return capture.id === `capture-sha256-${sha256Bytes(canonicalJson(unsigned))}`;
  }
  if (/^evidence\/source-index\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/u.test(destinationLogical)) {
    return validEnvelope(value, "evidence-url-index")
      && /^capture-sha256-[a-f0-9]{64}$/u.test(String(value.payload?.captureId ?? ""))
      && /^doc-sha256-[a-f0-9]{64}$/u.test(String(value.payload?.documentId ?? ""))
      && validIso(value.payload?.retrievedAt);
  }
  const blobMatch = /^evidence\/blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/u.exec(destinationLogical);
  return Boolean(blobMatch && blobMatch[1] === blobMatch[2].slice(0, 2) && sha256Bytes(bytes) === blobMatch[2]);
}

function validAgentAuthority(value, destinationLogical) {
  const session = /^agent\/sessions\/([A-Za-z0-9._:-]{8,120})\.json$/u.exec(destinationLogical);
  if (session) {
    const payload = value?.payload;
    return value?.schemaVersion === "agent-session-v1" && value.contentHash === sha256Bytes(JSON.stringify(payload))
      && payload?.id === session[1] && payload.contractVersion === "1.0.0"
      && ["deepseek", "claude"].includes(payload.provider) && typeof payload.model === "string"
      && Array.isArray(payload.messages) && (payload.buildConfig === null || typeof payload.buildConfig === "object")
      && validIso(payload.createdAt) && validIso(payload.updatedAt);
  }
  const audit = /^agent\/audit\/([A-Za-z0-9._:-]{8,120})\.json$/u.exec(destinationLogical);
  if (audit) {
    const unsigned = { ...value };
    delete unsigned.recordHash;
    return value?.runId === audit[1] && value.recordHash === sha256Bytes(canonicalJson(unsigned));
  }
  if (/^agent\/rollback\/(?:sessions|audit)-manifest\.json$/u.test(destinationLogical)) {
    const unsigned = { schemaVersion: value?.schemaVersion, entries: value?.entries };
    return value?.schemaVersion === "agent-rollback-v1" && Array.isArray(value.entries)
      && value.checksum === sha256Bytes(JSON.stringify(unsigned))
      && value.entries.every((entry) => entry?.state === "committed");
  }
  return false;
}

function validTransactionAuthority(value, destinationLogical) {
  if (/^transactions\/rollback\/transactions-manifest\.json$/u.test(destinationLogical)) {
    const unsigned = { schemaVersion: value?.schemaVersion, entries: value?.entries };
    return value?.schemaVersion === "transactions-rollback-v2" && Array.isArray(value.entries)
      && value.checksum === sha256Bytes(JSON.stringify(unsigned))
      && value.entries.every((entry) => ["committed", "rolled_back"].includes(entry?.state));
  }
  const name = path.posix.basename(destinationLogical, ".json");
  if (!destinationLogical.endsWith(".json") || !/^[A-Za-z0-9_-]{1,96}$/u.test(name)) return false;
  try {
    const sanitized = sanitizeTransactionRecordForPersistence(value, { legacy: value?.schemaVersion === 1 });
    return sanitized.receiptId === name && canonicalJson(sanitized) === canonicalJson(value);
  } catch { return false; }
}

function validAdviceAuthority(value, destinationLogical) {
  const job = /^audit\/advice-jobs\/([A-Za-z0-9._:-]{8,120})\.json$/u.exec(destinationLogical);
  if (job) {
    return value && typeof value === "object" && !Array.isArray(value) && value.requestId === job[1]
      && ["queued", "running", "completed", "disabled", "advice-unavailable", "paused_restore_review"].includes(value.status)
      && value.provider === "deepseek" && typeof value.promptVersion === "string" && value.promptVersion.length > 0
      && SHA256.test(String(value.inputHash ?? "")) && SHA256.test(String(value.engineHash ?? ""))
      && objectRecord(value.deterministic) && Array.isArray(value.calls) && PLAN_ISO_DATE.test(String(value.generatedAt ?? ""));
  }
  if (/^audit\/advice-events\/\d{4}-\d{2}-\d{2}\.json$/u.test(destinationLogical)) {
    return value?.schemaVersion === "1.0.0" && Array.isArray(value.events) && value.events.every((event) => (
      objectRecord(event) && event.eventType === "advice" && /^[A-Za-z0-9._:-]{8,120}$/u.test(String(event.requestId ?? ""))
      && event.eventId === `advice-${sha256Json({ requestId: event.requestId })}` && event.provider === "deepseek"
      && typeof event.promptVersion === "string" && event.promptVersion.length > 0
      && SHA256.test(String(event.inputHash ?? "")) && SHA256.test(String(event.engineHash ?? ""))
      && (event.responseHash === null || SHA256.test(String(event.responseHash ?? "")))
      && ["queued", "running", "completed", "disabled", "advice-unavailable", "paused_restore_review"].includes(event.status)
      && Array.isArray(event.validationErrors) && Array.isArray(event.calls) && PLAN_ISO_DATE.test(String(event.generatedAt ?? ""))
    ));
  }
  if (destinationLogical === "audit/rollback/advice/advice-manifest.json") {
    const unsigned = { schemaVersion: value?.schemaVersion, entries: value?.entries };
    return value?.schemaVersion === "advice-rollback-v2" && Array.isArray(value.entries)
      && value.checksum === sha256Json(unsigned) && value.entries.every((entry) => entry?.state === "committed");
  }
  return false;
}

function looksLikeImageBytes(bytes) {
  return (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    || (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")));
}

function redactedLegacyTransactionText(value) {
  const source = String(value);
  const redact = (input) => input
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/gu, "[REDACTED-PHONE]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED-EMAIL]")
    .replace(/(?<!\d)\d{17}[\dX](?!\d)/giu, "[REDACTED-ID]")
    .replace(/(?:姓名|收货人|联系人|电话|手机|邮箱|电子邮件|地址|住址)\s*[:：]?\s*[^，,;；\n]{1,80}/giu, "[REDACTED-PERSONAL]")
    .replace(/[\p{Script=Han}A-Za-z0-9]{2,40}(?:省|自治区|市|自治州|区|县)[^，,;；\n]{2,80}(?:路|街|巷|弄|号|栋|室)/gu, "[REDACTED-ADDRESS]");
  const redacted = redact(source);
  if (redacted !== source) return redacted;
  try {
    const decoded = decodeURIComponent(source);
    if (decoded !== source && redact(decoded) !== decoded) return "[REDACTED-ENCODED-PERSONAL]";
  } catch { /* Malformed escapes contain no decodable private text. */ }
  return source;
}

function redactLegacyTransactionValue(value, key = "") {
  if (/^(?:recipientName|customerName|shippingAddress|postalAddress|address|phone|telephone|mobile|contact|email|recipientEmail|identityNumber)$/iu.test(key)) return "[REDACTED-PERSONAL]";
  if (typeof value === "number" && Number.isSafeInteger(value)
    && /^(?:86)?1[3-9]\d{9}$/u.test(String(value))) return "[REDACTED-PHONE]";
  if (typeof value === "string") return redactedLegacyTransactionText(value);
  if (Array.isArray(value)) return value.map((child) => redactLegacyTransactionValue(child, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactLegacyTransactionValue(child, childKey)]));
}

function legacyTransactionContainsPrivateData(value, key = "") {
  if (/^(?:recipientName|customerName|shippingAddress|postalAddress|address|phone|telephone|mobile|contact|email|recipientEmail|identityNumber)$/iu.test(key)) {
    return value !== undefined && value !== null && value !== "";
  }
  if (typeof value === "string") {
    if (/(?:hash|checksum)$/iu.test(key)) return false;
    if (redactedLegacyTransactionText(value) !== value) return true;
    try {
      const decoded = decodeURIComponent(value);
      return decoded !== value && redactedLegacyTransactionText(decoded) !== decoded;
    } catch { return false; }
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return /^(?:86)?1[3-9]\d{9}$/u.test(String(value));
  if (Array.isArray(value)) return value.some((child) => legacyTransactionContainsPrivateData(child, key));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([childKey, child]) => legacyTransactionContainsPrivateData(child, childKey));
}

function embeddedImageDataUrl(value) {
  if (typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) return value;
  if (Array.isArray(value)) {
    for (const child of value) { const found = embeddedImageDataUrl(child); if (found) return found; }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) { const found = embeddedImageDataUrl(child); if (found) return found; }
  }
  return null;
}

function stripEmbeddedImageFields(value) {
  if (Array.isArray(value)) return value.map(stripEmbeddedImageFields).filter((child) => child !== undefined);
  if (!value || typeof value !== "object") return typeof value === "string" && /^data:image\//iu.test(value) ? undefined : value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (/^(?:screenshotDataUrl|imageData|imageBase64|rawImage|rawPixels)$/iu.test(key)) return [];
    const stripped = stripEmbeddedImageFields(child);
    return stripped === undefined ? [] : [[key, stripped]];
  }));
}

function transactionProjection(logicalPath, bytes) {
  if (!logicalPath.startsWith("transactions/")) return { bytes, projected: false };
  const lower = logicalPath.toLocaleLowerCase();
  if (/\.(?:png|jpe?g|webp|gif|bmp|heic|heif)$/u.test(lower) || looksLikeImageBytes(bytes)) {
    return { excludedReason: "legacy_transaction_raw_image" };
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { return { bytes, projected: false }; }
  if (logicalPath.includes("/rollback/") || logicalPath.endsWith("transactions-manifest.json")) {
    // Legacy rollback payloads may embed prior records or screenshots as
    // base64. They are not needed for current read authority and remain in the
    // unchanged legacy source instead.
    return { excludedReason: "legacy_transaction_rollback_private_payload" };
  }
  const rawDataUrl = embeddedImageDataUrl(value);
  const hasImage = Boolean(value?.image) || rawDataUrl || value?.imageData || value?.imageBase64 || value?.rawImage || value?.rawPixels;
  const containsPrivateData = legacyTransactionContainsPrivateData(value);
  if (!hasImage && !containsPrivateData && value?.schemaVersion === 2) {
    try {
      const sanitized = sanitizeTransactionRecordForPersistence(value);
      if (canonicalJson(sanitized) === canonicalJson(value)) return { bytes, projected: false };
    } catch { /* Invalid current records are projected only for quarantine. */ }
  }
  const next = stripEmbeddedImageFields(redactLegacyTransactionValue(clone(value)));
  const existingEvidence = next.imageEvidence && typeof next.imageEvidence === "object" ? next.imageEvidence : {};
  let contentHash = SHA256.test(String(existingEvidence.contentHash ?? "")) ? existingEvidence.contentHash : null;
  let byteLength = Number.isSafeInteger(existingEvidence.bytes) && existingEvidence.bytes >= 0 ? existingEvidence.bytes : null;
  let mediaType = /^image\/(?:png|jpeg|webp|gif)$/u.test(String(existingEvidence.mimeType ?? "")) ? existingEvidence.mimeType : null;
  if (next.image && typeof next.image === "object") {
    if (!contentHash && SHA256.test(String(next.image.contentHash ?? ""))) contentHash = next.image.contentHash;
    if (byteLength === null && Number.isSafeInteger(next.image.bytes) && next.image.bytes >= 0) byteLength = next.image.bytes;
    if (!mediaType && /^image\/(?:png|jpeg|webp|gif)$/u.test(String(next.image.mimeType ?? ""))) mediaType = next.image.mimeType;
  }
  if (rawDataUrl) {
    const separator = rawDataUrl.indexOf(",");
    const rawBytes = Buffer.from(rawDataUrl.slice(separator + 1), "base64");
    contentHash = sha256Bytes(rawBytes);
    byteLength = rawBytes.length;
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/iu.exec(rawDataUrl);
    if (match) mediaType = match[1].toLocaleLowerCase();
  }
  next.image = null;
  if (next.item?.transaction && typeof next.item.transaction === "object") delete next.item.transaction.fileName;
  if (hasImage) {
    next.imageEvidence = {
      ...(contentHash ? { contentHash } : {}),
      ...(byteLength !== null ? { bytes: byteLength } : {}),
      ...(mediaType ? { mimeType: mediaType } : {}),
      persistence: "legacy_source_retained_not_copied",
    };
  }
  try {
    const sanitized = sanitizeTransactionRecordForPersistence(next, { legacy: true });
    return {
      bytes: Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, "utf8"),
      projected: true,
      ...(!hasImage && containsPrivateData ? { forceQuarantine: true } : {}),
    };
  } catch {
    // The redacted projection remains available in quarantine for explicit
    // review, but it cannot become current transaction authority.
    return {
      bytes: Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"),
      projected: true,
      ...(!hasImage && containsPrivateData ? { forceQuarantine: true } : {}),
    };
  }
}

function currentAuthorityEligible(destinationLogical, bytes) {
  if (!destinationLogical.endsWith(".json") && destinationLogical.startsWith("evidence/")) {
    return validEvidenceAuthority(null, destinationLogical, bytes);
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return false; }
  if (destinationLogical.startsWith("plans/")) return validPlanAuthority(value, destinationLogical);
  if (destinationLogical.startsWith("evidence/")) return validEvidenceAuthority(value, destinationLogical, bytes);
  if (destinationLogical.startsWith("agent/")) return validAgentAuthority(value, destinationLogical);
  if (destinationLogical.startsWith("transactions/")) return validTransactionAuthority(value, destinationLogical);
  if (destinationLogical.startsWith("catalog-overlays/")) {
    try {
      assertProductCatalogRuntimeAuthority(destinationLogical.slice("catalog-overlays/".length), value);
      return true;
    } catch { return false; }
  }
  if (destinationLogical.startsWith("audit/advice-") || destinationLogical.startsWith("audit/rollback/advice/")) {
    return validAdviceAuthority(value, destinationLogical);
  }
  // Other registered roots have their own startup validators. Migration still
  // requires readable JSON/checksum envelopes below and never promotes an
  // unknown root into one of these four user-authority repositories.
  return true;
}

/**
 * Explicit legacy-to-generation mapping. Unknown paths are preserved in
 * quarantine and never become current authority by accident.
 */
export function mapLegacyRuntimePath(logicalPath) {
  const normalized = slash(logicalPath).replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) throw new Error("legacy source entry has an empty path");
  if (isSecretLogicalPath(normalized)) return { disposition: "excluded_secret", destination: null };
  if (isAgentContextAudit(parts) || isEvidenceBackup(parts)) {
    return { disposition: "quarantine", destination: quarantineDestination(normalized) };
  }

  // Known pre-generation repositories whose paths changed in U1.
  const rewrites = [
    [["data", "catalog-drafts"], ["catalog-overlays", "drafts"]],
    [["data", "catalog-domain-proposals"], ["domain-overlays"]],
    [["data", "catalog"], ["domain-overlays"]],
    [["data", "audit", "catalog-events"], ["audit", "catalog-events"]],
    [["data", "audit", "advice-events"], ["audit", "advice-events"]],
    [["data", "audit", "advice-jobs"], ["audit", "advice-jobs"]],
    [["data", "audit", "rollback"], ["audit", "rollback", "legacy-data"]],
    [["catalog-drafts"], ["catalog-overlays", "drafts"]],
    [["catalog-domain-proposals"], ["domain-overlays"]],
    [["advice", "events"], ["audit", "advice-events"]],
    [["advice", "jobs"], ["audit", "advice-jobs"]],
    [["advice", "rollback"], ["audit", "rollback", "advice"]],
    [["advice"], ["audit", "advice-legacy"]],
  ];
  for (const [source, destination] of rewrites) {
    if (source.every((segment, index) => parts[index] === segment)) {
      return {
        disposition: "repository",
        destination: [...destination, ...parts.slice(source.length)].join("/"),
      };
    }
  }

  // The old materialized catalog can contain transaction/ownership data. It
  // is never copied to the active ProductCatalogOverlay. A separately hash-
  // bound catalog isolation projection is produced below.
  if (parts[0] === "data") {
    return { disposition: "quarantine", destination: quarantineDestination(normalized) };
  }
  if (parts[0] === "catalog-candidates") {
    return { disposition: "quarantine", destination: quarantineDestination(normalized) };
  }
  if (REGISTERED_ROOTS.has(parts[0])) {
    return { disposition: "repository", destination: normalized };
  }
  return { disposition: "quarantine", destination: quarantineDestination(normalized) };
}

async function hashFile(file) {
  const handle = await open(file, "r");
  const digest = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

async function inventoryDirectory(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const entries = [];
  if (!await pathExists(resolvedRoot)) {
    return signed({ schemaVersion: "runtime-tree-inventory-v1", rootMode: null, entries }, "inventoryHash");
  }
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("runtime source root is not a regular directory");
  const rootMode = rootMetadata.mode & 0o777;
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = confined(resolvedRoot, path.relative(resolvedRoot, directory), child.name);
      const logicalPath = slash(path.relative(resolvedRoot, absolute));
      if (options.excludeManagedTopLevel && !logicalPath.includes("/") && MANAGED_TOP_LEVEL.has(logicalPath)) continue;
      if (options.excludeLogicalPaths?.has(logicalPath)) continue;
      const metadata = await lstat(absolute);
      const mode = metadata.mode & 0o777;
      if (metadata.isSymbolicLink()) {
        entries.push({ logicalPath, kind: "symlink", mode, size: metadata.size });
        continue;
      }
      if (metadata.isDirectory()) {
        entries.push({ logicalPath, kind: "directory", mode, size: 0 });
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        entries.push({ logicalPath, kind: "special", mode, size: metadata.size });
        continue;
      }
      if (isSecretLogicalPath(logicalPath)) {
        // Secret content is deliberately neither opened nor hashed.
        entries.push({ logicalPath, kind: "file", mode, size: metadata.size, excludedReason: "secret_path" });
      } else {
        entries.push({ logicalPath, kind: "file", mode, size: metadata.size, sha256: await hashFile(absolute) });
      }
    }
  }
  await visit(resolvedRoot);
  return signed({ schemaVersion: "runtime-tree-inventory-v1", rootMode, entries }, "inventoryHash");
}

function sourceManifest(inventory, catalog = null) {
  const unsigned = {
    schemaVersion: "legacy-runtime-source-manifest-v1",
    migrationId: LEGACY_RUNTIME_MIGRATION_ID,
    inventoryHash: inventory.inventoryHash,
    rootMode: inventory.rootMode,
    entries: inventory.entries,
    ...(catalog ? {
      legacyCatalog: {
        sourceHash: catalog.sourceHash,
        sanitizedOutputHash: catalog.sanitizedOutputHash,
        removedFieldCount: catalog.removedFieldCount,
        quarantineCount: catalog.quarantineCount,
        quarantineHash: catalog.quarantineHash,
      },
    } : {}),
  };
  return signed(unsigned, "sourceManifestHash");
}

async function stableSourceManifest(root, catalog, options = {}) {
  const firstInventory = await inventoryDirectory(root, { excludeManagedTopLevel: true });
  const secondInventory = await inventoryDirectory(root, { excludeManagedTopLevel: true });
  if (firstInventory.inventoryHash !== secondInventory.inventoryHash) throw new Error("legacy source changed during inventory");
  const first = sourceManifest(firstInventory, catalog);
  const second = sourceManifest(secondInventory, catalog);
  if (first.sourceManifestHash !== second.sourceManifestHash) throw new Error("legacy source changed during inventory");
  if (options.rejectUnsafe !== false) {
    if (first.entries.some((entry) => entry.kind === "symlink")) throw new Error("legacy source contains a symbolic link");
    if (first.entries.some((entry) => entry.kind === "special")) throw new Error("legacy source contains an unsupported special entry");
  }
  return first;
}

function catalogManifestPath(options) {
  return path.resolve(options.catalogStaticManifestPath
    ?? path.join(process.cwd(), "data/migrations/catalog-user-data-v1.json"));
}

async function prepareLegacyCatalog(options = {}) {
  if (!options.legacyCatalogPath) return null;
  if (!SHA256.test(String(options.expectedLegacyCatalogHash ?? ""))) {
    throw new Error("legacy catalog migration requires an expected catalog hash");
  }
  const bytes = await readFile(path.resolve(options.legacyCatalogPath));
  const sourceHash = sha256Bytes(bytes);
  if (sourceHash !== options.expectedLegacyCatalogHash) throw new Error("legacy catalog source hash mismatch");
  const staticManifest = JSON.parse(await readFile(catalogManifestPath(options), "utf8"));
  if (staticManifest?.migrationId !== CATALOG_MIGRATION_ID
    || staticManifest.sourceHashBefore !== sourceHash
    || staticManifest.removedFieldCount !== 23
    || staticManifest.output?.quarantineCount !== 10
    || !SHA256.test(String(staticManifest.sourceHashAfter ?? ""))) {
    throw new Error("legacy catalog does not match the governed static migration manifest");
  }
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("legacy catalog record is unreadable"); }
  if (!Array.isArray(document?.skus) || !Array.isArray(staticManifest.entries)
    || staticManifest.entries.length !== document.skus.length) throw new Error("legacy catalog schema differs from its governed migration manifest");
  const byId = new Map(document.skus.map((sku) => [sku?.id, sku]));
  const valueFor = (sku, field) => {
    if (field === "price.paid") return sku.price?.paid;
    if (field.startsWith("tags.")) return field.slice(5);
    if (field === "name.user-marker") return sku.name;
    if (field === "price.user-note") return sku.price?.note;
    if (field === "harness.note.user-observation") return sku.harness?.note;
    if (field === "harness.crossCheck.user-attachment") return sku.harness?.crossCheck;
    if (field === "attrs.peripheralSocketsNote.user-observation") return sku.attrs?.peripheralSocketsNote;
    if (field === "portMap.source.user-observation") return sku.portMap?.source;
    throw new Error("governed legacy catalog field vocabulary is unsupported");
  };
  const removeField = (sku, field) => {
    if (field === "price.paid") delete sku.price.paid;
    else if (field.startsWith("tags.")) sku.tags = (sku.tags ?? []).filter((tag) => String(tag) !== field.slice(5));
    else if (field === "name.user-marker") sku.name = sku.name.replace(/\s*\(\s*(?:owned|user|已有|自有)[^)]*\)\s*/giu, "").trim();
    else if (field === "price.user-note") delete sku.price.note;
    else if (field === "harness.note.user-observation") delete sku.harness.note;
    else if (field === "harness.crossCheck.user-attachment") delete sku.harness.crossCheck;
    else if (field === "attrs.peripheralSocketsNote.user-observation") delete sku.attrs.peripheralSocketsNote;
    else if (field === "portMap.source.user-observation") delete sku.portMap.source;
    else throw new Error("governed legacy catalog field vocabulary is unsupported");
  };
  const sanitized = clone(document);
  const sanitizedById = new Map(sanitized.skus.map((sku) => [sku?.id, sku]));
  const quarantine = [];
  let removedFieldCount = 0;
  for (const entry of staticManifest.entries) {
    const sku = byId.get(entry.legacySkuId);
    const nextSku = sanitizedById.get(entry.legacySkuId);
    if (!sku || !nextSku || !Array.isArray(entry.sourceFields)) throw new Error("legacy catalog SKU inventory differs from its governed manifest");
    removedFieldCount += entry.sourceFields.length;
    if (!entry.sourceFields.length) continue;
    const values = Object.fromEntries(entry.sourceFields.map((field) => {
      const value = valueFor(sku, field);
      if (value === undefined) throw new Error("governed legacy catalog field is missing from its bound source");
      removeField(nextSku, field);
      return [field, value];
    }));
    quarantine.push({
      quarantineId: `catalog-user-${sha256Bytes(`${entry.legacySkuId}|${entry.sourceFields.join(",")}`).slice(0, 20)}`,
      skuId: entry.legacySkuId,
      sourceFields: entry.sourceFields,
      values,
      planId: null,
      status: "unattributed",
      reason: "requires explicit plan attribution",
    });
  }
  const sanitizedBytes = Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  const sanitizedOutputHash = sha256Bytes(sanitizedBytes);
  const quarantineHash = sha256Json({ schemaVersion: "1.0.0", migrationId: CATALOG_MIGRATION_ID, entries: quarantine });
  if (sanitizedOutputHash !== staticManifest.sourceHashAfter
    || removedFieldCount !== staticManifest.removedFieldCount
    || quarantine.length !== staticManifest.output.quarantineCount
    || quarantineHash !== staticManifest.output.quarantineHash) {
    throw new Error("legacy catalog projection differs from the governed static migration manifest");
  }
  const quarantinePayload = {
    schemaVersion: "catalog-user-data-quarantine-v1",
    migrationId: CATALOG_MIGRATION_ID,
    sourceCatalogHash: sourceHash,
    sanitizedOutputHash,
    removedFieldCount,
    entries: quarantine,
  };
  return {
    sourceHash,
    sanitizedOutputHash,
    removedFieldCount,
    quarantineCount: quarantine.length,
    quarantineHash,
    privateEnvelope: {
      schemaVersion: "catalog-user-data-quarantine-envelope-v1",
      kind: "catalog-user-data-quarantine",
      checksum: sha256Json(quarantinePayload),
      payload: quarantinePayload,
    },
  };
}

function migrationPaths(root) {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    journal: confined(resolvedRoot, "control", `${LEGACY_RUNTIME_MIGRATION_ID}.json`),
    lock: confined(resolvedRoot, "control", `.${LEGACY_RUNTIME_MIGRATION_ID}.lock`),
  };
}

async function readOptionalJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function readCoordinatorStateIfPresent(root) {
  const file = confined(root, "control", "active-pointer.json");
  const value = await readOptionalJson(file);
  if (!value) return null;
  const coordinator = new RuntimeCoordinator({ root });
  return coordinator.readState();
}

async function assertNoUnownedManagedLayout(root) {
  if (await pathExists(confined(root, "control", "active-pointer.json"))) return;
  const priorJournal = await readOptionalJson(confined(root, "control", `${LEGACY_RUNTIME_MIGRATION_ID}.json`));
  if (priorJournal) {
    assertSigned(priorJournal, "journalHash", "migration control journal");
    if (priorJournal.status === "rolled_back" && priorJournal.rollback?.strategy === "remove_pointer_only") return;
  }
  for (const reserved of MANAGED_TOP_LEVEL) {
    if (await pathExists(confined(root, reserved))) {
      throw new Error("legacy runtime uses a reserved generation-management path without an active pointer");
    }
  }
}

async function nextAvailableGeneration(root, state) {
  let maximum = state.runtimeGeneration;
  const generationsRoot = confined(root, "generations");
  for (const entry of await readdir(generationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
    maximum = Math.max(maximum, Number(entry.name));
  }
  return maximum + 1;
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateCopy(source, destination) {
  await ensurePrivateDirectory(path.dirname(destination));
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(source, temporary);
  const handle = await open(temporary, "r+");
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await fsyncDirectory(path.dirname(destination));
}

async function assertReadableRecord(file, logicalPath) {
  if (!JSON_RECORD_SUFFIXES.some((suffix) => logicalPath.endsWith(suffix))) return;
  let parsed;
  try {
    const raw = await readFile(file, "utf8");
    if (logicalPath.endsWith(".jsonl")) {
      parsed = raw.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    } else {
      parsed = JSON.parse(raw);
    }
  } catch {
    throw new Error("a migrated repository record is unreadable");
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "checksum")
      && Object.prototype.hasOwnProperty.call(value, "payload")) {
      if (!SHA256.test(String(value.checksum ?? "")) || sha256Json(value.payload) !== value.checksum) {
        throw new Error("a migrated repository record checksum is invalid");
      }
    }
  }
}

async function destinationConflict(destination, sourceHash) {
  if (!await pathExists(destination)) return false;
  const metadata = await lstat(destination);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("migration destination conflicts with an existing entry");
  return await hashFile(destination) !== sourceHash;
}

async function copyInventory(sourceRoot, inventory, stagingRoot, options = {}) {
  const copied = [];
  const excluded = [];
  const destinations = new Map();
  for (const entry of inventory.entries) {
    let mapped = options.identityMapping
      ? { disposition: "base_generation", destination: entry.logicalPath }
      : mapLegacyRuntimePath(entry.logicalPath);
    if (entry.kind === "symlink" || entry.kind === "special") throw new Error("migration source contains an unsafe entry");
    if (mapped.disposition === "excluded_secret" || entry.excludedReason) {
      excluded.push({ logicalPathHash: sha256Bytes(entry.logicalPath), reason: "secret_path" });
      continue;
    }
    if (entry.kind === "directory") {
      // Legacy directory names cannot establish repository authority by
      // themselves. Parents are created from accepted file destinations, so a
      // quarantined plan record cannot leave an empty plan-id directory that
      // makes FilePlanRepository.list() fail. Identity copies preserve empty
      // directories from an already-active generation.
      if (options.identityMapping) {
        if (!mapped.destination) throw new Error("migration destination mapping is incomplete");
        await ensurePrivateDirectory(confined(stagingRoot, ...mapped.destination.split("/")));
      }
      continue;
    }
    const source = confined(sourceRoot, ...entry.logicalPath.split("/"));
    let sourceBytes = await readFile(source);
    const transactionCandidate = transactionProjection(entry.logicalPath, sourceBytes);
    if (options.identityMapping && (transactionCandidate.excludedReason || transactionCandidate.projected)) {
      throw new Error("current active generation contains legacy transaction image data");
    }
    const projection = options.identityMapping ? { bytes: sourceBytes, projected: false } : transactionCandidate;
    if (projection.excludedReason) {
      excluded.push({ logicalPathHash: sha256Bytes(entry.logicalPath), reason: projection.excludedReason });
      continue;
    }
    sourceBytes = projection.bytes;
    const contentSecret = secretContentKind(sourceBytes);
    if (contentSecret) {
      if (options.identityMapping) throw new Error("current active generation contains secret-bearing repository content");
      excluded.push({ logicalPathHash: sha256Bytes(entry.logicalPath), reason: contentSecret });
      continue;
    }
    if (!options.identityMapping && mapped.disposition === "repository"
      && (projection.forceQuarantine || !currentAuthorityEligible(mapped.destination, sourceBytes))) {
      mapped = { disposition: "quarantine", destination: quarantineDestination(entry.logicalPath) };
    }
    const destinationLogical = mapped.destination;
    if (!destinationLogical) throw new Error("migration destination mapping is incomplete");
    const prior = destinations.get(destinationLogical);
    if (prior && prior !== entry.logicalPath) throw new Error("two legacy entries map to the same destination");
    destinations.set(destinationLogical, entry.logicalPath);
    const destination = confined(stagingRoot, ...destinationLogical.split("/"));
    const destinationHash = sha256Bytes(sourceBytes);
    if (await destinationConflict(destination, destinationHash)) {
      throw new Error("migration destination conflicts with existing repository data");
    }
    if (!await pathExists(destination)) {
      if (projection.projected) await atomicWriteFile(destination, sourceBytes);
      else await privateCopy(source, destination);
    }
    const copiedHash = await hashFile(destination);
    if (copiedHash !== destinationHash) throw new Error("migrated file hash differs from its verified projection");
    if ((await lstat(destination)).mode % 512 !== PRIVATE_FILE_MODE) throw new Error("migrated file permissions are not private");
    await assertReadableRecord(destination, destinationLogical);
    copied.push({
      sourceLogicalPath: entry.logicalPath,
      destinationLogicalPath: destinationLogical,
      disposition: mapped.disposition,
      size: entry.size,
      sourceSha256: entry.sha256,
      sha256: destinationHash,
      ...(projection.projected ? { projection: "private_image_removed" } : {}),
    });
  }
  return { copied, excluded };
}

async function assertPrivateTree(root) {
  const inventory = await inventoryDirectory(root);
  if (inventory.entries.some((entry) => entry.kind === "symlink" || entry.kind === "special")) {
    throw new Error("staged generation contains an unsafe entry");
  }
  if (inventory.entries.some((entry) => entry.kind === "directory" && entry.mode !== PRIVATE_DIRECTORY_MODE)) {
    throw new Error("staged generation contains a non-private directory");
  }
  if (inventory.entries.some((entry) => entry.kind === "file" && entry.mode !== PRIVATE_FILE_MODE)) {
    throw new Error("staged generation contains a non-private file");
  }
  return inventory;
}

function summaryFromSource(source) {
  const files = source.entries.filter((entry) => entry.kind === "file");
  const directories = source.entries.filter((entry) => entry.kind === "directory");
  const symlinks = source.entries.filter((entry) => entry.kind === "symlink");
  const secrets = source.entries.filter((entry) => entry.excludedReason === "secret_path");
  const quarantined = source.entries.filter((entry) => {
    const mapping = mapLegacyRuntimePath(entry.logicalPath);
    return mapping.disposition === "quarantine";
  });
  return {
    entryCount: source.entries.length,
    fileCount: files.length,
    directoryCount: directories.length,
    symlinkCount: symlinks.length,
    secretPathCount: secrets.length,
    quarantineEntryCount: quarantined.length,
    byteCount: files.reduce((sum, entry) => sum + entry.size, 0),
  };
}

/** Default read-only migration planning. No manifest is written by this call. */
export async function planLegacyRuntimeMigration(options = {}) {
  const root = path.resolve(options.runtimeRoot ?? path.join(process.cwd(), "runtime"));
  await assertNoUnownedManagedLayout(root);
  const catalog = await prepareLegacyCatalog(options);
  const source = await stableSourceManifest(root, catalog, { rejectUnsafe: false });
  return {
    schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
    migrationId: LEGACY_RUNTIME_MIGRATION_ID,
    mode: "dry-run",
    status: source.entries.some((entry) => entry.kind === "symlink" || entry.kind === "special") ? "blocked" : "ready",
    sourceManifestHash: source.sourceManifestHash,
    sourceInventoryHash: source.inventoryHash,
    summary: summaryFromSource(source),
    catalog: catalog ? {
      sourceHash: catalog.sourceHash,
      sanitizedOutputHash: catalog.sanitizedOutputHash,
      removedFieldCount: catalog.removedFieldCount,
      quarantineCount: catalog.quarantineCount,
      quarantineHash: catalog.quarantineHash,
    } : null,
    // Programmatic callers may persist this private manifest in their own
    // secure change record. CLI output deliberately omits the entry list.
    sourceManifest: source,
  };
}

async function verifyPreparedGeneration(generationRoot, prepared) {
  const activeManifestFile = confined(generationRoot, "migrations", LEGACY_RUNTIME_MIGRATION_ID, "manifest.json");
  const activeManifest = assertSigned(await readOptionalJson(activeManifestFile), "manifestHash", "migration generation manifest");
  if (activeManifest.sourceManifestHash !== prepared.sourceManifestHash
    || activeManifest.stagedInventoryHash !== prepared.stagedInventoryHash) {
    throw new Error("migration generation manifest does not match its control journal");
  }
  const stagedInventory = await assertPrivateTree(generationRoot);
  const payloadInventory = await inventoryDirectory(generationRoot, {
    excludeLogicalPaths: new Set([`migrations/${LEGACY_RUNTIME_MIGRATION_ID}/manifest.json`]),
  });
  // Before activation this is an exact byte/directory closure check. After a
  // committed generation starts serving, repositories may legitimately add
  // lock directories and new records; the immutable migrated payload entries
  // below remain individually hash-verified while Doctor owns live closure.
  if (activeManifest.status === "prepared" && payloadInventory.inventoryHash !== activeManifest.stagedInventoryHash) {
    throw new Error("migration generation payload inventory differs from its prepared manifest");
  }
  // The committed/prepared manifest status can change after the staged hash was
  // calculated. Its own checksum is verified above; all copied payload hashes
  // are verified individually below.
  for (const entry of [...(activeManifest.baseCopied ?? []), ...(activeManifest.copied ?? [])]) {
    const file = confined(generationRoot, ...entry.destinationLogicalPath.split("/"));
    if (!await pathExists(file) || await hashFile(file) !== entry.sha256) throw new Error("migrated repository payload verification failed");
    await assertReadableRecord(file, entry.destinationLogicalPath);
  }
  const catalogFile = activeManifest.catalog?.destinationLogicalPath;
  if (catalogFile) {
    const file = confined(generationRoot, ...catalogFile.split("/"));
    const envelope = JSON.parse(await readFile(file, "utf8"));
    if (envelope?.kind !== "catalog-user-data-quarantine"
      || envelope.checksum !== sha256Json(envelope.payload)
      || envelope.payload?.removedFieldCount !== 23
      || envelope.payload?.entries?.length !== 10) {
      throw new Error("private catalog quarantine verification failed");
    }
  }
  return { activeManifest, stagedInventory };
}

async function writeJournal(file, value) {
  await atomicWriteJson(file, signed(value, "journalHash"));
  return signed(value, "journalHash");
}

async function readJournal(file) {
  const value = await readOptionalJson(file);
  return value ? assertSigned(value, "journalHash", "migration control journal") : null;
}

async function finishCommittedJournal(paths, coordinator, journal, options = {}) {
  const state = await coordinator.readState();
  if (state.activeRoot !== journal.targetActiveRoot || state.runtimeGeneration !== journal.targetRuntimeGeneration) {
    throw new Error("migration pointer does not select the prepared generation");
  }
  const generationRoot = coordinator.activeRoot(state);
  const verified = await verifyPreparedGeneration(generationRoot, journal);
  const manifestFile = confined(generationRoot, "migrations", LEGACY_RUNTIME_MIGRATION_ID, "manifest.json");
  const committedManifest = signed({
    ...omitHash(verified.activeManifest, "manifestHash"),
    status: "committed",
    committedAt: timestamp(options.now),
    runtimeGeneration: state.runtimeGeneration,
  }, "manifestHash");
  await atomicWriteJson(manifestFile, committedManifest);
  return writeJournal(paths.journal, {
    ...omitHash(journal, "journalHash"),
    status: "committed",
    committedAt: committedManifest.committedAt,
    committedPointerRevision: state.revision,
    committedManifestHash: committedManifest.manifestHash,
  });
}

async function recoverInterrupted(paths, coordinator, journal, options = {}) {
  if (!journal || !["preparing", "prepared"].includes(journal.status)) return journal;
  const state = await coordinator.readState();
  if (journal.status === "prepared" && state.activeRoot === journal.targetActiveRoot) {
    return finishCommittedJournal(paths, coordinator, journal, options);
  }
  if (state.runtimeGeneration !== journal.priorState.runtimeGeneration
    || state.activeRoot !== journal.priorState.activeRoot
    || state.revision !== journal.priorState.revision) {
    throw new Error("runtime changed while recovering an interrupted migration");
  }
  const staging = confined(paths.root, journal.stagingRelativePath);
  const abandonedTarget = confined(paths.root, journal.targetActiveRoot);
  if (await pathExists(abandonedTarget)) {
    if (await pathExists(staging)) throw new Error("interrupted migration has two staging candidates");
    await ensurePrivateDirectory(path.dirname(staging));
    await rename(abandonedTarget, staging);
  }
  if (await pathExists(staging)) await coordinator.discardStagingGeneration(staging);
  return writeJournal(paths.journal, {
    ...omitHash(journal, "journalHash"),
    status: "recovered_precommit",
    recoveredAt: timestamp(options.now),
  });
}

/** Apply only after a dry-run sourceManifestHash has been reviewed. */
export async function applyLegacyRuntimeMigration(options = {}) {
  if (!SHA256.test(String(options.expectedSourceManifestHash ?? ""))) {
    throw new Error("migration apply requires the expected dry-run source manifest hash");
  }
  const paths = migrationPaths(options.runtimeRoot ?? path.join(process.cwd(), "runtime"));
  await assertNoUnownedManagedLayout(paths.root);
  const catalog = await prepareLegacyCatalog(options);
  const beforeLock = await stableSourceManifest(paths.root, catalog);
  if (beforeLock.sourceManifestHash !== options.expectedSourceManifestHash) throw new Error("legacy source manifest hash mismatch");

  await ensurePrivateDirectory(path.dirname(paths.lock));
  return withDirectoryLock(paths.lock, async () => {
    const source = await stableSourceManifest(paths.root, catalog);
    if (source.sourceManifestHash !== options.expectedSourceManifestHash) throw new Error("legacy source changed before apply");
    const priorStateBeforeInitialize = await readCoordinatorStateIfPresent(paths.root);
    const coordinator = options.coordinator ?? new RuntimeCoordinator({ root: paths.root, now: options.now, lockTimeoutMs: options.lockTimeoutMs });
    await coordinator.initialize(options.appVersion);
    let journal = await readJournal(paths.journal);
    journal = await recoverInterrupted(paths, coordinator, journal, options);
    const priorStateExistedForRun = journal?.priorStateExisted ?? Boolean(priorStateBeforeInitialize);
    if (journal?.status === "committed") {
      const state = await coordinator.readState();
      if (state.activeRoot !== journal.targetActiveRoot) throw new Error("migration is committed but no longer active");
      await verifyPreparedGeneration(coordinator.activeRoot(state), journal);
      return clone(journal);
    }
    if (journal && !["recovered_precommit", "rolled_back"].includes(journal.status)) {
      throw new Error("migration control journal is not apply-ready");
    }

    const lease = await coordinator.acquireMaintenanceLease(`migration:${LEGACY_RUNTIME_MIGRATION_ID}`, { ttlMs: options.leaseTtlMs ?? 300_000 });
    let staging = null;
    try {
      // Acquire the maintenance fence before the final source check. Legacy
      // writers do not understand the fence, so the exact manifest is checked
      // again immediately before the pointer commit as well.
      const fencedSource = await stableSourceManifest(paths.root, catalog);
      if (fencedSource.sourceManifestHash !== source.sourceManifestHash) throw new Error("legacy source changed after maintenance fence");
      const priorState = await coordinator.readState();
      const priorActiveRoot = coordinator.activeRoot(priorState);
      const baseInventory = await inventoryDirectory(priorActiveRoot);
      if (baseInventory.entries.some((entry) => entry.kind === "symlink" || entry.kind === "special" || entry.excludedReason)) {
        throw new Error("current active generation is unsafe to merge");
      }
      staging = await coordinator.createStagingGeneration(lease.token);
      const targetRuntimeGeneration = await nextAvailableGeneration(paths.root, priorState);
      const targetActiveRoot = `generations/${targetRuntimeGeneration}`;
      const preparing = await writeJournal(paths.journal, {
        schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
        migrationId: LEGACY_RUNTIME_MIGRATION_ID,
        status: "preparing",
        preparedAt: timestamp(options.now),
        sourceManifestHash: source.sourceManifestHash,
        sourceInventoryHash: source.inventoryHash,
        sourceSummary: summaryFromSource(source),
        priorStateExisted: priorStateExistedForRun,
        priorState,
        priorActiveInventoryHash: baseInventory.inventoryHash,
        stagingRelativePath: slash(path.relative(paths.root, staging)),
        targetActiveRoot,
        targetRuntimeGeneration,
      });

      const baseCopy = await copyInventory(priorActiveRoot, baseInventory, staging, { identityMapping: true });
      const legacyCopy = await copyInventory(paths.root, source, staging);
      let catalogDestination = null;
      if (catalog) {
        catalogDestination = `migrations/${CATALOG_MIGRATION_ID}/quarantine/catalog-user-data.json`;
        const file = confined(staging, ...catalogDestination.split("/"));
        if (await pathExists(file)) throw new Error("catalog quarantine destination already exists");
        await atomicWriteJson(file, catalog.privateEnvelope);
        await assertReadableRecord(file, catalogDestination);
      }
      const manifestFile = confined(staging, "migrations", LEGACY_RUNTIME_MIGRATION_ID, "manifest.json");
      // The manifest's parent is part of the frozen tree, while the signed
      // manifest file itself is excluded because its status/hash advances from
      // prepared to committed after the pointer commit.
      await ensurePrivateDirectory(path.dirname(manifestFile));
      const preManifestInventory = await assertPrivateTree(staging);
      const activeManifest = signed({
        schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
        migrationId: LEGACY_RUNTIME_MIGRATION_ID,
        status: "prepared",
        preparedAt: preparing.preparedAt,
        sourceManifestHash: source.sourceManifestHash,
        sourceInventoryHash: source.inventoryHash,
        baseInventoryHash: baseInventory.inventoryHash,
        stagedInventoryHash: preManifestInventory.inventoryHash,
        copied: legacyCopy.copied,
        baseCopied: baseCopy.copied,
        excluded: legacyCopy.excluded,
        ...(catalog ? {
          catalog: {
            sourceHash: catalog.sourceHash,
            sanitizedOutputHash: catalog.sanitizedOutputHash,
            removedFieldCount: catalog.removedFieldCount,
            quarantineCount: catalog.quarantineCount,
            quarantineHash: catalog.quarantineHash,
            destinationLogicalPath: catalogDestination,
          },
        } : {}),
      }, "manifestHash");
      await atomicWriteJson(manifestFile, activeManifest);
      const stagedWithManifest = await assertPrivateTree(staging);
      const prepared = await writeJournal(paths.journal, {
        ...omitHash(preparing, "journalHash"),
        status: "prepared",
        stagedInventoryHash: activeManifest.stagedInventoryHash,
        stagedTreeHash: stagedWithManifest.inventoryHash,
        preparedManifestHash: activeManifest.manifestHash,
      });
      if (options.testFault === "after_prepare") throw new Error("injected migration failure after prepare");
      await verifyPreparedGeneration(staging, prepared);
      const finalSource = await stableSourceManifest(paths.root, catalog);
      if (finalSource.sourceManifestHash !== source.sourceManifestHash) throw new Error("legacy source changed before pointer commit");
      const activated = await coordinator.activateStagingGeneration(staging, priorState.runtimeGeneration, lease.token, { minimumGeneration: targetRuntimeGeneration });
      staging = null;
      if (activated.activeRoot !== targetActiveRoot || activated.runtimeGeneration !== targetRuntimeGeneration) {
        throw new Error("runtime pointer activated an unexpected generation");
      }
      if (options.testFault === "after_pointer_commit") throw new Error("injected migration failure after pointer commit");
      return clone(await finishCommittedJournal(paths, coordinator, prepared, options));
    } finally {
      if (staging && await pathExists(staging)) {
        // Retain prepared staging for deterministic crash recovery. An error
        // before a prepared journal is safe to discard.
        const latest = await readJournal(paths.journal).catch(() => null);
        if (latest?.status !== "prepared") await coordinator.discardStagingGeneration(staging).catch(() => undefined);
      }
      await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined);
    }
  }, { timeoutMs: options.lockTimeoutMs ?? 5_000 });
}

export async function verifyLegacyRuntimeMigration(options = {}) {
  const paths = migrationPaths(options.runtimeRoot ?? path.join(process.cwd(), "runtime"));
  const journal = await readJournal(paths.journal);
  if (!journal || journal.status !== "committed") throw new Error("no committed legacy runtime migration was found");
  const coordinator = options.coordinator ?? new RuntimeCoordinator({ root: paths.root, now: options.now });
  const state = await coordinator.readState();
  if (state.activeRoot !== journal.targetActiveRoot || state.runtimeGeneration !== journal.targetRuntimeGeneration) {
    throw new Error("committed legacy migration is not the active generation");
  }
  const { activeManifest } = await verifyPreparedGeneration(coordinator.activeRoot(state), journal);
  const catalog = await prepareLegacyCatalog(options);
  const currentSource = await stableSourceManifest(paths.root, catalog);
  const sourcePreserved = currentSource.sourceManifestHash === journal.sourceManifestHash;
  if (!sourcePreserved) throw new Error("legacy source changed after migration");
  return {
    schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
    migrationId: LEGACY_RUNTIME_MIGRATION_ID,
    status: "verified",
    runtimeGeneration: state.runtimeGeneration,
    sourceManifestHash: journal.sourceManifestHash,
    manifestHash: activeManifest.manifestHash,
    copiedFileCount: activeManifest.copied.length,
    excludedSecretCount: activeManifest.excluded.length,
    sourcePreserved,
  };
}

/**
 * Read-only service-start gate. Fresh empty runtimes and already-initialized
 * empty active generations pass. A legacy tree passes only when a signed,
 * committed migration journal selects the active verified generation and the
 * frozen legacy inventory is unchanged.
 */
export async function preflightLegacyRuntimeMigration(options = {}) {
  const paths = migrationPaths(options.runtimeRoot ?? path.join(process.cwd(), "runtime"));
  const stableInventory = async (inventoryOptions) => {
    const first = await inventoryDirectory(paths.root, inventoryOptions);
    const second = await inventoryDirectory(paths.root, inventoryOptions);
    if (first.inventoryHash !== second.inventoryHash) throw new Error("runtime changed during service preflight");
    return first;
  };
  const state = await readCoordinatorStateIfPresent(paths.root);
  if (!state) {
    const unmanaged = await stableInventory({ excludeManagedTopLevel: false });
    if (unmanaged.entries.length === 0) {
      return { schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA, migrationId: LEGACY_RUNTIME_MIGRATION_ID, status: "ready_fresh", sourceInventoryHash: unmanaged.inventoryHash };
    }
    throw new Error("legacy runtime migration is required before service startup");
  }
  const source = await stableInventory({ excludeManagedTopLevel: true });
  const journal = await readJournal(paths.journal);
  if (source.entries.length === 0) {
    return {
      schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
      migrationId: LEGACY_RUNTIME_MIGRATION_ID,
      status: "ready_active",
      runtimeGeneration: state.runtimeGeneration,
      sourceInventoryHash: source.inventoryHash,
    };
  }
  if (!journal || journal.status !== "committed" || journal.targetActiveRoot !== state.activeRoot
    || journal.targetRuntimeGeneration !== state.runtimeGeneration || journal.sourceInventoryHash !== source.inventoryHash) {
    throw new Error("legacy runtime migration verification is required before service startup");
  }
  const coordinator = new RuntimeCoordinator({ root: paths.root });
  const marker = assertSigned(
    await readOptionalJson(confined(coordinator.activeRoot(state), "migrations", LEGACY_RUNTIME_MIGRATION_ID, "manifest.json")),
    "manifestHash",
    "migration generation manifest",
  );
  if (marker.status !== "committed" || marker.manifestHash !== journal.committedManifestHash
    || marker.sourceManifestHash !== journal.sourceManifestHash) {
    throw new Error("legacy runtime migration marker no longer matches its committed journal");
  }
  return {
    schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
    migrationId: LEGACY_RUNTIME_MIGRATION_ID,
    status: "ready_migrated",
    runtimeGeneration: state.runtimeGeneration,
    sourceInventoryHash: source.inventoryHash,
    manifestHash: journal.committedManifestHash,
  };
}

export async function planLegacyRuntimeRollback(options = {}) {
  const paths = migrationPaths(options.runtimeRoot ?? path.join(process.cwd(), "runtime"));
  const journal = await readJournal(paths.journal);
  if (!journal || journal.status !== "committed") throw new Error("migration is not rollback-ready");
  const coordinator = options.coordinator ?? new RuntimeCoordinator({ root: paths.root, now: options.now });
  const state = await coordinator.readState();
  const safe = state.activeRoot === journal.targetActiveRoot
    && state.runtimeGeneration === journal.targetRuntimeGeneration
    && state.revision === journal.committedPointerRevision;
  return {
    schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
    migrationId: LEGACY_RUNTIME_MIGRATION_ID,
    mode: "dry-run",
    status: safe ? "ready" : "blocked",
    strategy: journal.priorStateExisted ? "reactivate_verified_generation" : "remove_pointer_only",
    currentRuntimeGeneration: state.runtimeGeneration,
    priorInventoryHash: journal.priorActiveInventoryHash,
    sourceManifestHash: journal.sourceManifestHash,
  };
}

async function copyGenerationForRollback(coordinator, journal, lease, options) {
  const priorRoot = coordinator.activeRoot(journal.priorState);
  const current = await inventoryDirectory(priorRoot);
  if (current.inventoryHash !== journal.priorActiveInventoryHash) throw new Error("rollback source generation hash mismatch");
  const staging = await coordinator.createStagingGeneration(lease.token);
  try {
    await copyInventory(priorRoot, current, staging, { identityMapping: true });
    const copied = await inventoryDirectory(staging);
    // Empty registered directories can differ only in directory presence; all
    // prior file bytes are checked by copyInventory and are the rollback data.
    if (copied.entries.some((entry) => entry.kind === "symlink" || entry.kind === "special" || entry.excludedReason)) {
      throw new Error("rollback staging generation is unsafe");
    }
    return await coordinator.activateStagingGeneration(staging, journal.targetRuntimeGeneration, lease.token);
  } catch (error) {
    if (await pathExists(staging)) await coordinator.discardStagingGeneration(staging).catch(() => undefined);
    throw error;
  }
}

export async function rollbackLegacyRuntimeMigration(options = {}) {
  if (options.apply !== true) return planLegacyRuntimeRollback(options);
  const paths = migrationPaths(options.runtimeRoot ?? path.join(process.cwd(), "runtime"));
  await ensurePrivateDirectory(path.dirname(paths.lock));
  return withDirectoryLock(paths.lock, async () => {
    const journal = await readJournal(paths.journal);
    if (!journal || journal.status !== "committed") throw new Error("migration is not rollback-ready");
    const coordinator = options.coordinator ?? new RuntimeCoordinator({ root: paths.root, now: options.now, lockTimeoutMs: options.lockTimeoutMs });
    const plan = await planLegacyRuntimeRollback({ ...options, coordinator });
    if (plan.status !== "ready") throw new Error("rollback refused because the active runtime has newer writes");
    const lease = await coordinator.acquireMaintenanceLease(`rollback:${LEGACY_RUNTIME_MIGRATION_ID}`, { ttlMs: options.leaseTtlMs ?? 300_000 });
    try {
      let result;
      if (journal.priorStateExisted) {
        const activated = await copyGenerationForRollback(coordinator, journal, lease, options);
        result = { strategy: "reactivate_verified_generation", runtimeGeneration: activated.runtimeGeneration, activeRoot: activated.activeRoot };
      } else {
        const stateFile = coordinator.stateFile;
        const state = await coordinator.readState();
        if (state.activeRoot !== journal.targetActiveRoot || state.revision !== journal.committedPointerRevision) {
          throw new Error("pointer-only rollback precondition changed");
        }
        await unlink(stateFile);
        await fsyncDirectory(path.dirname(stateFile));
        result = { strategy: "remove_pointer_only", runtimeGeneration: null, activeRoot: null };
      }
      const rolledBack = await writeJournal(paths.journal, {
        ...omitHash(journal, "journalHash"),
        status: "rolled_back",
        rolledBackAt: timestamp(options.now),
        rollback: result,
      });
      return {
        schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
        migrationId: LEGACY_RUNTIME_MIGRATION_ID,
        status: "rolled_back",
        ...result,
        journalHash: rolledBack.journalHash,
      };
    } finally {
      await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined);
    }
  }, { timeoutMs: options.lockTimeoutMs ?? 5_000 });
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

export function cliSummary(result) {
  return {
    schemaVersion: result.schemaVersion,
    migrationId: result.migrationId,
    mode: result.mode,
    status: result.status,
    sourceManifestHash: result.sourceManifestHash,
    sourceInventoryHash: result.sourceInventoryHash,
    manifestHash: result.manifestHash,
    journalHash: result.journalHash,
    runtimeGeneration: result.runtimeGeneration,
    summary: result.summary,
    catalog: result.catalog ? {
      sourceHash: result.catalog.sourceHash,
      sanitizedOutputHash: result.catalog.sanitizedOutputHash,
      removedFieldCount: result.catalog.removedFieldCount,
      quarantineCount: result.catalog.quarantineCount,
      quarantineHash: result.catalog.quarantineHash,
    } : undefined,
    copiedFileCount: result.copiedFileCount,
    excludedSecretCount: result.excludedSecretCount,
    sourcePreserved: result.sourcePreserved,
    strategy: result.strategy,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const common = {
    runtimeRoot: argumentValue(argv, "--runtime-root"),
    expectedSourceManifestHash: argumentValue(argv, "--expected-source-manifest-hash"),
    legacyCatalogPath: argumentValue(argv, "--legacy-catalog"),
    expectedLegacyCatalogHash: argumentValue(argv, "--expected-legacy-catalog-hash"),
    catalogStaticManifestPath: argumentValue(argv, "--catalog-static-manifest"),
  };
  const operation = argv.includes("--verify")
    ? verifyLegacyRuntimeMigration(common)
    : argv.includes("--preflight")
      ? preflightLegacyRuntimeMigration(common)
    : argv.includes("--rollback")
      ? rollbackLegacyRuntimeMigration({ ...common, apply: argv.includes("--apply") })
      : argv.includes("--apply")
        ? applyLegacyRuntimeMigration(common)
        : planLegacyRuntimeMigration(common);
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(cliSummary(result))}\n`))
    .catch(() => {
      // Error output is deliberately a stable status/code only. It never
      // includes file contents, catalog values, session records, or paths.
      process.stderr.write(`${JSON.stringify({
        schemaVersion: LEGACY_RUNTIME_MIGRATION_SCHEMA,
        migrationId: LEGACY_RUNTIME_MIGRATION_ID,
        status: "failed",
        errorCode: "legacy_runtime_migration_failed",
      })}\n`);
      process.exitCode = 1;
    });
}

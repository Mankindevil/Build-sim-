import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { catalogPath as defaultCatalogPath, root as repoRoot, atomicWriteJson, readJson, restoreLatestRollback } from "../store.mjs";
import { registryForUrl } from "./registry.mjs";
import { validateOfficialUrl } from "./security.mjs";
import { findCandidate } from "./service.mjs";
import { catalogCandidateInputHash } from "./contracts.mjs";

const acceptResults = new Map();
const drafts = new Map();
const catalogWriteLocks = new Map();
const draftWriteLocks = new Map();
const draftTransitionLocks = new Map();

const REQUIRED_FIELDS = Object.freeze({
  case: ["dims.lengthMm", "dims.widthMm", "dims.heightMm"],
  motherboard: ["dims.lengthMm", "dims.widthMm"],
  cpu: ["power.tdpW"],
  psu: ["power.ratedW"],
  cooler: ["dims.heightMm"],
  gpu: ["dims.lengthMm", "dims.slots", "power.tgpW"],
  memory: ["attrs.capacity"],
  storage: ["attrs.capacity", "attrs.interface"],
  hba: ["attrs.interface"],
  fan: ["dims.lengthMm"],
  accessory: [],
});

const OFFICIAL_PAGE_KINDS = new Set(["product", "spec", "datasheet", "support"]);
const OFFICIAL_FIELD_SOURCE_KINDS = new Set(["official-page", "official-pdf", "official-ocr-pdf", "official-rendered-page"]);
const IDENTITY_FIELDS = ["brand", "model", "mpn"];
const CATEGORY_FIELDS = Object.freeze({
  case: ["dims.lengthMm", "dims.widthMm", "dims.heightMm"],
  motherboard: ["dims.lengthMm", "dims.widthMm", "dims.heightMm"],
  cpu: ["power.tdpW", "attrs.maxOperatingTempC"],
  psu: ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "power.ratedW", "attrs.noiseDba", "attrs.maxOperatingTempC"],
  cooler: ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "attrs.noiseDba", "attrs.maxOperatingTempC"],
  gpu: ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "dims.thicknessMm", "dims.slots", "power.tgpW", "attrs.capacity", "attrs.interface", "attrs.outputs", "attrs.recommendedPsuW", "attrs.noiseDba", "attrs.maxOperatingTempC", "harness.pciePower"],
  memory: ["dims.heightMm", "attrs.capacity", "attrs.interface"],
  storage: ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "power.ratedW", "attrs.capacity", "attrs.interface", "attrs.maxOperatingTempC"],
  hba: ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "power.tdpW", "attrs.interface"],
  fan: ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "power.ratedW", "attrs.noiseDba"],
  accessory: ["dims.lengthMm", "dims.widthMm", "dims.heightMm", "attrs.interface"],
});
const NUMERIC_BOUNDS = Object.freeze({
  "dims.lengthMm": [0.1, 2_000],
  "dims.widthMm": [0.1, 2_000],
  "dims.heightMm": [0.1, 2_000],
  "dims.thicknessMm": [0.1, 500],
  "dims.slots": [0.5, 10],
  "power.tdpW": [0.1, 5_000],
  "power.tgpW": [0.1, 5_000],
  "power.ratedW": [0.1, 5_000],
  "attrs.recommendedPsuW": [1, 5_000],
  "attrs.noiseDba": [0, 200],
  "attrs.maxOperatingTempC": [-100, 300],
});
const EVIDENCE_LEVELS = new Set(["official", "standard", "inferred", "unknown"]);
const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);
const GPU_SLOT_PITCH_MM = 20.32;

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function jsonHash(value) { return sha256(JSON.stringify(value)); }
function safeText(value) { return String(value ?? "").slice(0, 240); }
function dateKey(value = now()) { return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : now().slice(0, 10); }
function getPath(object, pathName) { return pathName.split(".").reduce((value, key) => value?.[key], object); }
function isAllowedField(category, field) {
  if (typeof field !== "string" || !field || field.split(".").some((part) => !part || FORBIDDEN_PATH_PARTS.has(part))) return false;
  return IDENTITY_FIELDS.includes(field) || (Object.hasOwn(CATEGORY_FIELDS, category) && CATEGORY_FIELDS[category].includes(field));
}
function setPath(object, pathName, value, category) {
  if (!isAllowedField(category, pathName)) throw new Error(`field path is not allowed for ${category}: ${pathName}`);
  const parts = pathName.split(".");
  const leaf = parts.pop();
  let target = object;
  for (const part of parts) target = target[part] ??= {};
  target[leaf] = value;
}
function missingValue(value) { return value === undefined || value === null || value === ""; }
function withCatalogWriteLock(catalogPath, operation) {
  const key = path.resolve(catalogPath);
  const prior = catalogWriteLocks.get(key) ?? Promise.resolve();
  const run = prior.then(operation, operation);
  const tail = run.then(() => undefined, () => undefined);
  catalogWriteLocks.set(key, tail);
  void tail.then(() => { if (catalogWriteLocks.get(key) === tail) catalogWriteLocks.delete(key); });
  return run;
}
function withDraftWriteLock(draftFile, operation) {
  const key = path.resolve(draftFile);
  const prior = draftWriteLocks.get(key) ?? Promise.resolve();
  const run = prior.then(operation, operation);
  const tail = run.then(() => undefined, () => undefined);
  draftWriteLocks.set(key, tail);
  void tail.then(() => { if (draftWriteLocks.get(key) === tail) draftWriteLocks.delete(key); });
  return run;
}
function withDraftTransitionLock(draftRoot, draftId, operation) {
  const key = `${path.resolve(draftRoot)}\0${draftId}`;
  const prior = draftTransitionLocks.get(key) ?? Promise.resolve();
  const run = prior.then(operation, operation);
  const tail = run.then(() => undefined, () => undefined);
  draftTransitionLocks.set(key, tail);
  void tail.then(() => { if (draftTransitionLocks.get(key) === tail) draftTransitionLocks.delete(key); });
  return run;
}
function slug(value) { return String(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "candidate"; }
function fieldMap(fields = []) { return new Map(fields.map((field) => [field.field, field])); }
function canonicalFields(candidate) { return candidate.fields ?? []; }
function requiredFields(category) { return Object.hasOwn(REQUIRED_FIELDS, category) ? REQUIRED_FIELDS[category] : []; }
function sanitizeValue(value) {
  if (typeof value === "string") return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 512);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeValue(entry));
  return value;
}
function sanitizeField(field) {
  return {
    provenanceId: safeText(field.provenanceId),
    field: safeText(field.field),
    value: sanitizeValue(field.value),
    evidence: safeText(field.evidence),
    sourceUrl: safeText(field.sourceUrl),
    sourceKind: safeText(field.sourceKind),
    retrievedAt: safeText(field.retrievedAt),
    extractor: safeText(field.extractor),
    ...(field.locator ? { locator: safeText(field.locator) } : {}),
    ...(field.snippet ? { snippet: safeText(field.snippet) } : {}),
    ...(Number.isFinite(field.confidence) ? { confidence: field.confidence } : {}),
    ...(field.note ? { note: safeText(field.note) } : {}),
    ...(field.derivedFromProvenanceId ? { derivedFromProvenanceId: safeText(field.derivedFromProvenanceId) } : {}),
  };
}
function catalogVersion(catalog) {
  const current = String(catalog.catalogVersion ?? catalog.schemaVersion ?? "2.0.0");
  const parts = current.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return "2.0.1";
  parts[2] += 1;
  return parts.join(".");
}

function config(options = {}) {
  const catalogPath = options.catalogPath ?? defaultCatalogPath;
  const auditRoot = options.auditRoot ?? path.join(repoRoot, "data/audit/catalog-events");
  const rollbackRoot = options.rollbackRoot ?? path.join(repoRoot, "data/audit/rollback");
  const rollbackManifestPath = options.rollbackManifestPath ?? path.join(rollbackRoot, "catalog-accept-manifest.json");
  const draftRoot = options.draftRoot ?? path.join(repoRoot, "data/catalog-drafts");
  return { ...options, catalogPath, auditRoot, rollbackRoot, rollbackManifestPath, draftRoot };
}

async function loadCatalog(options) {
  if (options.catalog) return structuredClone(options.catalog);
  return (await readJson(options.catalogPath, { schemaVersion: "2.0.0", updatedAt: dateKey(), skus: [] })) ?? { schemaVersion: "2.0.0", updatedAt: dateKey(), skus: [] };
}

async function loadEvents(options) {
  const names = await readdir(options.auditRoot, { withFileTypes: true }).then((entries) => entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()).catch(() => []);
  const seen = new Set();
  const events = [];
  for (const name of names) {
    const saved = await readJson(path.join(options.auditRoot, name), { schemaVersion: "1.0.0", events: [] });
    for (const event of saved?.events ?? []) {
      if (!event?.eventId || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      events.push(event);
    }
  }
  return { schemaVersion: "1.0.0", events };
}

async function writeEvent(event, options) {
  const file = path.join(options.auditRoot, `${dateKey(event.createdAt)}.json`);
  const existing = await readJson(file, { schemaVersion: "1.0.0", events: [] });
  const events = [...(existing?.events ?? []).filter((entry) => entry.eventId !== event.eventId), event];
  await atomicWriteJson(file, { schemaVersion: "1.0.0", events }, {
    operation: "catalog-audit-event",
    rollbackRoot: options.rollbackRoot,
    manifestPath: path.join(options.rollbackRoot, "audit-manifest.json"),
  });
}

function fieldValue(fields, field) { return fieldMap(fields).get(field)?.value; }

function validateFields(candidate, fields, { allowManual = false } = {}) {
  const errors = [];
  const category = candidate.category ?? candidate.query?.category;
  if (!Object.hasOwn(CATEGORY_FIELDS, category)) errors.push(`unsupported category: ${safeText(category) || "missing"}`);
  const seen = new Set();
  for (const field of fields) {
    if (!field || typeof field !== "object") { errors.push("field record is invalid"); continue; }
    if (!isAllowedField(category, field.field)) errors.push(`field path is not allowed for ${category}: ${safeText(field.field)}`);
    if (seen.has(field.field)) errors.push(`duplicate field: ${safeText(field.field)}`);
    seen.add(field.field);
  }
  const map = fieldMap(fields);
  const missing = ["brand", "model", ...requiredFields(category)].filter((field) => fieldValue(fields, field) === undefined || fieldValue(fields, field) === "");
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    if (!allowManual && !OFFICIAL_FIELD_SOURCE_KINDS.has(field.sourceKind)) errors.push(`field ${field.field} is not official`);
    if (allowManual && field.sourceKind !== "manual" && !OFFICIAL_FIELD_SOURCE_KINDS.has(field.sourceKind)) errors.push(`field ${field.field} source kind is invalid`);
    if (!EVIDENCE_LEVELS.has(field.evidence)) errors.push(`field ${field.field} evidence is invalid`);
    if (field.sourceKind === "manual" && field.evidence !== "unknown") errors.push(`field ${field.field} manual evidence must be unknown`);
    if (OFFICIAL_FIELD_SOURCE_KINDS.has(field.sourceKind) && !["official", "inferred"].includes(field.evidence)) errors.push(`field ${field.field} official source has invalid evidence`);
    if (!allowManual && field.evidence !== "official") errors.push(`field ${field.field} candidate evidence is not official`);
    if (!field.provenanceId || !field.sourceUrl || !field.retrievedAt || !field.extractor) errors.push(`field ${field.field} provenance incomplete`);
    if (!Number.isFinite(Date.parse(field.retrievedAt))) errors.push(`field ${field.field} retrievedAt is invalid`);
    if (field.value === undefined || field.value === null || field.value === "") errors.push(`field ${field.field} has empty value`);
    if (typeof field.value === "object" && !Array.isArray(field.value)) errors.push(`field ${field.field} has unsupported object value`);
    if (Array.isArray(field.value) && (field.value.length > 32 || field.value.some((entry) => !["string", "number", "boolean"].includes(typeof entry)))) errors.push(`field ${field.field} has invalid array value`);
    if (typeof field.value === "string" && (field.value.length > 512 || /[\u0000]/.test(field.value))) errors.push(`field ${field.field} has invalid text`);
    if (IDENTITY_FIELDS.includes(field.field) && typeof field.value !== "string") errors.push(`field ${field.field} must be text`);
    const bounds = Object.hasOwn(NUMERIC_BOUNDS, field.field) ? NUMERIC_BOUNDS[field.field] : undefined;
    if (bounds && (typeof field.value !== "number" || !Number.isFinite(field.value) || field.value < bounds[0] || field.value > bounds[1])) errors.push(`field ${field.field} is outside allowed range ${bounds[0]}..${bounds[1]}`);
    if (field.field === "dims.slots" && typeof field.value === "number" && !Number.isInteger(field.value * 2)) errors.push("field dims.slots must use 0.5-slot increments");
    if (field.sourceKind !== "manual") {
      try { validateOfficialUrl(field.sourceUrl); } catch (error) { errors.push(`field ${field.field} source blocked: ${error.message}`); }
    }
  }
  for (const field of fields.filter((entry) => entry?.evidence === "inferred")) {
    const source = map.get("dims.thicknessMm");
    const expected = typeof source?.value === "number" ? Math.ceil((source.value / GPU_SLOT_PITCH_MM) * 2) / 2 : NaN;
    if (field.field !== "dims.slots" || field.extractor !== "inferred-pcie-slot-pitch-v1") errors.push(`field ${field.field} uses an unsupported inference`);
    if (!source || !OFFICIAL_FIELD_SOURCE_KINDS.has(source.sourceKind) || source.provenanceId !== field.derivedFromProvenanceId || source.sourceUrl !== field.sourceUrl) errors.push(`field ${field.field} inferred source is invalid`);
    if (!Number.isFinite(expected) || field.value !== expected) errors.push(`field ${field.field} inferred value is invalid`);
  }
  return { errors: [...new Set(errors)], missing, category, map };
}

function exactIdentity(candidate, fields) {
  // The identity assessor understands harmless marketing-prefix and capacity-
  // suffix differences (for example, receipt "RTX 3070 Ventus 2X OC 8GB"
  // versus MSI's "GeForce RTX 3070 VENTUS 2X OC"). Repeating identity with
  // raw string equality here would turn a proven exact match into a false
  // negative. Trust its immutable exact verdict, but never allow a draft to
  // replace the official identity fields that verdict was based on.
  if (candidate.identity?.verdict !== "exact" || candidate.identity?.criticalConflicts?.length) return null;
  const original = fieldMap(canonicalFields(candidate));
  const selected = fieldMap(fields);
  if (!selected.get("brand")?.value || !selected.get("model")?.value) return null;
  for (const field of IDENTITY_FIELDS) {
    const originalValue = original.get(field)?.value;
    const selectedValue = selected.get(field)?.value;
    if (originalValue === undefined ? selectedValue !== undefined : JSON.stringify(selectedValue) !== JSON.stringify(originalValue)) return null;
  }
  return candidate.match?.kind === "exact-mpn" && selected.get("mpn")?.value ? "exact-mpn" : "identity-exact";
}

function validateOfficialCandidate(candidate) {
  const errors = [];
  if (!candidate) return { ok: false, errors: ["candidate not found"] };
  if (candidate.source?.kind !== "official") errors.push("candidate source is not official");
  if (candidate.official?.trustStatus !== "trusted") errors.push("candidate official trust is not trusted");
  if (!OFFICIAL_PAGE_KINDS.has(candidate.official?.pageKind)) errors.push(`official page kind is ${candidate.official?.pageKind ?? "unknown"}`);
  if (!candidate.canonicalUrl) errors.push("canonical URL is required");
  let canonical;
  try { canonical = validateOfficialUrl(candidate.canonicalUrl); } catch (error) { errors.push(error.message); }
  if (canonical && !registryForUrl(canonical)) errors.push("canonical URL is not allowlisted");
  if (candidate.source?.httpStatus === undefined) errors.push("official fetch status is required");
  else if (candidate.source.httpStatus < 200 || candidate.source.httpStatus >= 300) errors.push("official fetch did not succeed");
  if (candidate.source?.finalUrl) {
    try { validateOfficialUrl(candidate.source.finalUrl); } catch (error) { errors.push(`final URL blocked: ${error.message}`); }
  } else errors.push("final URL is required");
  if (candidate.extraction?.status !== "ok") errors.push(`extraction status is ${candidate.extraction?.status ?? "unknown"}`);
  if (candidate.identity && candidate.identity.verdict !== "exact") errors.push(`identity verdict is ${candidate.identity.verdict}`);
  if (!candidate.extraction?.contentHash) errors.push("content hash is required");
  const fields = canonicalFields(candidate);
  const fieldResult = validateFields(candidate, fields);
  errors.push(...fieldResult.errors, ...fieldResult.missing.map((field) => `missing ${field}`));
  if (fields.some((field) => field.sourceKind === "official-ocr-pdf")) errors.push("OCR-derived fields require manual draft confirmation");
  if (candidate.conflicts?.length) errors.push("unresolved official field conflict");
  const identity = exactIdentity(candidate, fields);
  if (!identity) errors.push("exact MPN or exact brand/model identity was not proven");
  return { ok: errors.length === 0, errors, fields, category: fieldResult.category, identity, canonical };
}

export function validateGovernedCandidate(candidate, expectedHash, { requireExpectedHash = false } = {}) {
  const errors = [];
  if (!candidate) return { ok: false, errors: ["candidate not found"], inputHash: null, fields: [], missing: [] };
  const inputHash = catalogCandidateInputHash(candidate);
  if (requireExpectedHash && !expectedHash) errors.push("candidate expected hash is required");
  if (expectedHash && expectedHash !== inputHash) errors.push("candidate expected hash mismatch");
  if (candidate.source?.kind !== "official") errors.push("candidate source is not official");
  if (candidate.official?.trustStatus !== "trusted") errors.push("candidate official trust is not trusted");
  if (!OFFICIAL_PAGE_KINDS.has(candidate.official?.pageKind)) errors.push(`official page kind is ${candidate.official?.pageKind ?? "unknown"}; expected product/spec/datasheet/support`);
  if (candidate.identity?.verdict !== "exact") errors.push(`identity verdict is ${candidate.identity?.verdict ?? "missing"}`);
  if (candidate.extraction?.status !== "ok") errors.push(`extraction status is ${candidate.extraction?.status ?? "unknown"}; expected ok`);
  if (candidate.accessBarrier) errors.push(`official artifact has an access barrier: ${candidate.accessBarrier.kind ?? "unknown"}`);
  if (candidate.conflicts?.length) errors.push("unresolved official field conflict");
  let canonicalEntry = null;
  if (!candidate.canonicalUrl) errors.push("canonical URL is required");
  else {
    try {
      const canonical = validateOfficialUrl(candidate.canonicalUrl);
      canonicalEntry = registryForUrl(canonical);
      if (!canonicalEntry || canonicalEntry.trustStatus !== "trusted") errors.push("canonical URL is not allowlisted as trusted");
      if (candidate.official?.brand && canonicalEntry && comparableIdentity(candidate.official.brand) !== comparableIdentity(canonicalEntry.brand)) errors.push("canonical URL brand does not match candidate official brand");
    } catch (error) { errors.push(error.message); }
  }
  if (!Number.isInteger(candidate.source?.httpStatus) || candidate.source.httpStatus < 200 || candidate.source.httpStatus >= 300) errors.push("official fetch did not succeed");
  if (!candidate.source?.finalUrl) errors.push("final URL is required");
  else {
    try {
      const final = validateOfficialUrl(candidate.source.finalUrl);
      const finalEntry = registryForUrl(final);
      if (!finalEntry || !canonicalEntry || finalEntry.brand !== canonicalEntry.brand) errors.push("final URL brand does not match canonical official brand");
    } catch (error) { errors.push(`final URL blocked: ${error.message}`); }
  }
  if (!candidate.extraction?.contentHash || !/^[a-f0-9]{64}$/i.test(candidate.extraction.contentHash)) errors.push("content hash is required");
  const fields = canonicalFields(candidate);
  const checked = validateFields(candidate, fields);
  errors.push(...checked.errors);
  const fieldBrand = fieldValue(fields, "brand");
  if (fieldBrand && canonicalEntry && comparableIdentity(fieldBrand) !== comparableIdentity(canonicalEntry.brand)) errors.push("official brand field does not match canonical official brand");
  for (const field of fields.filter((entry) => entry?.sourceKind !== "manual")) {
    try {
      const sourceEntry = registryForUrl(validateOfficialUrl(field.sourceUrl));
      if (!sourceEntry || !canonicalEntry || sourceEntry.brand !== canonicalEntry.brand) errors.push(`field ${field.field} source brand does not match canonical official brand`);
    } catch { /* validateFields already records malformed or blocked source URLs */ }
  }
  if (!exactIdentity(candidate, fields)) errors.push("exact MPN or exact brand/model identity was not proven");
  return { ok: errors.length === 0, errors: [...new Set(errors)], inputHash, fields, missing: checked.missing, category: checked.category };
}

function skuFromFields(candidate, fields, existingId) {
  const category = candidate.category ?? candidate.query.category;
  const safeFields = fields.map(sanitizeField);
  const mpn = fieldValue(safeFields, "mpn");
  const model = fieldValue(safeFields, "model") ?? sanitizeValue(candidate.model ?? candidate.query.model ?? candidate.query.raw);
  const brand = fieldValue(safeFields, "brand") ?? sanitizeValue(candidate.brand ?? candidate.query.brand ?? "Unknown");
  const evidenceFor = (prefix) => safeFields.some((field) => field.field.startsWith(prefix) && field.evidence === "inferred")
    ? "inferred"
    : safeFields.some((field) => field.field.startsWith(prefix) && field.sourceKind === "manual") ? "unknown" : "official";
  const sku = {
    id: existingId ?? `${category}.${slug(mpn ?? `${brand}-${model}`)}`,
    category,
    brand: String(brand),
    model: String(model),
    name: `${brand} ${model}`.trim(),
    ...(mpn ? { mpn: String(mpn) } : {}),
    dims: { evidence: evidenceFor("dims.") },
    power: { evidence: evidenceFor("power.") },
    ...(safeFields.some((field) => field.field.startsWith("harness.")) ? { harness: { evidence: evidenceFor("harness.") } } : {}),
    price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    appearance: { page: candidate.canonicalUrl },
    provenance: safeFields,
  };
  for (const field of safeFields) {
    if (["brand", "model", "mpn"].includes(field.field)) continue;
    const value = field.field === "harness.pciePower" && typeof field.value === "string" ? [field.value] : field.value;
    setPath(sku, field.field, value, category);
  }
  return sku;
}

function findSameMpn(catalog, proposed) {
  const mpn = proposed?.mpn;
  if (!mpn) return null;
  return (catalog.skus ?? []).find((sku) => sku.category === proposed.category
    && comparableIdentity(sku.brand) === comparableIdentity(proposed.brand)
    && comparableIdentity(sku.mpn) === comparableIdentity(mpn)) ?? null;
}

function comparableIdentity(value) { return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9]+/g, ""); }

const GENERIC_MODEL_TOKENS = new Set(["official", "product", "products", "series", "spec", "specification", "support", "graphics", "card", "geforce"]);

function modelTokens(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !GENERIC_MODEL_TOKENS.has(token));
}

function controlledIdentityModels(sku) {
  return [sku.model, ...(Array.isArray(sku.attrs?.searchTerms) ? sku.attrs.searchTerms : [])].filter((value) => typeof value === "string" && value);
}

function exactControlledModel(sku, value) {
  const normalized = comparableIdentity(value);
  return Boolean(normalized) && controlledIdentityModels(sku).some((model) => comparableIdentity(model) === normalized);
}

function officialModelFitsControlledIdentity(sku, value) {
  const official = modelTokens(value);
  if (!official.length) return false;
  return controlledIdentityModels(sku).some((model) => {
    if (comparableIdentity(model) === comparableIdentity(value)) return true;
    const controlled = new Set(modelTokens(model));
    // Official family pages may omit a capacity/wattage suffix from the
    // catalog's canonical model. They must not introduce any sibling token
    // (especially a different numeric discriminator).
    return official.every((token) => controlled.has(token));
  });
}

function findSameIdentity(catalog, proposed) {
  const sameMpn = findSameMpn(catalog, proposed);
  if (sameMpn) return sameMpn;
  const brand = comparableIdentity(proposed.brand);
  const model = comparableIdentity(proposed.model);
  const sameBrandModel = (catalog.skus ?? []).find((sku) => sku.category === proposed.category
    && comparableIdentity(sku.brand) === brand
    && comparableIdentity(sku.model) === model) ?? null;
  return sameBrandModel && (!proposed.mpn || !sameBrandModel.mpn) ? sameBrandModel : null;
}

function resolveBaseSku(catalog, candidate, proposed) {
  if (!candidate.skuId) return { sku: findSameIdentity(catalog, proposed), errors: [] };
  const sku = (catalog.skus ?? []).find((entry) => entry.id === candidate.skuId) ?? null;
  if (!sku) return { sku: null, errors: [`candidate catalog SKU is missing: ${safeText(candidate.skuId)}`] };
  const errors = [];
  if (sku.category !== proposed.category) errors.push(`candidate catalog SKU category mismatch: ${sku.category} != ${proposed.category}`);
  if (comparableIdentity(sku.brand) !== comparableIdentity(proposed.brand)) errors.push("candidate catalog SKU brand mismatch");
  const candidateMpns = [proposed.mpn, candidate.query?.mpn, candidate.mpn].filter((value) => typeof value === "string" && value);
  const exactMpn = Boolean(sku.mpn && candidateMpns.some((value) => comparableIdentity(value) === comparableIdentity(sku.mpn)));
  if (sku.mpn && candidateMpns.length && !exactMpn) errors.push("candidate catalog SKU MPN mismatch");
  if (!exactMpn) {
    const requestedModel = candidate.query?.model ?? candidate.model;
    if (!exactControlledModel(sku, requestedModel)) errors.push("candidate catalog SKU requested model mismatch");
    if (!officialModelFitsControlledIdentity(sku, proposed.model)) errors.push("candidate catalog SKU official model mismatch");
  }
  return { sku, errors };
}

function normalizedFieldValue(field, value) {
  return field === "harness.pciePower" && typeof value === "string" ? [value] : value;
}

function sameFieldValue(field, left, right) {
  if (IDENTITY_FIELDS.includes(field)) return comparableIdentity(left) === comparableIdentity(right);
  return JSON.stringify(normalizedFieldValue(field, left)) === JSON.stringify(normalizedFieldValue(field, right));
}

function provenanceKey(entry) {
  return typeof entry?.provenanceId === "string" && entry.provenanceId
    ? `id:${entry.provenanceId}`
    : `value:${jsonHash(entry)}`;
}

function appendUniqueProvenance(existing = [], additions = []) {
  const records = structuredClone(Array.isArray(existing) ? existing : []);
  const keys = new Set(records.map(provenanceKey));
  let added = 0;
  for (const entry of additions) {
    const key = provenanceKey(entry);
    if (keys.has(key)) continue;
    keys.add(key);
    records.push(structuredClone(entry));
    added += 1;
  }
  return { records, added };
}

function retainRuntimeSkuMetadata(catalog, skuId, options) {
  if (!options.retainRuntimeSkuMetadata) return catalog;
  const metadata = catalog.runtimeCatalog;
  if (!metadata || !Array.isArray(metadata.acceptedSkuIds)) {
    throw new Error("runtime catalog retention metadata is missing");
  }
  return {
    ...catalog,
    runtimeCatalog: {
      ...metadata,
      acceptedSkuIds: [...new Set([...metadata.acceptedSkuIds, skuId])].sort(),
    },
  };
}

function skuMissingFields(sku) {
  return ["brand", "model", ...requiredFields(sku.category)].filter((field) => missingValue(getPath(sku, field)));
}

function mergeExistingSku(existing, candidate, fields) {
  const proposed = structuredClone(existing);
  const safeFields = fields.map(sanitizeField);
  const sources = fieldMap(safeFields);
  const candidateSku = skuFromFields(candidate, safeFields, existing.id);
  const changed = new Set();
  const conflicts = [];
  const identityAnchored = Boolean(candidate.skuId)
    || Boolean(existing.mpn && candidateSku.mpn && comparableIdentity(existing.mpn) === comparableIdentity(candidateSku.mpn));
  const groupsWithAddedFacts = new Set();

  for (const source of safeFields) {
    const field = source.field;
    const nextValue = normalizedFieldValue(field, source.value);
    const currentValue = getPath(existing, field);
    if (IDENTITY_FIELDS.includes(field) && field !== "mpn" && identityAnchored) continue;
    if (missingValue(currentValue)) {
      setPath(proposed, field, structuredClone(nextValue), existing.category);
      changed.add(field);
      if (field.includes(".")) groupsWithAddedFacts.add(field.split(".")[0]);
      continue;
    }
    if (!sameFieldValue(field, currentValue, nextValue)) {
      conflicts.push({ field, existing: structuredClone(currentValue), proposed: structuredClone(nextValue), reason: "existing governed value differs from official candidate" });
    }
  }

  for (const group of ["dims", "power", "harness"]) {
    const prior = existing[group];
    const priorFacts = prior && typeof prior === "object" ? Object.keys(prior).filter((key) => key !== "evidence" && !missingValue(prior[key])) : [];
    const candidateEvidence = candidateSku[group]?.evidence;
    const proposedFacts = proposed[group] && typeof proposed[group] === "object"
      ? Object.entries(proposed[group]).filter(([key, value]) => key !== "evidence" && !missingValue(value))
      : [];
    const allFactsOfficial = proposedFacts.length > 0 && proposedFacts.every(([key, value]) => {
      const source = sources.get(`${group}.${key}`);
      return source?.evidence === "official"
        && OFFICIAL_FIELD_SOURCE_KINDS.has(source.sourceKind)
        && sameFieldValue(`${group}.${key}`, value, source.value);
    });
    if (allFactsOfficial && proposed[group]?.evidence !== "official") {
      proposed[group].evidence = "official";
      changed.add(`${group}.evidence`);
    } else if (groupsWithAddedFacts.has(group) && priorFacts.length === 0 && candidateEvidence
      && proposed[group]?.evidence !== candidateEvidence
      && proposed[group]?.evidence !== "official") {
      proposed[group].evidence = candidateEvidence;
      changed.add(`${group}.evidence`);
    }
  }

  if (!proposed.appearance?.page && candidate.canonicalUrl) {
    proposed.appearance = { ...(proposed.appearance ?? {}), page: candidate.canonicalUrl };
    changed.add("appearance.page");
  }
  const appended = appendUniqueProvenance(existing.provenance, safeFields);
  if (appended.added > 0) {
    proposed.provenance = appended.records;
    changed.add("provenance");
  }
  return { proposed, conflicts, missing: skuMissingFields(proposed), changedFields: [...changed] };
}

function changedFields(existing, proposed) {
  return ["brand", "model", "mpn", "dims", "power", "attrs", "appearance", "provenance"].filter((key) => JSON.stringify(existing?.[key]) !== JSON.stringify(proposed?.[key]));
}

async function persistDraft(draft, options) {
  const file = path.join(options.draftRoot, `${dateKey(draft.createdAt)}.json`);
  return withDraftWriteLock(file, async () => {
    await mkdir(options.draftRoot, { recursive: true });
    const existing = await readJson(file, { schemaVersion: "1.0.0", drafts: [] });
    const draftsById = new Map((existing?.drafts ?? []).map((entry) => [entry.draftId, entry]));
    draftsById.set(draft.draftId, draft);
    await atomicWriteJson(file, { schemaVersion: "1.0.0", drafts: [...draftsById.values()] }, {
      operation: "catalog-draft",
      rollbackRoot: options.rollbackRoot,
      manifestPath: path.join(options.rollbackRoot, "draft-manifest.json"),
    });
  });
}

function inferMissingFields(candidate, fields) {
  if ((candidate.category ?? candidate.query?.category) !== "gpu" || fieldValue(fields, "dims.slots") !== undefined) return fields;
  const thickness = fieldMap(fields).get("dims.thicknessMm");
  if (!thickness || typeof thickness.value !== "number" || !Number.isFinite(thickness.value) || thickness.value <= 0 || !OFFICIAL_FIELD_SOURCE_KINDS.has(thickness.sourceKind) || thickness.evidence !== "official") return fields;
  const slots = Math.ceil((thickness.value / GPU_SLOT_PITCH_MM) * 2) / 2;
  if (slots < NUMERIC_BOUNDS["dims.slots"][0] || slots > NUMERIC_BOUNDS["dims.slots"][1]) return fields;
  const note = `由官方厚度 ${thickness.value} mm 按 PCIe 槽距 ${GPU_SLOT_PITCH_MM} mm 计算，并保守向上取整到 0.5 槽；未推测待机功耗或噪音。`;
  return [...fields, sanitizeField({
    provenanceId: `prov-inferred-${sha256(`${candidate.candidateId}|dims.slots|${thickness.provenanceId}|${slots}`).slice(0, 16)}`,
    field: "dims.slots",
    value: slots,
    evidence: "inferred",
    sourceUrl: thickness.sourceUrl,
    sourceKind: thickness.sourceKind,
    retrievedAt: thickness.retrievedAt,
    extractor: "inferred-pcie-slot-pitch-v1",
    locator: `derived from ${thickness.provenanceId} (${thickness.locator ?? "dims.thicknessMm"})`,
    snippet: `${thickness.value} mm / ${GPU_SLOT_PITCH_MM} mm = ${(thickness.value / GPU_SLOT_PITCH_MM).toFixed(3)}; ceil to 0.5 slot = ${slots}`,
    confidence: 0.8,
    note,
    derivedFromProvenanceId: thickness.provenanceId,
  })];
}

function draftHashValue(draft) {
  return {
    schemaVersion: draft.schemaVersion,
    draftId: draft.draftId,
    operation: draft.operation,
    baseSkuId: draft.baseSkuId,
    baseSkuHash: draft.baseSkuHash,
    baseCatalogVersion: draft.baseCatalogVersion,
    candidateId: draft.candidateId,
    candidateInputHash: draft.candidateInputHash,
    candidateSnapshot: draft.candidateSnapshot,
    proposed: draft.proposed,
    fields: draft.fields,
    conflicts: draft.conflicts,
    missing: draft.missing,
    changedFields: draft.changedFields,
  };
}

function withDraftHash(draft) {
  const inputHash = jsonHash(draftHashValue(draft));
  return { ...draft, inputHash, expectedHash: inputHash };
}

function selectedFields(candidate, selections = {}) {
  const sourceFields = fieldMap(candidate.fields ?? []);
  const manualRetrievedAt = Number.isFinite(Date.parse(candidate.source?.retrievedAt))
    ? candidate.source.retrievedAt
    : [...sourceFields.values()].find((field) => Number.isFinite(Date.parse(field?.retrievedAt)))?.retrievedAt
      ?? "1970-01-01T00:00:00.000Z";
  const fields = [];
  for (const [field, source] of sourceFields) {
    const choice = selections[field];
    if (choice === undefined) {
      fields.push(sanitizeField(source));
      continue;
    }
    const value = choice && typeof choice === "object" && "value" in choice ? choice.value : choice;
    if (JSON.stringify(value) === JSON.stringify(source.value)) fields.push(sanitizeField(source));
    else fields.push(sanitizeField({
      ...source,
      provenanceId: `prov-manual-${sha256(`${candidate.candidateId}|${field}|${JSON.stringify(value)}`).slice(0, 12)}`,
      value,
      evidence: "unknown",
      sourceKind: "manual",
      sourceUrl: "manual://catalog-draft",
      retrievedAt: manualRetrievedAt,
      extractor: "user-confirmed",
      locator: `draft selection: ${field}`,
      snippet: safeText(`用户确认：${field}`),
    }));
  }
  for (const [field, choice] of Object.entries(selections)) {
    if (sourceFields.has(field)) continue;
    const value = choice && typeof choice === "object" && "value" in choice ? choice.value : choice;
    if (value === undefined || value === "") continue;
    fields.push(sanitizeField({
      provenanceId: `prov-manual-${sha256(`${candidate.candidateId}|${field}|${JSON.stringify(value)}`).slice(0, 12)}`,
      field,
      value,
      evidence: "unknown",
      sourceKind: "manual",
      sourceUrl: "manual://catalog-draft",
      retrievedAt: manualRetrievedAt,
      extractor: "user-confirmed",
      locator: `draft selection: ${field}`,
      snippet: safeText(`用户确认：${field}`),
    }));
  }
  return inferMissingFields(candidate, fields);
}

export async function acceptOfficial(candidateId, options = {}) {
  const resolved = config(options);
  const candidate = options.candidate ?? findCandidate(candidateId);
  // The idempotency key must include every acceptance-relevant fact. A later
  // candidate with the same content hash but a new canonical URL or conflict
  // finding must never replay an earlier accepted result.
  const inputHash = candidate ? catalogCandidateInputHash(candidate) : sha256(candidateId);
  const idempotencyKey = `accept-official:${candidateId}:${inputHash}`;
  if (options.approved !== true) return { status: "blocked", candidateId, inputHash, idempotencyKey, reasons: ["official acceptance requires approved=true"] };
  if (!options.expectedHash) return { status: "blocked", candidateId, inputHash, idempotencyKey, reasons: ["candidate expected hash is required"] };
  if (options.expectedHash !== inputHash) return { status: "blocked", candidateId, inputHash, idempotencyKey, reasons: ["candidate expected hash mismatch"] };
  if (!resolved.catalogWriteEnabled) return { status: "blocked", candidateId, reason: "catalog write disabled", idempotencyKey };
  const governed = validateGovernedCandidate(candidate, options.expectedHash, { requireExpectedHash: true });
  const checked = validateOfficialCandidate(candidate);
  const policyErrors = [...new Set([...governed.errors, ...checked.errors])];
  if (policyErrors.length) return { status: "blocked", candidateId, inputHash, idempotencyKey, reasons: policyErrors };
  return withCatalogWriteLock(resolved.catalogPath, async () => {
    const existingEvent = (await loadEvents(resolved)).events.find((event) => event.idempotencyKey === idempotencyKey);
    if (existingEvent?.result) return existingEvent.result;
    const catalog = await loadCatalog({ ...resolved, catalog: undefined });
    const proposed = skuFromFields(candidate, checked.fields);
    const existing = findSameIdentity(catalog, proposed);
    let nextSkus;
    let changed;
    if (existing) {
      const conflicts = ["brand", "model", "dims", "power", "attrs"].filter((key) => getPath(existing, key) !== undefined && JSON.stringify(existing[key]) !== JSON.stringify(proposed[key]));
      if (conflicts.length) return { status: "blocked", candidateId, idempotencyKey, reasons: conflicts.map((key) => `existing manual field conflict: ${key}`) };
      const appended = appendUniqueProvenance(existing.provenance, proposed.provenance);
      const merged = { ...existing, provenance: appended.records };
      nextSkus = (catalog.skus ?? []).map((sku) => sku.id === existing.id ? merged : sku);
      changed = changedFields(existing, merged);
      proposed.id = existing.id;
    } else {
      nextSkus = [...(catalog.skus ?? []), proposed];
      changed = ["new SKU", ...changedFields({}, proposed)];
    }
    const nextCatalog = retainRuntimeSkuMetadata(
      { ...catalog, catalogVersion: catalogVersion(catalog), updatedAt: dateKey(), skus: nextSkus },
      proposed.id,
      resolved,
    );
    const catalogHash = jsonHash(nextCatalog);
    const eventId = `catalog-event-${sha256(idempotencyKey).slice(0, 20)}`;
    const result = { status: "accepted", candidateId, skuId: proposed.id, catalogVersion: nextCatalog.catalogVersion, catalogHash, inputHash, idempotencyKey, registryVersion: resolved.registryVersion, extractorVersion: candidate.extraction.adapter, contentHash: candidate.extraction.contentHash, changedFields: changed, eventId, runtimeCatalogRetained: Boolean(resolved.retainRuntimeSkuMetadata), rollbackManifest: resolved.rollbackManifestPath };
    const event = { eventId, operation: "accept-official", idempotencyKey, candidateId, skuId: proposed.id, status: "accepted", inputHash, contentHash: candidate.extraction.contentHash, catalogHash, catalogVersion: nextCatalog.catalogVersion, changedFields: changed, createdAt: now(), result };
    try {
      await atomicWriteJson(resolved.catalogPath, nextCatalog, { operation: "catalog-accept-official", rollbackRoot: resolved.rollbackRoot, manifestPath: resolved.rollbackManifestPath });
      await writeEvent(event, resolved);
    } catch (error) {
      await restoreLatestRollback(resolved.catalogPath, { manifestPath: resolved.rollbackManifestPath }).catch(() => {});
      throw error;
    }
    acceptResults.set(idempotencyKey, result);
    return result;
  });
}

export async function previewDraft(candidateId, selections = {}, options = {}) {
  const resolved = config(options);
  const candidate = options.candidate ?? findCandidate(candidateId);
  if (!candidate) return { status: "blocked", candidateId, reasons: ["candidate not found"] };
  const governed = validateGovernedCandidate(candidate, options.expectedHash, { requireExpectedHash: true });
  const candidateInputHash = governed.inputHash;
  if (!governed.ok) return { status: "blocked", candidateId, inputHash: candidateInputHash, reasons: governed.errors };
  const candidateSnapshot = structuredClone(candidate);
  const selected = selectedFields(candidateSnapshot, selections);
  const checked = validateFields(candidateSnapshot, selected, { allowManual: true });
  if (!exactIdentity(candidateSnapshot, selected)) checked.errors.push("draft identity fields must remain equal to the exact official identity evidence");
  if (checked.errors.length) return { status: "blocked", candidateId, inputHash: candidateInputHash, reasons: checked.errors };
  const catalog = await loadCatalog(resolved);
  const candidateSku = skuFromFields(candidateSnapshot, selected);
  const base = resolveBaseSku(catalog, candidateSnapshot, candidateSku);
  if (base.errors.length) return { status: "blocked", candidateId, inputHash: candidateInputHash, reasons: base.errors };
  const baseSkuId = base.sku?.id;
  const baseSkuHash = base.sku ? jsonHash(base.sku) : undefined;
  const operation = base.sku ? "update" : "create";
  const merged = base.sku
    ? mergeExistingSku(base.sku, candidateSnapshot, selected)
    : { proposed: candidateSku, conflicts: [], missing: checked.missing, changedFields: ["new SKU"] };
  const conflicts = [
    ...(candidateSnapshot.conflicts ?? []).filter((conflict) => selections[conflict.field] === undefined).map((conflict) => ({ field: safeText(conflict.field), proposed: sanitizeValue(conflict.values), reason: safeText(conflict.reason) })),
    ...merged.conflicts,
  ];
  const draftId = `sku-draft-${sha256(`${candidateId}|${candidateInputHash}|${JSON.stringify(selected)}|${baseSkuId ?? "new"}|${baseSkuHash ?? "none"}`).slice(0, 20)}`;
  const timestamp = now();
  return withDraftHash({
    schemaVersion: "1.0.0",
    draftId,
    operation,
    ...(baseSkuId ? { baseSkuId, baseSkuHash } : {}),
    baseCatalogVersion: catalog.catalogVersion ?? catalog.schemaVersion,
    candidateId,
    candidateInputHash,
    candidateSnapshot,
    proposed: merged.proposed,
    fields: selected,
    conflicts,
    missing: merged.missing,
    changedFields: merged.changedFields,
    status: "preview",
    createdAt: timestamp,
    updatedAt: timestamp,
    registryVersion: options.registryVersion,
    extractorVersion: candidateSnapshot.extraction?.adapter,
    contentHash: candidateSnapshot.extraction?.contentHash,
  });
}

export async function createDraft(candidateId, selections = {}, options = {}) {
  const resolved = config(options);
  if (options.expectedDraftHash) {
    const replay = await findDraftByInputHash(candidateId, options.expectedDraftHash, resolved);
    if (replay) return replay;
  }
  const preview = await previewDraft(candidateId, selections, resolved);
  if (preview.status !== "preview") return preview;
  if (options.expectedDraftHash && options.expectedDraftHash !== preview.inputHash) {
    return { status: "blocked", candidateId, inputHash: preview.inputHash, reasons: ["draft preview hash mismatch"] };
  }
  const existing = await getDraft(preview.draftId, resolved);
  if (existing) return existing;
  const draft = { ...preview, status: "draft" };
  drafts.set(draft.draftId, draft);
  await persistDraft(draft, resolved);
  return draft;
}

async function storedDrafts(options) {
  const seen = new Set();
  const stored = [];
  const names = await readdir(options.draftRoot, { withFileTypes: true }).then((entries) => entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()).catch(() => []);
  for (const name of names) {
    const saved = await readJson(path.join(options.draftRoot, name), { drafts: [] });
    for (const draft of saved?.drafts ?? []) {
      if (!draft?.draftId || seen.has(draft.draftId)) continue;
      seen.add(draft.draftId);
      stored.push(draft);
    }
  }
  return stored;
}

async function getDraft(draftId, options) {
  const draft = (await storedDrafts(options)).find((entry) => entry.draftId === draftId) ?? null;
  if (draft) { drafts.set(draftId, draft); return draft; }
  return drafts.get(draftId) ?? null;
}

async function findDraftByInputHash(candidateId, inputHash, options) {
  const draft = (await storedDrafts(options)).find((entry) => entry.candidateId === candidateId && entry.inputHash === inputHash) ?? null;
  if (draft) drafts.set(draft.draftId, draft);
  return draft;
}

function validateDraftHash(draft, expectedHash) {
  const errors = [];
  if (!expectedHash) errors.push("draft expected hash is required");
  if (!draft.inputHash || draft.expectedHash !== draft.inputHash) errors.push("draft input hash metadata is invalid");
  const actual = jsonHash(draftHashValue(draft));
  if (actual !== draft.inputHash) errors.push("draft immutable input changed");
  if (expectedHash && expectedHash !== draft.inputHash) errors.push("draft expected hash mismatch");
  return [...new Set(errors)];
}

function replayedConfirmation(draft, event, catalog) {
  const replay = event?.result;
  const confirmedSku = replay?.skuId ? (catalog.skus ?? []).find((sku) => sku.id === replay.skuId) : null;
  if (replay?.status !== "confirmed"
    || replay.draftId !== draft.draftId
    || replay.inputHash !== draft.inputHash
    || !confirmedSku
    || !replay.sku
    || jsonHash(confirmedSku) !== jsonHash(replay.sku)) return null;
  return { replay, confirmedSku };
}

async function persistConfirmedDraft(draft, result, resolved) {
  const { confirmationIntent: _confirmationIntent, ...rest } = draft;
  const confirmed = { ...rest, status: "confirmed", confirmation: result, updatedAt: now() };
  drafts.set(draft.draftId, confirmed);
  await persistDraft(confirmed, resolved);
  return confirmed;
}

function confirmationIntentErrors(draft, intent) {
  const errors = [];
  if (!intent || intent.schemaVersion !== "1.0.0") return ["confirmation intent is missing or invalid"];
  const { result, event, nextCatalog } = intent;
  if (intent.draftId !== draft.draftId || intent.inputHash !== draft.inputHash) errors.push("confirmation intent draft binding mismatch");
  if (intent.idempotencyKey !== `confirm-draft:${draft.draftId}:${draft.inputHash}`) errors.push("confirmation intent idempotency binding mismatch");
  if (!/^[a-f0-9]{64}$/i.test(intent.catalogBeforeHash ?? "") || !/^[a-f0-9]{64}$/i.test(intent.catalogAfterHash ?? "")) errors.push("confirmation intent catalog hash is invalid");
  if (!nextCatalog || jsonHash(nextCatalog) !== intent.catalogAfterHash) errors.push("confirmation intent next catalog hash mismatch");
  if (result?.status !== "confirmed" || result.draftId !== draft.draftId || result.inputHash !== draft.inputHash || result.expectedHash !== draft.inputHash) errors.push("confirmation intent result binding mismatch");
  if (result?.skuId !== draft.proposed?.id || JSON.stringify(result?.sku) !== JSON.stringify(draft.proposed)) errors.push("confirmation intent SKU mismatch");
  if (JSON.stringify(result?.changedFields) !== JSON.stringify(draft.changedFields)) errors.push("confirmation intent changed fields mismatch");
  if (result?.catalogHash !== intent.catalogAfterHash || result?.idempotencyKey !== intent.idempotencyKey || result?.eventId !== event?.eventId) errors.push("confirmation intent result metadata mismatch");
  if (event?.operation !== "confirm-draft"
    || event?.status !== "confirmed"
    || event?.draftId !== draft.draftId
    || event?.inputHash !== draft.inputHash
    || event?.idempotencyKey !== intent.idempotencyKey
    || event?.catalogHash !== result?.catalogHash
    || event?.catalogVersion !== result?.catalogVersion
    || JSON.stringify(event?.result) !== JSON.stringify(result)) errors.push("confirmation intent audit event mismatch");
  const matches = (nextCatalog?.skus ?? []).filter((sku) => sku.id === result?.skuId);
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(result?.sku)) errors.push("confirmation intent catalog SKU mismatch");
  if (result?.runtimeCatalogRetained && !nextCatalog?.runtimeCatalog?.acceptedSkuIds?.includes(result.skuId)) errors.push("confirmation intent runtime retention mismatch");
  return [...new Set(errors)];
}

function catalogContainsConfirmation(catalog, result) {
  const matches = (catalog.skus ?? []).filter((sku) => sku.id === result.skuId);
  if (matches.length !== 1 || jsonHash(matches[0]) !== jsonHash(result.sku)) return false;
  return !result.runtimeCatalogRetained || catalog.runtimeCatalog?.acceptedSkuIds?.includes(result.skuId);
}

async function recoverConfirmingDraft(draft, catalog, existingEvent, resolved) {
  const replayed = replayedConfirmation(draft, existingEvent, catalog);
  if (existingEvent && !replayed) return { status: "blocked", draftId: draft.draftId, reasons: ["confirmation intent does not match its audit event"] };
  if (replayed) {
    await persistConfirmedDraft(draft, replayed.replay, resolved);
    return { ...replayed.replay, skuId: replayed.confirmedSku.id, sku: structuredClone(replayed.confirmedSku), recoveredDraftState: true };
  }

  const intent = draft.confirmationIntent;
  const intentErrors = confirmationIntentErrors(draft, intent);
  if (intentErrors.length) return { status: "blocked", draftId: draft.draftId, reasons: intentErrors };
  const currentHash = jsonHash(catalog);
  let committedCatalog = catalog;
  if (currentHash === intent.catalogBeforeHash) {
    if (intent.catalogAfterHash !== intent.catalogBeforeHash) {
      await atomicWriteJson(resolved.catalogPath, intent.nextCatalog, { operation: "catalog-confirm-draft-recovery", rollbackRoot: resolved.rollbackRoot, manifestPath: resolved.rollbackManifestPath });
    }
    committedCatalog = intent.nextCatalog;
  } else if (currentHash !== intent.catalogAfterHash && !catalogContainsConfirmation(catalog, intent.result)) {
    return { status: "blocked", draftId: draft.draftId, reasons: ["pending confirmation conflicts with current catalog state"] };
  }
  if (!catalogContainsConfirmation(committedCatalog, intent.result)) return { status: "blocked", draftId: draft.draftId, reasons: ["pending confirmation catalog write could not be verified"] };
  await writeEvent(intent.event, resolved);
  await persistConfirmedDraft(draft, intent.result, resolved);
  const currentSku = (committedCatalog.skus ?? []).find((sku) => sku.id === intent.result.skuId);
  return { ...intent.result, sku: structuredClone(currentSku), recoveredDraftState: true };
}

async function rejectDraftTransition(draftId, options, resolved) {
  const draft = await getDraft(draftId, resolved);
  if (!draft) return { status: "blocked", draftId, reasons: ["draft not found"] };
  const hashErrors = validateDraftHash(draft, options.expectedHash);
  if (hashErrors.length) return { status: "blocked", draftId, reasons: hashErrors };
  if (options.approved !== false) return { status: "blocked", draftId, reasons: ["draft rejection requires approved=false"] };
  if (draft.status === "rejected") return { status: "rejected", draftId, inputHash: draft.inputHash };
  if (draft.status !== "draft") return { status: "blocked", draftId, reasons: [`draft is ${draft.status}`] };
  const next = { ...draft, status: "rejected", updatedAt: now() };
  drafts.set(draftId, next);
  await persistDraft(next, resolved);
  return { status: "rejected", draftId, inputHash: draft.inputHash };
}

export function rejectDraft(draftId, options = {}) {
  const resolved = config(options);
  return withDraftTransitionLock(resolved.draftRoot, draftId, () => rejectDraftTransition(draftId, options, resolved));
}

async function confirmDraftTransition(draftId, options, resolved) {
  const draft = await getDraft(draftId, resolved);
  if (!draft) return { status: "blocked", draftId, reasons: ["draft not found"] };
  const hashErrors = validateDraftHash(draft, options.expectedHash);
  if (hashErrors.length) return { status: "blocked", draftId, reasons: hashErrors };
  if (options.approved !== true) return { status: "blocked", draftId, reasons: ["draft confirmation requires approved=true"] };
  const inputHash = draft.inputHash;
  const idempotencyKey = `confirm-draft:${draftId}:${inputHash}`;
  if (!resolved.catalogWriteEnabled) return { status: "blocked", draftId, reasons: ["catalog write disabled"] };
  return withCatalogWriteLock(resolved.catalogPath, async () => {
    const existingEvent = (await loadEvents(resolved)).events.find((event) => event.idempotencyKey === idempotencyKey);
    const catalog = await loadCatalog({ ...resolved, catalog: undefined });
    if (draft.status === "confirmed") {
      const replayed = replayedConfirmation(draft, existingEvent, catalog);
      if (!replayed) return { status: "blocked", draftId, reasons: ["confirmed draft does not match its catalog audit event"] };
      return { ...replayed.replay, skuId: replayed.confirmedSku.id, sku: structuredClone(replayed.confirmedSku) };
    }
    if (draft.status === "confirming") return recoverConfirmingDraft(draft, catalog, existingEvent, resolved);
    if (draft.status !== "draft") return { status: "blocked", draftId, reasons: [`draft is ${draft.status}`] };
    if (existingEvent?.result) {
      const replayed = replayedConfirmation(draft, existingEvent, catalog);
      if (!replayed) return { status: "blocked", draftId, reasons: ["draft status does not match its audit event"] };
      await persistConfirmedDraft(draft, replayed.replay, resolved);
      return { ...replayed.replay, skuId: replayed.confirmedSku.id, sku: structuredClone(replayed.confirmedSku), recoveredDraftState: true };
    }

    // Only a fresh draft reaches this point. Durable confirming/confirmed
    // transactions above are recovered from their immutable intent/event
    // before today's registry or extraction policy is consulted.
    const candidate = draft.candidateSnapshot;
    if (!candidate || candidate.candidateId !== draft.candidateId) return { status: "blocked", draftId, reasons: ["immutable candidate snapshot is invalid"] };
    const candidateChecked = validateGovernedCandidate(candidate, draft.candidateInputHash, { requireExpectedHash: true });
    if (!candidateChecked.ok) return { status: "blocked", draftId, reasons: candidateChecked.errors };
    const checked = validateFields(candidate, draft.fields, { allowManual: true });
    if (checked.errors.length) return { status: "blocked", draftId, reasons: checked.errors };
    if (!exactIdentity(candidate, draft.fields)) return { status: "blocked", draftId, reasons: ["draft fields no longer prove exact MPN or exact brand/model identity"] };

    const candidateSku = skuFromFields(candidate, draft.fields);
    let existing = null;
    let recomputed;
    if (draft.baseSkuId) {
      existing = (catalog.skus ?? []).find((sku) => sku.id === draft.baseSkuId) ?? null;
      if (!existing) return { status: "blocked", draftId, reasons: ["base SKU is missing after review"] };
      if (!draft.baseSkuHash || jsonHash(existing) !== draft.baseSkuHash) return { status: "blocked", draftId, reasons: ["base SKU changed after review"] };
      const resolvedBase = resolveBaseSku(catalog, candidate, candidateSku);
      if (resolvedBase.errors.length || resolvedBase.sku?.id !== existing.id) return { status: "blocked", draftId, reasons: resolvedBase.errors.length ? resolvedBase.errors : ["candidate catalog identity changed after review"] };
      recomputed = mergeExistingSku(existing, candidate, draft.fields);
    } else {
      const resolvedBase = resolveBaseSku(catalog, candidate, candidateSku);
      if (resolvedBase.errors.length) return { status: "blocked", draftId, reasons: resolvedBase.errors };
      if (resolvedBase.sku) return { status: "blocked", draftId, reasons: ["catalog identity changed after review"] };
      recomputed = { proposed: candidateSku, conflicts: [], missing: skuMissingFields(candidateSku), changedFields: ["new SKU"] };
    }

    const immutableMismatch = JSON.stringify(recomputed.proposed) !== JSON.stringify(draft.proposed)
      || JSON.stringify(recomputed.conflicts) !== JSON.stringify(draft.conflicts)
      || JSON.stringify(recomputed.missing) !== JSON.stringify(draft.missing)
      || JSON.stringify(recomputed.changedFields) !== JSON.stringify(draft.changedFields ?? (existing ? [] : ["new SKU"]));
    if (immutableMismatch) return { status: "blocked", draftId, reasons: ["draft proposal no longer matches governed catalog state"] };
    if (draft.conflicts?.length) return { status: "blocked", draftId, reasons: ["unresolved draft field conflict"] };
    if (recomputed.missing.length) return { status: "blocked", draftId, reasons: recomputed.missing.map((field) => `missing ${field}`) };

    const proposed = recomputed.proposed;
    const idCollision = (catalog.skus ?? []).find((sku) => sku.id === proposed.id && sku.id !== existing?.id);
    if (idCollision) return { status: "blocked", draftId, reasons: [`duplicate SKU id already exists: ${proposed.id}`] };
    const created = !existing;
    const catalogChanged = created || recomputed.changedFields.length > 0;
    const nextSkus = !catalogChanged ? catalog.skus
      : existing ? (catalog.skus ?? []).map((sku) => sku.id === existing.id ? proposed : sku)
        : [...(catalog.skus ?? []), proposed];
    const changedCatalog = catalogChanged
      ? { ...catalog, catalogVersion: catalogVersion(catalog), updatedAt: dateKey(), skus: nextSkus }
      : catalog;
    const nextCatalog = catalogChanged ? retainRuntimeSkuMetadata(changedCatalog, proposed.id, resolved) : changedCatalog;
    const eventId = `catalog-event-${sha256(`confirm:${draftId}:${inputHash}`).slice(0, 20)}`;
    const result = { status: "confirmed", draftId, skuId: proposed.id, sku: structuredClone(proposed), catalogChanged, created, catalogVersion: nextCatalog.catalogVersion ?? nextCatalog.schemaVersion, catalogHash: jsonHash(nextCatalog), inputHash, expectedHash: inputHash, idempotencyKey, eventId, changedFields: recomputed.changedFields, runtimeCatalogRetained: Boolean(catalogChanged && resolved.retainRuntimeSkuMetadata), rollbackManifest: resolved.rollbackManifestPath };
    const event = { eventId, operation: "confirm-draft", idempotencyKey, draftId, status: "confirmed", inputHash, catalogHash: result.catalogHash, catalogVersion: result.catalogVersion, createdAt: now(), result };
    const confirmationIntent = {
      schemaVersion: "1.0.0",
      draftId,
      inputHash,
      idempotencyKey,
      catalogBeforeHash: jsonHash(catalog),
      catalogAfterHash: result.catalogHash,
      nextCatalog: structuredClone(nextCatalog),
      event,
      result,
      preparedAt: now(),
    };
    const pendingDraft = { ...draft, status: "confirming", confirmationIntent, updatedAt: now() };
    drafts.set(draftId, pendingDraft);
    await persistDraft(pendingDraft, resolved);
    if (catalogChanged) await atomicWriteJson(resolved.catalogPath, nextCatalog, { operation: "catalog-confirm-draft", rollbackRoot: resolved.rollbackRoot, manifestPath: resolved.rollbackManifestPath });
    if (options.testFailpoint === "after-catalog-write") throw new Error("test failpoint after catalog write");
    await writeEvent(event, resolved);
    await persistConfirmedDraft(pendingDraft, result, resolved);
    return result;
  });
}

export function confirmDraft(draftId, options = {}) {
  const resolved = config(options);
  return withDraftTransitionLock(resolved.draftRoot, draftId, () => confirmDraftTransition(draftId, options, resolved));
}

export async function recoverPendingDrafts(options = {}) {
  const resolved = config(options);
  const pending = (await storedDrafts(resolved)).filter((draft) => draft.status === "confirming");
  const results = [];
  for (const draft of pending) {
    results.push(await confirmDraft(draft.draftId, {
      ...resolved,
      approved: true,
      expectedHash: draft.inputHash,
      catalogWriteEnabled: true,
    }));
  }
  return results;
}

export async function rollbackCatalogAcceptance(catalogFile = defaultCatalogPath, options = {}) {
  const resolved = config({ ...options, catalogPath: catalogFile });
  return restoreLatestRollback(catalogFile, { manifestPath: resolved.rollbackManifestPath });
}

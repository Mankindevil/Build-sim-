import crypto from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { catalogPath as defaultCatalogPath, root as repoRoot, atomicWriteJson, readJson, restoreLatestRollback } from "../store.mjs";
import { registryForUrl } from "./registry.mjs";
import { validateOfficialUrl } from "./security.mjs";
import { findCandidate } from "./service.mjs";

const acceptResults = new Map();
const drafts = new Map();

const REQUIRED_FIELDS = Object.freeze({
  case: ["dims.lengthMm", "dims.widthMm", "dims.heightMm"],
  motherboard: ["dims.lengthMm", "dims.widthMm"],
  cpu: ["power.tdpW"],
  psu: ["power.ratedW"],
  cooler: ["dims.heightMm"],
  gpu: ["dims.lengthMm", "dims.slots"],
  memory: ["attrs.capacity"],
  storage: ["attrs.capacity", "attrs.interface"],
  hba: ["attrs.interface"],
  fan: ["dims.lengthMm"],
  accessory: [],
});

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function jsonHash(value) { return sha256(JSON.stringify(value)); }
function safeText(value) { return String(value ?? "").slice(0, 240); }
function dateKey() { return now().slice(0, 10); }
function getPath(object, pathName) { return pathName.split(".").reduce((value, key) => value?.[key], object); }
function setPath(object, pathName, value) {
  const parts = pathName.split(".");
  const leaf = parts.pop();
  let target = object;
  for (const part of parts) target = target[part] ??= {};
  target[leaf] = value;
}
function slug(value) { return String(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "candidate"; }
function fieldMap(fields = []) { return new Map(fields.map((field) => [field.field, field])); }
function canonicalFields(candidate) { return candidate.fields ?? []; }
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
  const file = path.join(options.auditRoot, `${dateKey()}.json`);
  return (await readJson(file, { schemaVersion: "1.0.0", events: [] })) ?? { schemaVersion: "1.0.0", events: [] };
}

async function writeEvent(event, options) {
  const file = path.join(options.auditRoot, `${dateKey()}.json`);
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
  const map = fieldMap(fields);
  for (const field of ["brand", "model", ...(candidate.query?.mpn || candidate.mpn ? ["mpn"] : [])]) {
    if (fieldValue(fields, field) === undefined || fieldValue(fields, field) === "") errors.push(`missing ${field}`);
  }
  if (!category) errors.push("missing category");
  for (const required of REQUIRED_FIELDS[category] ?? []) if (fieldValue(fields, required) === undefined) errors.push(`missing ${required}`);
  for (const field of fields) {
    if (!allowManual && !["official-page", "official-pdf", "official-rendered-page"].includes(field.sourceKind)) errors.push(`field ${field.field} is not official`);
    if (!field.provenanceId || !field.sourceUrl || !field.retrievedAt || !field.extractor) errors.push(`field ${field.field} provenance incomplete`);
    if (typeof field.value === "number" && (!Number.isFinite(field.value) || field.value < 0)) errors.push(`field ${field.field} has invalid number`);
    if (field.sourceKind !== "manual") {
      try { validateOfficialUrl(field.sourceUrl); } catch (error) { errors.push(`field ${field.field} source blocked: ${error.message}`); }
    }
  }
  return { errors, category, map };
}

function exactIdentity(candidate, fields) {
  const mpn = String(fieldValue(fields, "mpn") ?? "").toLocaleLowerCase();
  const queryMpn = String(candidate.query?.mpn ?? candidate.mpn ?? "").toLocaleLowerCase();
  if (queryMpn && mpn && queryMpn === mpn) return "exact-mpn";
  const brand = String(fieldValue(fields, "brand") ?? "").toLocaleLowerCase();
  const model = String(fieldValue(fields, "model") ?? "").toLocaleLowerCase();
  const queryBrand = String(candidate.query?.brand ?? candidate.brand ?? "").toLocaleLowerCase();
  const queryModel = String(candidate.query?.model ?? candidate.model ?? "").toLocaleLowerCase();
  if (queryBrand && queryModel && brand === queryBrand && model === queryModel && candidate.category) return "brand-model";
  return null;
}

function validateOfficialCandidate(candidate) {
  const errors = [];
  if (!candidate) return { ok: false, errors: ["candidate not found"] };
  if (candidate.source?.kind !== "official") errors.push("candidate source is not official");
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
  if (!candidate.extraction?.contentHash) errors.push("content hash is required");
  const fields = canonicalFields(candidate);
  const fieldResult = validateFields(candidate, fields);
  errors.push(...fieldResult.errors);
  if (candidate.conflicts?.length) errors.push("unresolved official field conflict");
  const identity = exactIdentity(candidate, fields);
  if (!identity) errors.push("exact MPN or exact brand/model identity was not proven");
  return { ok: errors.length === 0, errors, fields, category: fieldResult.category, identity, canonical };
}

function skuFromFields(candidate, fields, existingId) {
  const category = candidate.category ?? candidate.query.category;
  const mpn = fieldValue(fields, "mpn");
  const model = fieldValue(fields, "model") ?? candidate.model ?? candidate.query.model ?? candidate.query.raw;
  const brand = fieldValue(fields, "brand") ?? candidate.brand ?? candidate.query.brand ?? "Unknown";
  const sku = {
    id: existingId ?? `${category}.${slug(mpn ?? `${brand}-${model}`)}`,
    category,
    brand: String(brand),
    model: String(model),
    name: `${brand} ${model}`.trim(),
    ...(mpn ? { mpn: String(mpn) } : {}),
    dims: { evidence: "official" },
    power: { evidence: "official" },
    price: { currency: "CNY", historicalLowEvidence: "unknown", currentEvidence: "unknown" },
    appearance: { page: candidate.canonicalUrl },
    provenance: fields,
  };
  for (const field of fields) {
    if (field.field.startsWith("dims.")) setPath(sku, field.field, field.value);
    else if (field.field.startsWith("power.")) setPath(sku, field.field, field.value);
    else if (field.field.startsWith("attrs.")) setPath(sku, field.field, field.value);
  }
  return sku;
}

function findSameMpn(catalog, mpn) {
  if (!mpn) return null;
  return (catalog.skus ?? []).find((sku) => String(sku.mpn ?? "").toLocaleLowerCase() === String(mpn).toLocaleLowerCase()) ?? null;
}

function changedFields(existing, proposed) {
  return ["brand", "model", "mpn", "dims", "power", "attrs", "appearance", "provenance"].filter((key) => JSON.stringify(existing?.[key]) !== JSON.stringify(proposed?.[key]));
}

async function persistDraft(draft, options) {
  await mkdir(options.draftRoot, { recursive: true });
  const file = path.join(options.draftRoot, `${dateKey()}.json`);
  const existing = await readJson(file, { schemaVersion: "1.0.0", drafts: [] });
  const draftsById = new Map((existing?.drafts ?? []).map((entry) => [entry.draftId, entry]));
  draftsById.set(draft.draftId, draft);
  await atomicWriteJson(file, { schemaVersion: "1.0.0", drafts: [...draftsById.values()] }, {
    operation: "catalog-draft",
    rollbackRoot: options.rollbackRoot,
    manifestPath: path.join(options.rollbackRoot, "draft-manifest.json"),
  });
}

function selectedFields(candidate, selections = {}) {
  const sourceFields = fieldMap(candidate.fields ?? []);
  const fields = [];
  for (const [field, source] of sourceFields) {
    const choice = selections[field];
    if (choice === undefined) {
      fields.push(source);
      continue;
    }
    const value = choice && typeof choice === "object" && "value" in choice ? choice.value : choice;
    if (JSON.stringify(value) === JSON.stringify(source.value)) fields.push(source);
    else fields.push({
      ...source,
      provenanceId: `prov-manual-${sha256(`${candidate.candidateId}|${field}|${JSON.stringify(value)}`).slice(0, 12)}`,
      value,
      evidence: "manual",
      sourceKind: "manual",
      sourceUrl: "manual://catalog-draft",
      retrievedAt: now(),
      extractor: "user-confirmed",
      locator: `draft selection: ${field}`,
      snippet: safeText(`用户确认：${field}`),
    });
  }
  for (const [field, choice] of Object.entries(selections)) {
    if (sourceFields.has(field)) continue;
    const value = choice && typeof choice === "object" && "value" in choice ? choice.value : choice;
    if (value === undefined || value === "") continue;
    fields.push({
      provenanceId: `prov-manual-${sha256(`${candidate.candidateId}|${field}|${JSON.stringify(value)}`).slice(0, 12)}`,
      field,
      value,
      evidence: "manual",
      sourceKind: "manual",
      sourceUrl: "manual://catalog-draft",
      retrievedAt: now(),
      extractor: "user-confirmed",
      locator: `draft selection: ${field}`,
      snippet: safeText(`用户确认：${field}`),
    });
  }
  return fields;
}

export async function acceptOfficial(candidateId, options = {}) {
  const resolved = config(options);
  const candidate = options.candidate ?? findCandidate(candidateId);
  // The idempotency key must include every acceptance-relevant fact. A later
  // candidate with the same content hash but a new canonical URL or conflict
  // finding must never replay an earlier accepted result.
  const inputHash = candidate ? jsonHash({ candidateId, canonicalUrl: candidate.canonicalUrl, source: candidate.source, extraction: candidate.extraction, fields: candidate.fields, conflicts: candidate.conflicts ?? [] }) : sha256(candidateId);
  const idempotencyKey = `accept-official:${candidateId}:${inputHash}`;
  const existingEvent = (await loadEvents(resolved)).events.find((event) => event.idempotencyKey === idempotencyKey);
  if (existingEvent?.result) return existingEvent.result;
  if (!resolved.catalogWriteEnabled) return { status: "blocked", candidateId, reason: "catalog write disabled", idempotencyKey };
  const checked = validateOfficialCandidate(candidate);
  if (!checked.ok) {
    return { status: "blocked", candidateId, idempotencyKey, reasons: checked.errors };
  }
  const catalog = await loadCatalog(resolved);
  const proposed = skuFromFields(candidate, checked.fields);
  const existing = findSameMpn(catalog, proposed.mpn);
  let nextSkus;
  let changed;
  if (existing) {
    const conflicts = ["brand", "model", "dims", "power", "attrs"].filter((key) => getPath(existing, key) !== undefined && JSON.stringify(existing[key]) !== JSON.stringify(proposed[key]));
    if (conflicts.length) return { status: "blocked", candidateId, idempotencyKey, reasons: conflicts.map((key) => `existing manual field conflict: ${key}`) };
    const merged = { ...existing, provenance: [...(existing.provenance ?? []), ...(proposed.provenance ?? [])] };
    nextSkus = (catalog.skus ?? []).map((sku) => sku.id === existing.id ? merged : sku);
    changed = changedFields(existing, merged);
    proposed.id = existing.id;
  } else {
    nextSkus = [...(catalog.skus ?? []), proposed];
    changed = ["new SKU", ...changedFields({}, proposed)];
  }
  const nextCatalog = { ...catalog, catalogVersion: catalogVersion(catalog), updatedAt: dateKey(), skus: nextSkus };
  const catalogHash = jsonHash(nextCatalog);
  const eventId = `catalog-event-${sha256(idempotencyKey).slice(0, 20)}`;
  const result = { status: "accepted", candidateId, skuId: proposed.id, catalogVersion: nextCatalog.catalogVersion, catalogHash, inputHash, idempotencyKey, registryVersion: resolved.registryVersion, extractorVersion: candidate.extraction.adapter, contentHash: candidate.extraction.contentHash, changedFields: changed, eventId, rollbackManifest: resolved.rollbackManifestPath };
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
}

export async function createDraft(candidateId, selections = {}, options = {}) {
  const resolved = config(options);
  const candidate = options.candidate ?? findCandidate(candidateId);
  if (!candidate) return { status: "blocked", candidateId, reasons: ["candidate not found"] };
  const selected = selectedFields(candidate, selections);
  const draftId = `sku-draft-${sha256(`${candidateId}|${JSON.stringify(selected)}`).slice(0, 20)}`;
  const existing = await getDraft(draftId, resolved);
  if (existing) return existing;
  const draft = {
    schemaVersion: "1.0.0",
    draftId,
    candidateId,
    candidateSnapshot: candidate,
    proposed: skuFromFields(candidate, selected),
    fields: selected,
    conflicts: (candidate.conflicts ?? []).filter((conflict) => selections[conflict.field] === undefined).map((conflict) => ({ field: conflict.field, proposed: conflict.values, reason: conflict.reason })),
    status: "draft",
    createdAt: now(),
    updatedAt: now(),
    inputHash: jsonHash({ candidateId, fields: selected, conflicts: candidate.conflicts ?? [] }),
    registryVersion: options.registryVersion,
    extractorVersion: candidate.extraction?.adapter,
    contentHash: candidate.extraction?.contentHash,
  };
  drafts.set(draftId, draft);
  await persistDraft(draft, resolved);
  return draft;
}

async function getDraft(draftId, options) {
  if (drafts.has(draftId)) return drafts.get(draftId);
  const file = path.join(options.draftRoot, `${dateKey()}.json`);
  const saved = await readJson(file, { drafts: [] });
  const draft = (saved?.drafts ?? []).find((entry) => entry.draftId === draftId) ?? null;
  if (draft) drafts.set(draftId, draft);
  return draft;
}

export async function rejectDraft(draftId, options = {}) {
  const resolved = config(options);
  const draft = await getDraft(draftId, resolved);
  if (!draft) return { status: "blocked", draftId, reasons: ["draft not found"] };
  const next = { ...draft, status: "rejected", updatedAt: now() };
  drafts.set(draftId, next);
  await persistDraft(next, resolved);
  return { status: "rejected", draftId };
}

export async function confirmDraft(draftId, options = {}) {
  const resolved = config(options);
  const draft = await getDraft(draftId, resolved);
  if (!draft) return { status: "blocked", draftId, reasons: ["draft not found"] };
  const inputHash = jsonHash({ draftId, fields: draft.fields });
  const idempotencyKey = `confirm-draft:${draftId}:${inputHash}`;
  const existingEvent = (await loadEvents(resolved)).events.find((event) => event.idempotencyKey === idempotencyKey);
  if (existingEvent?.result) return existingEvent.result;
  if (draft.status !== "draft") return { status: "blocked", draftId, reasons: [`draft is ${draft.status}`] };
  if (!resolved.catalogWriteEnabled) return { status: "blocked", draftId, reason: "catalog write disabled" };
  const candidate = draft.candidateSnapshot;
  const checked = validateFields(candidate, draft.fields, { allowManual: true });
  if (draft.conflicts?.length) return { status: "blocked", draftId, reasons: ["unresolved draft field conflict"] };
  if (checked.errors.some((error) => error.startsWith("missing ")) || checked.errors.some((error) => error.includes("invalid number"))) {
    return { status: "blocked", draftId, reasons: checked.errors };
  }
  const catalog = await loadCatalog(resolved);
  const proposed = skuFromFields(candidate, draft.fields);
  const existing = findSameMpn(catalog, proposed.mpn);
  if (existing && existing.id !== proposed.id) return { status: "blocked", draftId, reasons: [`duplicate MPN already exists: ${proposed.mpn}`] };
  const nextCatalog = { ...catalog, catalogVersion: catalogVersion(catalog), updatedAt: dateKey(), skus: existing ? catalog.skus : [...(catalog.skus ?? []), proposed] };
  const eventId = `catalog-event-${sha256(`confirm:${draftId}:${inputHash}`).slice(0, 20)}`;
  const result = { status: "confirmed", draftId, skuId: proposed.id, catalogVersion: nextCatalog.catalogVersion, catalogHash: jsonHash(nextCatalog), inputHash, idempotencyKey, eventId, changedFields: existing ? [] : ["new SKU"], rollbackManifest: resolved.rollbackManifestPath };
  try {
    await atomicWriteJson(resolved.catalogPath, nextCatalog, { operation: "catalog-confirm-draft", rollbackRoot: resolved.rollbackRoot, manifestPath: resolved.rollbackManifestPath });
    await writeEvent({ eventId, operation: "confirm-draft", idempotencyKey, draftId, status: "confirmed", inputHash, catalogHash: result.catalogHash, catalogVersion: result.catalogVersion, createdAt: now(), result }, resolved);
  } catch (error) {
    await restoreLatestRollback(resolved.catalogPath, { manifestPath: resolved.rollbackManifestPath }).catch(() => {});
    throw error;
  }
  const nextDraft = { ...draft, status: "confirmed", updatedAt: now() };
  drafts.set(draftId, nextDraft);
  await persistDraft(nextDraft, resolved);
  return result;
}

export async function rollbackCatalogAcceptance(catalogFile = defaultCatalogPath, options = {}) {
  const resolved = config({ ...options, catalogPath: catalogFile });
  return restoreLatestRollback(catalogFile, { manifestPath: resolved.rollbackManifestPath });
}

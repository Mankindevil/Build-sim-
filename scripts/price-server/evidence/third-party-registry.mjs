import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const THIRD_PARTY_REGISTRY_SCHEMA_VERSION = "third-party-registry-v1";
export const THIRD_PARTY_REGISTRY_OVERLAY_KIND = "third_party_source_overlay";

function resolveBundledThirdPartySeedPath() {
  const candidates = [
    fileURLToPath(new URL("../../../data/evidence/third-party-sources.json", import.meta.url)),
    fileURLToPath(new URL("../data/evidence/third-party-sources.json", import.meta.url)),
    path.resolve(process.cwd(), "data/evidence/third-party-sources.json"),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      JSON.parse(readFileSync(candidate, "utf8"));
      return candidate;
    } catch {
      // Only a bundled, parseable seed is authority for the production default.
    }
  }
  throw new Error("bundled third-party source seed is unavailable");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const THIRD_PARTY_REGISTRY_SEED_PATH = resolveBundledThirdPartySeedPath();
export const THIRD_PARTY_REGISTRY_SEED = deepFreeze(JSON.parse(readFileSync(THIRD_PARTY_REGISTRY_SEED_PATH, "utf8")));

const SOURCE_TYPES = new Set(["professional_measurement", "professional_review", "technical_database"]);
const EDITORIAL = new Set(["independent", "vendor_controlled", "unknown"]);
const FUNDING = new Set(["independent", "sponsored", "undisclosed"]);
const SOURCE_FIELDS = new Set([
  "publisherId", "name", "domains", "sourceType", "independenceGroupId", "editorialControl",
  "fundingDisclosure", "enabled", "approvedAt",
]);
const REGISTRY_FIELDS = new Set(["schemaVersion", "updatedAt", "sources"]);
const OVERLAY_FIELDS = new Set(["schemaVersion", "overlayKind", "baseRegistryVersion", "updatedAt", "sources"]);
const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PUBLIC_SUFFIXES = new Set(["com", "net", "org", "edu", "gov", "io", "co.uk", "co.jp"]);
const MAX_SOURCES = 64;
const MAX_SOURCE_DOMAINS = 8;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => descriptor.enumerable === true && "value" in descriptor);
}

function exactKeys(value, allowed) {
  return plainRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function text(value, label, maximum = 256) {
  if (typeof value !== "string" || !value || value !== value.trim() || value !== value.normalize("NFC")
    || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  try {
    if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new TypeError();
    return value;
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
}

function domain(value) {
  const normalized = text(value, "third-party domain", 253).toLocaleLowerCase();
  if (normalized !== value || normalized.includes(":") || normalized.includes("/") || normalized.includes("*")
    || normalized.endsWith(".") || !normalized.includes(".") || PUBLIC_SUFFIXES.has(normalized) || isIP(normalized)) {
    throw new TypeError("third-party domain must be a lowercase registrable hostname");
  }
  const url = new URL(`https://${normalized}`);
  if (url.hostname !== normalized || url.port || url.username || url.password || url.pathname !== "/") {
    throw new TypeError("third-party domain is invalid");
  }
  return normalized;
}

function domainsOverlap(left, right) {
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

export function loadThirdPartyRegistry(input = THIRD_PARTY_REGISTRY_SEED) {
  if (!exactKeys(input, REGISTRY_FIELDS) || input.schemaVersion !== THIRD_PARTY_REGISTRY_SCHEMA_VERSION
    || ![...REGISTRY_FIELDS].every((key) => Object.hasOwn(input, key))
    || !Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) {
    throw new TypeError("third-party registry schema is invalid");
  }
  const updatedAt = timestamp(input.updatedAt, "third-party registry updatedAt");
  const publishers = new Set();
  const assignedDomains = [];
  const sources = input.sources.map((source) => {
    if (!exactKeys(source, SOURCE_FIELDS) || ![...SOURCE_FIELDS].every((key) => Object.hasOwn(source, key))) {
      throw new TypeError("third-party registry source fields are invalid");
    }
    const publisherId = text(source.publisherId, "third-party publisherId");
    if (!SOURCE_ID.test(publisherId)) throw new TypeError("third-party publisherId must be a lowercase stable identifier");
    if (publishers.has(publisherId)) throw new TypeError("third-party registry publisher is duplicated");
    publishers.add(publisherId);
    if (!Array.isArray(source.domains) || source.domains.length === 0 || source.domains.length > MAX_SOURCE_DOMAINS) {
      throw new TypeError("third-party registry source requires bounded domains");
    }
    const sourceDomains = source.domains.map(domain).sort();
    for (const item of sourceDomains) {
      if (assignedDomains.some((prior) => domainsOverlap(item, prior))) {
        throw new TypeError("third-party registry domains are duplicated or overlap");
      }
      assignedDomains.push(item);
    }
    if (!SOURCE_TYPES.has(source.sourceType) || !EDITORIAL.has(source.editorialControl) || !FUNDING.has(source.fundingDisclosure)
      || typeof source.enabled !== "boolean") {
      throw new TypeError("third-party registry source policy is invalid");
    }
    const independenceGroupId = text(source.independenceGroupId, "third-party independenceGroupId");
    if (!SOURCE_ID.test(independenceGroupId)) {
      throw new TypeError("third-party independenceGroupId must be a lowercase stable identifier");
    }
    const approvedAt = timestamp(source.approvedAt, "third-party approvedAt");
    if (Date.parse(approvedAt) > Date.parse(updatedAt)) throw new TypeError("third-party approval cannot postdate registry update");
    return Object.freeze({
      publisherId,
      name: text(source.name, "third-party source name"),
      domains: Object.freeze(sourceDomains),
      sourceType: source.sourceType,
      independenceGroupId,
      editorialControl: source.editorialControl,
      fundingDisclosure: source.fundingDisclosure,
      enabled: source.enabled,
      approvedAt,
    });
  }).sort((left, right) => left.publisherId.localeCompare(right.publisherId));
  const material = { schemaVersion: input.schemaVersion, updatedAt, sources };
  const version = createHash("sha256").update(canonicalJson(material), "utf8").digest("hex");
  return Object.freeze({ ...material, sources: Object.freeze(sources), version });
}

export const DEFAULT_THIRD_PARTY_REGISTRY = loadThirdPartyRegistry();

export function thirdPartyRegistryDocument(registry = DEFAULT_THIRD_PARTY_REGISTRY) {
  const resolved = resolveThirdPartyRegistry(registry);
  return {
    schemaVersion: resolved.schemaVersion,
    updatedAt: resolved.updatedAt,
    sources: resolved.sources.map((source) => ({ ...source, domains: [...source.domains] })),
  };
}

function loadedRegistry(input) {
  if (!plainRecord(input) || typeof input.version !== "string") return null;
  if (!/^[a-f0-9]{64}$/.test(input.version) || !Array.isArray(input.sources)) {
    throw new TypeError("loaded third-party registry is invalid");
  }
  const document = {
    schemaVersion: input.schemaVersion,
    updatedAt: input.updatedAt,
    sources: input.sources.map((source) => ({ ...source, domains: [...source.domains] })),
  };
  const verified = loadThirdPartyRegistry(document);
  if (verified.version !== input.version) throw new TypeError("loaded third-party registry version mismatch");
  return verified;
}

export function validateThirdPartyRegistryOverlay(value, options = {}) {
  try {
    if (!exactKeys(value, OVERLAY_FIELDS) || ![...OVERLAY_FIELDS].every((key) => Object.hasOwn(value, key))
      || value.schemaVersion !== THIRD_PARTY_REGISTRY_SCHEMA_VERSION || value.overlayKind !== THIRD_PARTY_REGISTRY_OVERLAY_KIND
      || typeof value.baseRegistryVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.baseRegistryVersion)) {
      return ["third-party registry overlay schema is invalid"];
    }
    const updatedAt = timestamp(value.updatedAt, "third-party registry overlay updatedAt");
    loadThirdPartyRegistry({ schemaVersion: THIRD_PARTY_REGISTRY_SCHEMA_VERSION, updatedAt, sources: value.sources });
    if (options.baseRegistryVersion !== undefined && value.baseRegistryVersion !== options.baseRegistryVersion) {
      return ["third-party registry overlay base version mismatch"];
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : "third-party registry overlay is invalid"];
  }
}

/** Runtime overlays are append-only and version-bound. Seed publishers or
 * domains cannot be replaced, shadowed, or widened by an overlay. */
export function mergeThirdPartyRegistry(seedInput = THIRD_PARTY_REGISTRY_SEED, overlayInput = null) {
  const seed = loadedRegistry(seedInput) ?? loadThirdPartyRegistry(seedInput);
  if (overlayInput === null || overlayInput === undefined) return seed;
  const errors = validateThirdPartyRegistryOverlay(overlayInput, { baseRegistryVersion: seed.version });
  if (errors.length) throw new TypeError(errors.join("; "));
  if (Date.parse(overlayInput.updatedAt) < Date.parse(seed.updatedAt)) {
    throw new TypeError("third-party registry overlay predates its seed");
  }
  return loadThirdPartyRegistry({
    schemaVersion: THIRD_PARTY_REGISTRY_SCHEMA_VERSION,
    updatedAt: overlayInput.updatedAt,
    sources: [...seed.sources.map((source) => ({ ...source, domains: [...source.domains] })), ...overlayInput.sources],
  });
}

/** Accept a raw registry, an already verified registry, or a version-bound
 * overlay. Overlay records always extend the immutable bundled seed. */
export function resolveThirdPartyRegistry(input = undefined) {
  if (input === undefined || input === null) return DEFAULT_THIRD_PARTY_REGISTRY;
  const verified = loadedRegistry(input);
  if (verified) return verified;
  if (plainRecord(input) && input.overlayKind === THIRD_PARTY_REGISTRY_OVERLAY_KIND) {
    return mergeThirdPartyRegistry(THIRD_PARTY_REGISTRY_SEED, input);
  }
  return loadThirdPartyRegistry(input);
}

export function thirdPartyRegistryForUrl(rawUrl, registry = DEFAULT_THIRD_PARTY_REGISTRY) {
  let url;
  try { url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) return null;
  const hostname = url.hostname.toLocaleLowerCase();
  try {
    const resolved = resolveThirdPartyRegistry(registry);
    return resolved.sources.find((source) => source.enabled
      && source.domains.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`))) ?? null;
  } catch {
    return null;
  }
}

export function thirdPartyRegistryForPublisher(publisherId, registry = DEFAULT_THIRD_PARTY_REGISTRY) {
  try {
    const resolved = resolveThirdPartyRegistry(registry);
    return resolved.sources.find((source) => source.enabled && source.publisherId === publisherId) ?? null;
  } catch {
    return null;
  }
}

/** Adapter accepted by the existing DNS-pinned/redirect-governed fetcher. */
export function thirdPartyFetchRegistry(registry = DEFAULT_THIRD_PARTY_REGISTRY) {
  const resolved = resolveThirdPartyRegistry(registry);
  return Object.freeze({
    schemaVersion: "1.0.0",
    updatedAt: resolved.updatedAt,
    version: resolved.version,
    brands: Object.freeze(resolved.sources.filter((source) => source.enabled).map((source) => Object.freeze({
      brand: source.publisherId,
      aliases: Object.freeze([]),
      domains: source.domains,
      trustStatus: "trusted",
      source: "manual",
      approvedAt: source.approvedAt,
    }))),
  });
}

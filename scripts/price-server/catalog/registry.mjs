import crypto from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeCoordinator } from "../../../src/runtime/coordinator.mjs";
import { confined } from "../../../src/runtime/fs.mjs";

const registryJson = createRequire(import.meta.url)("../../../data/catalog/official-domains.json");
export const OFFICIAL_DOMAIN_SEED_PATH = fileURLToPath(new URL("../../../data/catalog/official-domains.json", import.meta.url));
const TRUST = new Set(["trusted", "proposed", "rejected"]);
const SOURCES = new Set(["seed", "catalog-provenance", "agent-proposal", "manual"]);
const PUBLIC_SUFFIXES = new Set(["com", "net", "org", "edu", "gov", "jp", "co.jp", "cn", "co.uk"]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function normalizedDomain(value) {
  if (typeof value !== "string" || value !== value.trim() || value !== value.toLocaleLowerCase()) throw new Error("registry domain must be a lowercase hostname");
  if (value.includes(":") || value.includes("/") || value.includes("?") || value.includes("#")) throw new Error("registry domain must not include protocol or path");
  if (PUBLIC_SUFFIXES.has(value) || !value.includes(".")) throw new Error("registry domain cannot be a public suffix");
  let parsed;
  try { parsed = new URL(`https://${value}`); } catch { throw new Error("registry domain is invalid"); }
  if (parsed.hostname !== value || parsed.port || parsed.username || parsed.password) throw new Error("registry domain is invalid");
  return value;
}

export function loadOfficialRegistry(input = registryJson) {
  if (!input || input.schemaVersion !== "1.0.0" || !Number.isFinite(Date.parse(input.updatedAt)) || !Array.isArray(input.brands)) throw new Error("official registry schema is invalid");
  const brands = new Set();
  const aliases = new Set();
  const domains = new Set();
  const normalized = input.brands.map((entry) => {
    if (!entry || typeof entry.brand !== "string" || !entry.brand.trim()) throw new Error("registry brand is required");
    const brandKey = entry.brand.toLocaleLowerCase();
    if (brands.has(brandKey)) throw new Error(`duplicate registry brand: ${entry.brand}`);
    brands.add(brandKey);
    const entryAliases = entry.aliases ?? [];
    if (aliases.has(brandKey)) throw new Error(`duplicate registry brand alias: ${entry.brand}`);
    aliases.add(brandKey);
    for (const alias of entryAliases) {
      const key = String(alias).toLocaleLowerCase();
      if (key === brandKey) continue;
      if (aliases.has(key) || brands.has(key)) throw new Error(`duplicate registry brand alias: ${alias}`);
      aliases.add(key);
    }
    if (!Array.isArray(entry.domains) || !entry.domains.length) throw new Error(`registry domains required for ${entry.brand}`);
    const entryDomains = entry.domains.map(normalizedDomain);
    for (const domain of entryDomains) {
      if (domains.has(domain)) throw new Error(`duplicate registry domain: ${domain}`);
      domains.add(domain);
    }
    if (!TRUST.has(entry.trustStatus)) throw new Error(`registry trustStatus invalid for ${entry.brand}`);
    if (!SOURCES.has(entry.source)) throw new Error(`registry source invalid for ${entry.brand}`);
    if (entry.trustStatus === "trusted" && !Number.isFinite(Date.parse(entry.approvedAt))) throw new Error(`trusted registry entry requires approvedAt: ${entry.brand}`);
    if (entry.search && (entry.search.kind !== "site-search" || typeof entry.search.urlTemplate !== "string" || !entry.search.urlTemplate.includes("{query}"))) throw new Error(`registry search invalid for ${entry.brand}`);
    return Object.freeze({ ...entry, aliases: Object.freeze([...entryAliases]), domains: Object.freeze(entryDomains) });
  });
  const versionDocument = {
    schemaVersion: input.schemaVersion,
    updatedAt: input.updatedAt,
    brands: normalized.map((entry) => ({ ...entry, aliases: [...entry.aliases], domains: [...entry.domains] })),
  };
  const version = crypto.createHash("sha256").update(canonicalJson(versionDocument)).digest("hex");
  return Object.freeze({ schemaVersion: input.schemaVersion, updatedAt: input.updatedAt, version, brands: Object.freeze(normalized) });
}

export const OFFICIAL_DOMAIN_REGISTRY = loadOfficialRegistry();
export const OFFICIAL_REGISTRY_VERSION = OFFICIAL_DOMAIN_REGISTRY.version;
export const OFFICIAL_REGISTRY = OFFICIAL_DOMAIN_REGISTRY.brands;

export function officialRegistryDocument(registry) {
  return {
    schemaVersion: "1.0.0",
    updatedAt: registry.updatedAt,
    brands: registry.brands.map((entry) => ({
      ...entry,
      aliases: [...(entry.aliases ?? [])],
      domains: [...entry.domains],
    })),
  };
}

/** Merge a bundled official-domain seed with a runtime overlay. The overlay
 * contains only approved product-domain records and is never written back to
 * the bundled seed. */
export function mergeOfficialRegistry(seedInput, overlayInput = null) {
  const seed = loadOfficialRegistry(seedInput);
  if (overlayInput === null) return seed;
  if (!overlayInput || overlayInput.overlayKind !== "official_domain_overlay" || typeof overlayInput.baseRegistryVersion !== "string") throw new Error("official domain overlay schema is invalid");
  if (overlayInput.baseRegistryVersion !== seed.version) throw new Error("official domain overlay base version mismatch");
  const overlay = loadOfficialRegistry({ schemaVersion: "1.0.0", updatedAt: overlayInput.updatedAt, brands: overlayInput.brands ?? [] });
  if (overlay.brands.length === 0) return seed;
  const byBrand = new Map(seed.brands.map((entry) => [entry.brand.toLocaleLowerCase(), entry]));
  for (const entry of overlay.brands) {
    const key = entry.brand.toLocaleLowerCase();
    const prior = byBrand.get(key);
    byBrand.set(key, prior ? { ...prior, ...entry, domains: [...new Set([...prior.domains, ...entry.domains])] } : entry);
  }
  return loadOfficialRegistry({ schemaVersion: "1.0.0", updatedAt: overlayInput.updatedAt, brands: [...byBrand.values()] });
}

export function validateOfficialRegistryOverlay(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["official domain overlay must be an object"];
  if (value.schemaVersion !== "1.0.0" || value.overlayKind !== "official_domain_overlay") errors.push("official domain overlay schema is invalid");
  if (typeof value.baseRegistryVersion !== "string" || !value.baseRegistryVersion) errors.push("official domain overlay baseRegistryVersion is required");
  if (!Number.isFinite(Date.parse(value.updatedAt))) errors.push("official domain overlay updatedAt is invalid");
  try { loadOfficialRegistry({ schemaVersion: "1.0.0", updatedAt: value.updatedAt, brands: value.brands }); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}

function exactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertStrictRegistryBrands(brands, label) {
  const allowedBrandKeys = new Set(["brand", "aliases", "domains", "trustStatus", "source", "approvedAt", "search"]);
  for (const entry of brands) {
    if (!exactKeys(entry, allowedBrandKeys)
      || (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string" || !alias)))
      || (entry.search !== undefined && (!entry.search || typeof entry.search !== "object" || Array.isArray(entry.search)
        || !exactKeys(entry.search, new Set(["kind", "urlTemplate"])))) ) {
      throw new Error(`${label} contains unknown or malformed registry fields`);
    }
  }
}

/** Strict persisted form used by production backup/restore and Doctor. */
export function assertOfficialDomainRegistryDocument(value, label = "official domain registry") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, new Set(["schemaVersion", "updatedAt", "brands"]))) {
    throw new Error(`${label} contains unknown or malformed registry fields`);
  }
  const registry = loadOfficialRegistry(value);
  assertStrictRegistryBrands(value.brands, label);
  return registry;
}

/** Strict persisted overlay form bound to the immutable bundled registry. */
export function assertOfficialDomainOverlayDocument(value, options = {}) {
  const label = options.label ?? "official domain overlay";
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, new Set(["schemaVersion", "overlayKind", "baseRegistryVersion", "updatedAt", "brands"]))) {
    throw new Error(`${label} contains unknown or malformed overlay fields`);
  }
  const errors = validateOfficialRegistryOverlay(value);
  if (errors.length) throw new Error(errors.join("; "));
  assertStrictRegistryBrands(value.brands, label);
  const expectedBase = options.baseRegistryVersion ?? OFFICIAL_REGISTRY_VERSION;
  if (value.baseRegistryVersion !== expectedBase) throw new Error(`${label} base version mismatch`);
  return value;
}

function registryUsesCoordinator(options = {}) {
  if (options.coordinator || options.generationAware === true) return true;
  if (options.direct === true || options.generationAware === false || options.overlayPath) return false;
  return options.persistRoot === undefined && process.env.CATALOG_PERSIST_ROOT === undefined;
}

function registryCoordinator(options = {}) {
  return options.coordinator ?? new RuntimeCoordinator({
    root: options.runtimeRoot ?? options.persistRoot ?? process.env.RUNTIME_ROOT ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"),
    now: options.now,
  });
}

function registryPaths(options = {}, activeRoot = null) {
  const seedPath = path.resolve(options.seedPath ?? OFFICIAL_DOMAIN_SEED_PATH);
  const runtimeRoot = path.resolve(options.persistRoot ?? process.env.CATALOG_PERSIST_ROOT ?? path.join(process.cwd(), "runtime"));
  const overlayPath = activeRoot
    ? confined(activeRoot, "domain-overlays", "official-domains.overlay.json")
    : path.resolve(options.overlayPath ?? path.join(runtimeRoot, "data/catalog/official-domains.overlay.json"));
  return {
    seedPath, overlayPath,
    ...(activeRoot ? {
      materializedPath: confined(activeRoot, "domain-overlays", "official-domains.json"),
      transactionManifestPath: confined(activeRoot, "audit", "rollback", "domain", "official-registry-manifest.json"),
      validateCommit: true,
    } : {}),
  };
}

async function loadOfficialAtPaths({ seedPath, overlayPath, materializedPath, transactionManifestPath, validateCommit = false }) {
  const seed = JSON.parse(await readFile(seedPath, "utf8"));
  const seedRegistry = assertOfficialDomainRegistryDocument(seed, "official domain seed");
  let overlay = null;
  try { overlay = JSON.parse(await readFile(overlayPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (overlay) assertOfficialDomainOverlayDocument(overlay, { baseRegistryVersion: seedRegistry.version });
  const merged = mergeOfficialRegistry(seed, overlay);
  if (validateCommit) {
    let manifest = null;
    try { manifest = JSON.parse(await readFile(transactionManifestPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if ((manifest?.transactions ?? []).some((entry) => ["applying", "rolling_back"].includes(entry.status))) throw new Error("official registry has an incomplete approval transaction");
    let materialized = null;
    try { materialized = JSON.parse(await readFile(materializedPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!materialized && (overlay?.brands?.length ?? 0) > 0) throw new Error("official registry materialization is missing for a non-empty overlay");
    if (materialized && assertOfficialDomainRegistryDocument(materialized, "materialized official domain registry").version !== merged.version) throw new Error("official registry materialization diverges from seed + overlay repository");
  }
  return merged;
}

function loadOfficialAtPathsSync({ seedPath, overlayPath, materializedPath, transactionManifestPath, validateCommit = false }) {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const seedRegistry = assertOfficialDomainRegistryDocument(seed, "official domain seed");
  let overlay = null;
  try { overlay = JSON.parse(readFileSync(overlayPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (overlay) assertOfficialDomainOverlayDocument(overlay, { baseRegistryVersion: seedRegistry.version });
  const merged = mergeOfficialRegistry(seed, overlay);
  if (validateCommit) {
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(transactionManifestPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if ((manifest?.transactions ?? []).some((entry) => ["applying", "rolling_back"].includes(entry.status))) throw new Error("official registry has an incomplete approval transaction");
    let materialized = null;
    try { materialized = JSON.parse(readFileSync(materializedPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!materialized && (overlay?.brands?.length ?? 0) > 0) throw new Error("official registry materialization is missing for a non-empty overlay");
    if (materialized && assertOfficialDomainRegistryDocument(materialized, "materialized official domain registry").version !== merged.version) throw new Error("official registry materialization diverges from seed + overlay repository");
  }
  return merged;
}

/** Read a seed and optional persisted overlay as one repository snapshot. */
export async function loadOfficialRegistryRepository(options = {}) {
  if (!registryUsesCoordinator(options)) return loadOfficialAtPaths(registryPaths(options));
  const coordinator = registryCoordinator(options);
  await coordinator.initialize(options.appVersion);
  return (await coordinator.withConsistentSnapshot(({ activeRoot }) => loadOfficialAtPaths(registryPaths(options, activeRoot)))).result;
}

let ACTIVE_OFFICIAL_REGISTRY = OFFICIAL_DOMAIN_REGISTRY;
let ACTIVE_REPOSITORY_CONFIG = null;
let ACTIVE_REPOSITORY_STATE = null;

/** Activate a validated runtime registry in this process without a restart. */
export function activateOfficialRegistry(input) {
  ACTIVE_REPOSITORY_CONFIG = null;
  ACTIVE_REPOSITORY_STATE = null;
  ACTIVE_OFFICIAL_REGISTRY = loadOfficialRegistry(officialRegistryDocument(input));
  return ACTIVE_OFFICIAL_REGISTRY;
}

/** Load seed + runtime overlay and atomically replace this process' active view. */
export async function activateOfficialRegistryRepository(options = {}) {
  if (!registryUsesCoordinator(options)) return activateOfficialRegistry(await loadOfficialRegistryRepository(options));
  const coordinator = registryCoordinator(options);
  await coordinator.initialize(options.appVersion);
  const snapshot = await coordinator.withConsistentSnapshot(({ activeRoot }) => loadOfficialAtPaths(registryPaths(options, activeRoot)));
  ACTIVE_OFFICIAL_REGISTRY = loadOfficialRegistry(officialRegistryDocument(snapshot.result));
  ACTIVE_REPOSITORY_CONFIG = { ...options, coordinator, generationAware: true };
  ACTIVE_REPOSITORY_STATE = { runtimeGeneration: snapshot.state.runtimeGeneration, revision: snapshot.state.revision, activeRoot: snapshot.state.activeRoot };
  return ACTIVE_OFFICIAL_REGISTRY;
}

export function activeOfficialRegistry() {
  if (ACTIVE_REPOSITORY_CONFIG) {
    const coordinator = ACTIVE_REPOSITORY_CONFIG.coordinator;
    const state = JSON.parse(readFileSync(coordinator.stateFile, "utf8"));
    if (!ACTIVE_REPOSITORY_STATE || state.runtimeGeneration !== ACTIVE_REPOSITORY_STATE.runtimeGeneration
      || state.revision !== ACTIVE_REPOSITORY_STATE.revision || state.activeRoot !== ACTIVE_REPOSITORY_STATE.activeRoot) {
      ACTIVE_OFFICIAL_REGISTRY = loadOfficialAtPathsSync(registryPaths(ACTIVE_REPOSITORY_CONFIG, coordinator.activeRoot(state)));
      ACTIVE_REPOSITORY_STATE = { runtimeGeneration: state.runtimeGeneration, revision: state.revision, activeRoot: state.activeRoot };
    }
  }
  return ACTIVE_OFFICIAL_REGISTRY;
}

export function registryForBrand(brand, registry = OFFICIAL_DOMAIN_REGISTRY) {
  if (!brand) return null;
  if (arguments.length < 2) registry = activeOfficialRegistry();
  const lower = String(brand).toLocaleLowerCase();
  return registry.brands.find((entry) => [entry.brand, ...(entry.aliases ?? [])].some((alias) => alias.toLocaleLowerCase() === lower)) ?? null;
}

export function registryForUrl(url, registry = OFFICIAL_DOMAIN_REGISTRY) {
  if (arguments.length < 2) registry = activeOfficialRegistry();
  const hostname = url.hostname.toLocaleLowerCase();
  return registry.brands.find((entry) => entry.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) ?? null;
}

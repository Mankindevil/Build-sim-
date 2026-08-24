import crypto from "node:crypto";
import { createRequire } from "node:module";

const registryJson = createRequire(import.meta.url)("../../../data/catalog/official-domains.json");
const TRUST = new Set(["trusted", "proposed", "rejected"]);
const SOURCES = new Set(["seed", "catalog-provenance", "agent-proposal", "manual"]);
const PUBLIC_SUFFIXES = new Set(["com", "net", "org", "edu", "gov", "jp", "co.jp", "cn", "co.uk"]);

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
  const version = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return Object.freeze({ schemaVersion: input.schemaVersion, updatedAt: input.updatedAt, version, brands: Object.freeze(normalized) });
}

export const OFFICIAL_DOMAIN_REGISTRY = loadOfficialRegistry();
export const OFFICIAL_REGISTRY_VERSION = OFFICIAL_DOMAIN_REGISTRY.version;
export const OFFICIAL_REGISTRY = OFFICIAL_DOMAIN_REGISTRY.brands;

export function registryForBrand(brand, registry = OFFICIAL_DOMAIN_REGISTRY) {
  if (!brand) return null;
  const lower = String(brand).toLocaleLowerCase();
  return registry.brands.find((entry) => [entry.brand, ...(entry.aliases ?? [])].some((alias) => alias.toLocaleLowerCase() === lower)) ?? null;
}

export function registryForUrl(url, registry = OFFICIAL_DOMAIN_REGISTRY) {
  const hostname = url.hostname.toLocaleLowerCase();
  return registry.brands.find((entry) => entry.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) ?? null;
}

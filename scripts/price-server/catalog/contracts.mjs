import crypto from "node:crypto";

/**
 * Provider-neutral catalog enrichment contracts. These records deliberately
 * separate URL discovery evidence from official field evidence.
 *
 * @typedef {{raw:string, brand?:string, model?:string, mpn?:string, category?:string, locale:string, tokens:string[]}} NormalizedModelQuery
 * @typedef {{url:string, title?:string, snippet?:string, provider:string, engine?:string, retrievedAt:string, rank:number}} DiscoveredUrl
 * @typedef {{id:string, discover(input:{query:NormalizedModelQuery, allowedDomains:string[], limit:number, signal:AbortSignal}):Promise<DiscoveredUrl[]>}} CatalogDiscoveryProvider
 * @typedef {{requestedUrl:string, finalUrl:string, status:number, contentType:string, retrievedAt:string, body:string, contentHash:string, redirects:string[], fallback?:string}} RenderedOfficialPage
 * @typedef {{brand:string, domain:string, status:"proposed"|"trusted"|"rejected", discoveryProvider:string, discoveredUrl:string, finalUrl?:string, exactMpnEvidence?:{mpn:string, locator:string, snippet:string}, createdAt:string, updatedAt:string}} DomainProposal
 * @typedef {{status:"accepted"|"draft"|"blocked", candidateId:string, inputHash:string, registryVersion:string, extractorVersion?:string, contentHash?:string, changedFields:string[], conflicts:unknown[], rollbackManifest?:string}} EnrichmentResult
 */

export const CATALOG_CONTRACT_VERSION = "1.0.0";
export const DISCOVERY_EVIDENCE_KINDS = Object.freeze(["catalog", "registry-search", "searxng"]);
export const OFFICIAL_FIELD_SOURCE_KINDS = Object.freeze(["official-page", "official-pdf", "official-ocr-pdf", "official-rendered-page"]);

export function isOfficialFieldProvenance(value) {
  return Boolean(value
    && OFFICIAL_FIELD_SOURCE_KINDS.includes(value.sourceKind)
    && typeof value.sourceUrl === "string"
    && typeof value.retrievedAt === "string"
    && typeof value.extractor === "string"
    && typeof value.locator === "string"
    && typeof value.snippet === "string");
}

export function assertDiscoveryResult(value) {
  if (!value || typeof value !== "object") throw new Error("discovery result must be an object");
  if (typeof value.url !== "string" || !value.url.startsWith("https://")) throw new Error("discovery URL must use HTTPS");
  if (typeof value.provider !== "string" || !value.provider) throw new Error("discovery provider is required");
  if (!Number.isInteger(value.rank) || value.rank < 0) throw new Error("discovery rank must be a non-negative integer");
  if (!Number.isFinite(Date.parse(value.retrievedAt))) throw new Error("discovery retrievedAt must be an ISO timestamp");
  if ("fields" in value || "officialFields" in value) throw new Error("discovery results cannot contain official fields");
  return value;
}

export function catalogCandidateInputHash(candidate) {
  const value = { candidateId: candidate?.candidateId, canonicalUrl: candidate?.canonicalUrl, source: candidate?.source, extraction: candidate?.extraction, fields: candidate?.fields, conflicts: candidate?.conflicts ?? [] };
  const stable = (entry) => {
    if (Array.isArray(entry)) return `[${entry.map(stable).join(",")}]`;
    if (entry && typeof entry === "object") return `{${Object.entries(entry).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
    return JSON.stringify(entry);
  };
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

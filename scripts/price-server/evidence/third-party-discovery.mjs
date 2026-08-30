import { createHash } from "node:crypto";
import {
  SearXngDiscoveryProvider,
  validateSearXngBaseUrl,
} from "../catalog/searxng-discovery.mjs";
import {
  DEFAULT_THIRD_PARTY_REGISTRY,
  resolveThirdPartyRegistry,
  thirdPartyRegistryForUrl,
} from "./third-party-registry.mjs";

export const THIRD_PARTY_DISCOVERY_SCHEMA_VERSION = "third-party-discovery-v1";
const IDENTITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const MAX_QUERY_LENGTH = 240;
const MAX_RESULTS = 4;
const DISCOVERY_SCAN_RESULTS = 16;
const DOMAINS_PER_QUERY = 16;

export class ThirdPartyDiscoveryError extends Error {
  constructor(code, message, options = {}) {
    super(String(message).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500));
    this.name = "ThirdPartyDiscoveryError";
    this.code = code;
    this.offline = options.offline === true;
    this.retryable = options.retryable === true;
  }
}

function identityToken(value, label) {
  if (typeof value !== "string" || value !== value.trim() || value !== value.normalize("NFC")
    || !IDENTITY_TOKEN.test(value)) throw new ThirdPartyDiscoveryError("identity_incomplete", `${label} is required for exact third-party discovery`);
  return value;
}

function humanText(value, label) {
  if (typeof value !== "string" || !value || value !== value.trim() || value !== value.normalize("NFC")
    || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ThirdPartyDiscoveryError("identity_incomplete", `${label} is required for exact third-party discovery`);
  }
  return value;
}

function quoted(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/** Search material is derived only from the governed exact subject. The
 * transport search string and any user-supplied domain are deliberately
 * excluded. */
export function createExactThirdPartySearchQuery(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || !request.subject
    || typeof request.subject !== "object" || Array.isArray(request.subject)) {
    throw new ThirdPartyDiscoveryError("identity_incomplete", "Exact third-party discovery requires a governed request subject");
  }
  const subject = request.subject;
  const brand = humanText(subject.brand, "subject.brand");
  const modelId = identityToken(subject.modelId, "subject.modelId");
  const variantId = identityToken(subject.variantId, "subject.variantId");
  const revision = identityToken(subject.revision, "subject.revision");
  const raw = [brand, modelId, variantId, revision].map(quoted).join(" ");
  if (raw.length > MAX_QUERY_LENGTH) {
    throw new ThirdPartyDiscoveryError("identity_query_too_long", "Exact third-party discovery identity exceeds the bounded query length");
  }
  return Object.freeze({
    raw,
    mpn: raw,
    brand,
    model: modelId,
    tokens: Object.freeze([brand, modelId, variantId, revision].map((value) => value.toLocaleLowerCase())),
    locale: "en-US",
  });
}

function boundedLimit(value) {
  const limit = value ?? MAX_RESULTS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new ThirdPartyDiscoveryError("invalid_limits", `third-party discovery limit must be between 1 and ${MAX_RESULTS}`);
  }
  return limit;
}

function providerFor(registry, options) {
  let provider;
  try {
    provider = options.provider ?? new SearXngDiscoveryProvider({
      ...(options.searxng ?? {}),
      registryVersion: registry.version,
      resultLimit: Math.max(options.searxng?.resultLimit ?? DISCOVERY_SCAN_RESULTS, DISCOVERY_SCAN_RESULTS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SearXNG provider configuration is invalid";
    throw new ThirdPartyDiscoveryError(/loopback/i.test(message) ? "provider_not_loopback" : "provider_invalid", message);
  }
  if (!provider || provider.id !== "searxng" || typeof provider.discover !== "function") {
    throw new ThirdPartyDiscoveryError("provider_not_allowed", "Third-party discovery only permits the governed SearXNG provider");
  }
  try {
    validateSearXngBaseUrl(String(provider.baseUrl));
  } catch (error) {
    throw new ThirdPartyDiscoveryError("provider_not_loopback", error instanceof Error ? error.message : "SearXNG provider is not loopback");
  }
  return provider;
}

function classifyProviderFailure(error) {
  if (error instanceof ThirdPartyDiscoveryError) return error;
  const detail = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 240);
  const offline = /ENETUNREACH|EAI_AGAIN|network is unreachable|offline/i.test(detail);
  const cancelled = /cancel|abort/i.test(detail);
  return new ThirdPartyDiscoveryError(
    cancelled ? "discovery_cancelled" : offline ? "discovery_offline" : "discovery_failed",
    cancelled ? "Third-party discovery was cancelled" : offline ? "Third-party discovery is offline" : `Third-party discovery failed: ${detail}`,
    { offline, retryable: !cancelled },
  );
}

function canonicalCandidate(raw, registry) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.url !== "string" || raw.url.length > 4_096) return null;
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }
  const source = thirdPartyRegistryForUrl(url, registry);
  if (!source) return null;
  const canonicalUrl = url.toString();
  const rank = Number.isSafeInteger(raw.rank) && raw.rank >= 0 ? raw.rank : Number.MAX_SAFE_INTEGER;
  return Object.freeze({
    schemaVersion: THIRD_PARTY_DISCOVERY_SCHEMA_VERSION,
    url: canonicalUrl,
    publisherId: source.publisherId,
    sourceType: source.sourceType,
    independenceGroupId: source.independenceGroupId,
    provider: "searxng",
    rank,
  });
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

/** Discover at most four independently-owned approved sources. Results and
 * snippets from SearXNG are candidate locations only; every URL is checked
 * again against the server-owned source registry before it is returned. */
export async function discoverThirdPartyEvidenceCandidates(input, options = {}) {
  const registry = resolveThirdPartyRegistry(input?.registry ?? options.registry ?? DEFAULT_THIRD_PARTY_REGISTRY);
  const limit = boundedLimit(options.limit);
  const query = createExactThirdPartySearchQuery(input?.request);
  const provider = providerFor(registry, options);
  const domains = [...new Set(registry.sources.filter((source) => source.enabled).flatMap((source) => source.domains))].sort();
  if (!domains.length) return Object.freeze([]);
  const rawResults = [];
  try {
    for (const allowedDomains of chunks(domains, DOMAINS_PER_QUERY)) {
      const result = await provider.discover({
        query,
        allowedDomains,
        limit: DISCOVERY_SCAN_RESULTS,
        signal: options.signal ?? new AbortController().signal,
        registry,
      });
      if (!Array.isArray(result)) throw new TypeError("SearXNG result must be an array");
      rawResults.push(...result);
    }
  } catch (error) {
    throw classifyProviderFailure(error);
  }

  const byUrl = new Map();
  for (const raw of rawResults) {
    const candidate = canonicalCandidate(raw, registry);
    if (!candidate) continue;
    const prior = byUrl.get(candidate.url);
    if (!prior || candidate.rank < prior.rank) byUrl.set(candidate.url, candidate);
  }
  const ordered = [...byUrl.values()].sort((left, right) => left.publisherId.localeCompare(right.publisherId)
    || left.rank - right.rank || left.url.localeCompare(right.url));
  const groups = new Set();
  const selected = [];
  for (const candidate of ordered) {
    if (groups.has(candidate.independenceGroupId)) continue;
    groups.add(candidate.independenceGroupId);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return Object.freeze(selected);
}

/** Constructor-compatible seam for createProductionEvidenceStageServices. */
export function createDefaultThirdPartyDiscovery(options = {}) {
  const frozenOptions = Object.freeze({ ...options });
  return async (input) => discoverThirdPartyEvidenceCandidates(input, frozenOptions);
}

export function thirdPartyDiscoveryQueryHash(request) {
  const query = createExactThirdPartySearchQuery(request);
  return createHash("sha256").update(query.raw.normalize("NFC"), "utf8").digest("hex");
}

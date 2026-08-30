import { createHash } from "node:crypto";
import { fetchOfficial } from "../catalog/fetch.mjs";
import {
  loadThirdPartyRegistry,
  thirdPartyFetchRegistry,
  thirdPartyRegistryForUrl,
} from "./third-party-registry.mjs";

export class ThirdPartyAcquisitionError extends Error {
  constructor(code, message, options = {}) {
    super(String(message).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500),
      ...(options.cause === undefined ? [] : [{ cause: options.cause }]));
    this.name = "ThirdPartyAcquisitionError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.offline = options.offline === true;
  }
}

function errorChainText(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current) && parts.length < 8) {
    seen.add(current);
    parts.push(String(current.code ?? ""), String(current.message ?? ""));
    current = current.cause;
  }
  return parts.join(" ");
}

function boundedMaxBytes(value) {
  const result = value ?? 10_000_000;
  if (!Number.isSafeInteger(result) || result < 1_024 || result > 25_000_000) throw new ThirdPartyAcquisitionError("invalid_limits", "Third-party byte limit is invalid");
  return result;
}

function canonicalRetrievedAt(value, label) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new ThirdPartyAcquisitionError("retrieved_at_invalid", `${label} timestamp is invalid`);
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error("non-canonical timestamp");
  } catch {
    throw new ThirdPartyAcquisitionError("retrieved_at_invalid", `${label} timestamp is invalid`);
  }
  return value;
}

/**
 * Fetches one explicitly registry-approved professional source. It never calls
 * the official EvidenceRepository, so third-party bytes cannot acquire an
 * official capture identity. The caller must archive returned bytes as an
 * artifact under its active job fence.
 */
export async function acquireThirdPartyEvidence(rawUrl, options = {}) {
  const registry = options.registry?.version ? options.registry : loadThirdPartyRegistry(options.registry);
  const source = thirdPartyRegistryForUrl(rawUrl, registry);
  if (!source) throw new ThirdPartyAcquisitionError("source_not_approved", "Third-party URL is not in the governed source registry");
  const maxBytes = boundedMaxBytes(options.maxBytes);
  const fetcher = options.fetcher ?? fetchOfficial;
  let result;
  try {
    result = await fetcher(String(rawUrl), {
      includeBody: true,
      extractContent: false,
      expectedBrand: source.publisherId,
      registry: thirdPartyFetchRegistry(registry),
      maxBytes,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxRedirects: options.maxRedirects ?? 3,
    });
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 240);
    const offline = /ENETUNREACH|EHOSTUNREACH|ENETDOWN|EAI_AGAIN|network is unreachable|offline/i.test(errorChainText(error));
    throw new ThirdPartyAcquisitionError("fetch_failed", "Approved third-party source fetch failed", { retryable: !offline, offline, cause: error });
  }
  const finalSource = thirdPartyRegistryForUrl(result?.finalUrl, registry);
  if (!finalSource || finalSource.publisherId !== source.publisherId) {
    throw new ThirdPartyAcquisitionError("publisher_redirect_mismatch", "Third-party fetch crossed its approved publisher boundary");
  }
  if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300) {
    throw new ThirdPartyAcquisitionError("http_status", `Third-party source returned HTTP ${String(result?.status ?? "invalid")}`, { retryable: true });
  }
  if (!Buffer.isBuffer(result.rawBody) || result.rawBody.byteLength === 0 || result.rawBody.byteLength > maxBytes) {
    throw new ThirdPartyAcquisitionError("body_invalid", "Third-party source returned invalid or oversized bytes");
  }
  const sourceContentHash = createHash("sha256").update(result.rawBody).digest("hex");
  if (result.contentHash && result.contentHash !== sourceContentHash) {
    throw new ThirdPartyAcquisitionError("hash_mismatch", "Third-party source content hash mismatch");
  }
  // A durable job retry must reproduce the same capture identity even when a
  // provider reports a new wall-clock retrieval timestamp for the repeated
  // GET. Production callers therefore pin this field to attemptStartedAt.
  const retrievedAt = canonicalRetrievedAt(
    options.retrievedAt ?? result.retrievedAt,
    options.retrievedAt === undefined ? "Third-party response retrieval" : "Durable third-party attempt",
  );
  return Object.freeze({
    source,
    requestedUrl: String(rawUrl),
    finalUrl: result.finalUrl,
    redirects: Object.freeze([...(result.redirects ?? [])]),
    mediaType: String(result.contentType ?? "application/octet-stream").split(";", 1)[0].toLocaleLowerCase(),
    bytes: Buffer.from(result.rawBody),
    sourceContentHash,
    status: result.status,
    retrievedAt,
  });
}

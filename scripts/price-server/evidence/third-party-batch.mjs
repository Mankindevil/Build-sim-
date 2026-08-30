import { acquireThirdPartyEvidence } from "./third-party-acquire.mjs";
import {
  DEFAULT_THIRD_PARTY_REGISTRY,
  resolveThirdPartyRegistry,
  thirdPartyRegistryForUrl,
} from "./third-party-registry.mjs";

export const THIRD_PARTY_BATCH_MAX_SOURCES = 4;

export class ThirdPartyBatchAcquisitionError extends Error {
  constructor(code, message, options = {}) {
    super(String(message).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500));
    this.name = "ThirdPartyBatchAcquisitionError";
    this.code = code;
    this.offline = options.offline === true;
    this.retryable = options.retryable === true;
    this.failedPublisherIds = Object.freeze([...(options.failedPublisherIds ?? [])].sort());
  }
}

function boundedMaximum(value) {
  const maximum = value ?? THIRD_PARTY_BATCH_MAX_SOURCES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > THIRD_PARTY_BATCH_MAX_SOURCES) {
    throw new ThirdPartyBatchAcquisitionError("third_party_batch_invalid", "Third-party batch source limit is invalid");
  }
  return maximum;
}

function candidateUrl(candidate) {
  const raw = typeof candidate === "string" ? candidate : candidate?.url;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 4_096) {
    throw new ThirdPartyBatchAcquisitionError("third_party_batch_invalid", "Third-party batch candidate URL is invalid");
  }
  try {
    return new URL(raw).toString();
  } catch {
    throw new ThirdPartyBatchAcquisitionError("third_party_batch_invalid", "Third-party batch candidate URL is invalid");
  }
}

function selectedCandidates(candidates, registry, maximum) {
  if (!Array.isArray(candidates) || candidates.length > 64) {
    throw new ThirdPartyBatchAcquisitionError("third_party_batch_invalid", "Third-party batch candidates must be a bounded array");
  }
  const byUrl = new Map();
  for (const candidate of candidates) {
    const url = candidateUrl(candidate);
    const source = thirdPartyRegistryForUrl(url, registry);
    if (!source) {
      throw new ThirdPartyBatchAcquisitionError("third_party_batch_source_not_approved", "Third-party batch contains a URL outside the governed registry");
    }
    if (!byUrl.has(url)) byUrl.set(url, Object.freeze({ url, source }));
  }
  const ordered = [...byUrl.values()].sort((left, right) => left.source.publisherId.localeCompare(right.source.publisherId)
    || left.source.independenceGroupId.localeCompare(right.source.independenceGroupId) || left.url.localeCompare(right.url));
  const groups = new Set();
  const output = [];
  for (const candidate of ordered) {
    if (groups.has(candidate.source.independenceGroupId)) continue;
    groups.add(candidate.source.independenceGroupId);
    output.push(candidate);
    if (output.length >= maximum) break;
  }
  return output;
}

function classifyFailure(failures) {
  const offline = failures.some(({ error }) => error?.offline === true
    || /ENETUNREACH|EAI_AGAIN|network is unreachable|offline/i.test(String(error?.message ?? error)));
  const failedPublisherIds = failures.map(({ candidate }) => candidate.source.publisherId);
  return new ThirdPartyBatchAcquisitionError(
    offline ? "third_party_batch_offline" : "third_party_batch_failed",
    offline
      ? "Third-party evidence batch is offline; no acquisition was released for persistence"
      : "Third-party evidence batch failed validation; no acquisition was released for persistence",
    {
      offline,
      retryable: offline || failures.some(({ error }) => error?.retryable === true),
      failedPublisherIds,
    },
  );
}

/**
 * Fetch and validate the entire approved batch before returning any bytes to
 * the caller. This function has no artifact/capture repository dependency, so
 * a rejected or offline batch cannot create a partial local archive. The
 * caller may persist only after this promise resolves successfully.
 */
export async function acquireThirdPartyEvidenceBatch(candidates, options = {}) {
  const registry = resolveThirdPartyRegistry(options.registry ?? DEFAULT_THIRD_PARTY_REGISTRY);
  const selected = selectedCandidates(candidates, registry, boundedMaximum(options.maxSources));
  if (!selected.length) return Object.freeze([]);
  const settled = await Promise.allSettled(selected.map(async (candidate) => {
    if (options.beforeAcquire) await options.beforeAcquire(Object.freeze({ url: candidate.url, source: candidate.source }));
    return acquireThirdPartyEvidence(candidate.url, {
      registry,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
      ...(options.retrievedAt === undefined ? {} : { retrievedAt: options.retrievedAt }),
    });
  }));
  const failures = settled.flatMap((result, index) => result.status === "rejected"
    ? [{ candidate: selected[index], error: result.reason }] : []);
  if (failures.length) throw classifyFailure(failures);

  const acquisitions = settled.map((result) => result.value);
  const seenFinalUrls = new Set();
  const seenContentHashes = new Set();
  const output = [];
  for (const acquisition of acquisitions) {
    if (seenFinalUrls.has(acquisition.finalUrl) || seenContentHashes.has(acquisition.sourceContentHash)) continue;
    seenFinalUrls.add(acquisition.finalUrl);
    seenContentHashes.add(acquisition.sourceContentHash);
    output.push(acquisition);
  }
  return Object.freeze(output);
}

/** Constructor-compatible server-only seam. */
export function createThirdPartyEvidenceBatchAcquirer(options = {}) {
  const frozenOptions = Object.freeze({ ...options });
  return async (candidates, overrides = {}) => acquireThirdPartyEvidenceBatch(candidates, { ...frozenOptions, ...overrides });
}

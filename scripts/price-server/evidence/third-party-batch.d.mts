import type { ThirdPartyRegistrySource } from "./third-party-registry.mjs";

export const THIRD_PARTY_BATCH_MAX_SOURCES: 4;

export interface ThirdPartyAcquisitionResult {
  readonly source: ThirdPartyRegistrySource;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly redirects: readonly string[];
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly sourceContentHash: string;
  readonly status: number;
  readonly retrievedAt: string;
}

export interface ThirdPartyBatchOptions {
  readonly registry?: unknown;
  readonly maxSources?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Durable attempt timestamp used to keep repeated GET capture identity stable. */
  readonly retrievedAt?: string;
  readonly fetcher?: (url: string, options: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly beforeAcquire?: (input: Readonly<{ url: string; source: ThirdPartyRegistrySource }>) => void | Promise<void>;
}

export class ThirdPartyBatchAcquisitionError extends Error {
  readonly code: "third_party_batch_invalid" | "third_party_batch_source_not_approved" | "third_party_batch_offline" | "third_party_batch_failed";
  readonly offline: boolean;
  readonly retryable: boolean;
  readonly failedPublisherIds: readonly string[];
}

export function acquireThirdPartyEvidenceBatch(
  candidates: readonly (string | { readonly url: string })[],
  options?: ThirdPartyBatchOptions,
): Promise<readonly ThirdPartyAcquisitionResult[]>;

export function createThirdPartyEvidenceBatchAcquirer(options?: ThirdPartyBatchOptions): (
  candidates: readonly (string | { readonly url: string })[],
  overrides?: ThirdPartyBatchOptions,
) => Promise<readonly ThirdPartyAcquisitionResult[]>;

import type { EvidencePipelineSubject } from "../../../src/evidence/jobs/contracts";
import type { ThirdPartyRegistry, ThirdPartyRegistrySourceType } from "./third-party-registry.mjs";

export const THIRD_PARTY_DISCOVERY_SCHEMA_VERSION: "third-party-discovery-v1";

export interface ThirdPartyDiscoveryRequest {
  readonly subject: EvidencePipelineSubject;
}

export interface ExactThirdPartySearchQuery {
  readonly raw: string;
  readonly mpn: string;
  readonly brand: string;
  readonly model: string;
  readonly tokens: readonly string[];
  readonly locale: "en-US";
}

export interface ThirdPartyDiscoveryCandidate {
  readonly schemaVersion: typeof THIRD_PARTY_DISCOVERY_SCHEMA_VERSION;
  readonly url: string;
  readonly publisherId: string;
  readonly sourceType: ThirdPartyRegistrySourceType;
  readonly independenceGroupId: string;
  readonly provider: "searxng";
  readonly rank: number;
}

export interface ThirdPartyDiscoveryProvider {
  readonly id: "searxng";
  readonly baseUrl: URL | string;
  discover(input: {
    readonly query: ExactThirdPartySearchQuery;
    readonly allowedDomains: readonly string[];
    readonly limit: number;
    readonly signal: AbortSignal;
    readonly registry: ThirdPartyRegistry;
  }): Promise<readonly unknown[]>;
}

export interface ThirdPartyDiscoveryOptions {
  readonly registry?: unknown;
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly provider?: ThirdPartyDiscoveryProvider;
  readonly searxng?: Readonly<Record<string, unknown>>;
}

export class ThirdPartyDiscoveryError extends Error {
  readonly code: string;
  readonly offline: boolean;
  readonly retryable: boolean;
}

export function createExactThirdPartySearchQuery(request: ThirdPartyDiscoveryRequest): ExactThirdPartySearchQuery;
export function discoverThirdPartyEvidenceCandidates(
  input: { readonly request: ThirdPartyDiscoveryRequest; readonly registry?: unknown },
  options?: ThirdPartyDiscoveryOptions,
): Promise<readonly ThirdPartyDiscoveryCandidate[]>;
export function createDefaultThirdPartyDiscovery(options?: ThirdPartyDiscoveryOptions): (
  input: { readonly request: ThirdPartyDiscoveryRequest; readonly registry?: unknown },
) => Promise<readonly ThirdPartyDiscoveryCandidate[]>;
export function thirdPartyDiscoveryQueryHash(request: ThirdPartyDiscoveryRequest): string;

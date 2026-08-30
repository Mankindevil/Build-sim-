export const THIRD_PARTY_REGISTRY_SCHEMA_VERSION: "third-party-registry-v1";
export const THIRD_PARTY_REGISTRY_OVERLAY_KIND: "third_party_source_overlay";

export type ThirdPartyRegistrySourceType = "professional_measurement" | "professional_review" | "technical_database";
export type ThirdPartyEditorialControl = "independent" | "vendor_controlled" | "unknown";
export type ThirdPartyFundingDisclosure = "independent" | "sponsored" | "undisclosed";

export interface ThirdPartyRegistrySource {
  readonly publisherId: string;
  readonly name: string;
  readonly domains: readonly string[];
  readonly sourceType: ThirdPartyRegistrySourceType;
  readonly independenceGroupId: string;
  readonly editorialControl: ThirdPartyEditorialControl;
  readonly fundingDisclosure: ThirdPartyFundingDisclosure;
  readonly enabled: boolean;
  readonly approvedAt: string;
}

export interface ThirdPartyRegistryDocument {
  readonly schemaVersion: typeof THIRD_PARTY_REGISTRY_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly sources: readonly ThirdPartyRegistrySource[];
}

export interface ThirdPartyRegistry extends ThirdPartyRegistryDocument {
  readonly version: string;
}

export interface ThirdPartyRegistryOverlay {
  readonly schemaVersion: typeof THIRD_PARTY_REGISTRY_SCHEMA_VERSION;
  readonly overlayKind: typeof THIRD_PARTY_REGISTRY_OVERLAY_KIND;
  readonly baseRegistryVersion: string;
  readonly updatedAt: string;
  readonly sources: readonly ThirdPartyRegistrySource[];
}

export const THIRD_PARTY_REGISTRY_SEED_PATH: string;
export const THIRD_PARTY_REGISTRY_SEED: ThirdPartyRegistryDocument;
export const DEFAULT_THIRD_PARTY_REGISTRY: ThirdPartyRegistry;

export function loadThirdPartyRegistry(input?: unknown): ThirdPartyRegistry;
export function thirdPartyRegistryDocument(registry?: unknown): ThirdPartyRegistryDocument;
export function validateThirdPartyRegistryOverlay(value: unknown, options?: { readonly baseRegistryVersion?: string }): string[];
export function mergeThirdPartyRegistry(seedInput?: unknown, overlayInput?: unknown): ThirdPartyRegistry;
export function resolveThirdPartyRegistry(input?: unknown): ThirdPartyRegistry;
export function thirdPartyRegistryForUrl(rawUrl: string | URL, registry?: unknown): ThirdPartyRegistrySource | null;
export function thirdPartyRegistryForPublisher(publisherId: string, registry?: unknown): ThirdPartyRegistrySource | null;
export function thirdPartyFetchRegistry(registry?: unknown): Readonly<{
  schemaVersion: "1.0.0";
  updatedAt: string;
  version: string;
  brands: readonly Readonly<{
    brand: string;
    aliases: readonly string[];
    domains: readonly string[];
    trustStatus: "trusted";
    source: "manual";
    approvedAt: string;
  }>[];
}>;

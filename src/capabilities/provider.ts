import {
  isComponentKindId,
  isFacetId,
  type ComponentKindId,
  type FacetId,
} from "../contracts/registries";
import { validateFactSnapshot, type FactSnapshot } from "../facts/contracts";
import { verifyFactSnapshot } from "../facts/snapshots";
import type { CapabilityFactSnapshotRef, CapabilityRecord } from "./facets";
import { capabilityFactSnapshotRef } from "./facets";
import { validateCapabilityRecord, verifyCapabilityRecord } from "./facets";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isPortableId,
  isUniquePortableIdArray,
  safeRecord,
  sameSnapshotRef,
  validateFactSnapshotRef,
} from "./validation";

export interface CapabilityProviderManifest {
  providerId: string;
  providerVersion: string;
  contractVersion: "capability-provider-v1";
  componentKindIds: ComponentKindId[];
  facetIds: FacetId[];
  replayable: true;
}

export interface CapabilityProviderContext {
  factSnapshot: FactSnapshot;
  componentKindIds: ComponentKindId[];
}

export interface CapabilityProvider {
  readonly manifest: CapabilityProviderManifest;
  provide(context: CapabilityProviderContext): Promise<readonly CapabilityRecord[]>;
}

export function validateCapabilityProviderManifest(value: unknown): string[] {
  try {
    const manifest = safeRecord(value);
    if (!manifest) return ["capability provider manifest must be an object"];
    const errors: string[] = [];
    if (!hasExactKeys(manifest, ["providerId", "providerVersion", "contractVersion", "componentKindIds", "facetIds", "replayable"])) {
      errors.push("capability provider manifest contains unknown or missing fields");
    }
    if (containsNonNfcText(manifest)) errors.push("capability provider manifest contains non-NFC text");
    if (!isPortableId(manifest.providerId) || !isPortableId(manifest.providerVersion)) errors.push("capability provider identity invalid");
    if (manifest.contractVersion !== "capability-provider-v1" || manifest.replayable !== true) errors.push("capability provider contract/replay flag invalid");
    if (!isUniquePortableIdArray(manifest.componentKindIds)
      || manifest.componentKindIds.some((id) => !isComponentKindId(id))) errors.push("capability provider componentKindIds invalid");
    if (!isUniquePortableIdArray(manifest.facetIds)
      || manifest.facetIds.some((id) => !isFacetId(id))) errors.push("capability provider facetIds invalid");
    return errors;
  } catch {
    return ["capability provider manifest is inaccessible or invalid"];
  }
}

export function validateCapabilityProviderContext(value: unknown): string[] {
  try {
    const context = safeRecord(value);
    if (!context) return ["capability provider context must be an object"];
    const errors: string[] = [];
    if (!hasExactKeys(context, ["factSnapshot", "componentKindIds"])) errors.push("capability provider context contains unknown or missing fields");
    try { errors.push(...validateFactSnapshot(context.factSnapshot).map((error) => `capability provider context factSnapshot: ${error}`)); }
    catch { errors.push("capability provider context factSnapshot inaccessible"); }
    if (!isUniquePortableIdArray(context.componentKindIds)
      || context.componentKindIds.some((id) => !isComponentKindId(id))) errors.push("capability provider context componentKindIds invalid");
    return errors;
  } catch {
    return ["capability provider context is inaccessible or invalid"];
  }
}

export interface StaticCapabilityProviderInput {
  providerId: string;
  providerVersion: string;
  componentKindIds: ComponentKindId[];
  facetIds: FacetId[];
  records: CapabilityRecord[];
}

export function createStaticCapabilityProvider(input: StaticCapabilityProviderInput): CapabilityProvider {
  const manifest: CapabilityProviderManifest = deepFreeze({
    providerId: input.providerId.normalize("NFC"),
    providerVersion: input.providerVersion.normalize("NFC"),
    contractVersion: "capability-provider-v1",
    componentKindIds: [...input.componentKindIds].sort(compareCanonical),
    facetIds: [...input.facetIds].sort(compareCanonical),
    replayable: true,
  }) as CapabilityProviderManifest;
  const errors = validateCapabilityProviderManifest(manifest);
  if (errors.length) throw new TypeError(`Invalid capability provider manifest: ${errors.join("; ")}`);
  const records = input.records.map((record) => structuredClone(record));
  return Object.freeze({
    manifest,
    async provide(context: CapabilityProviderContext): Promise<readonly CapabilityRecord[]> {
      const contextErrors = validateCapabilityProviderContext(context);
      if (contextErrors.length) throw new TypeError(`Invalid capability provider context: ${contextErrors.join("; ")}`);
      const snapshotRef = capabilityFactSnapshotRef(context.factSnapshot);
      const selected = records.filter((record) => sameSnapshotRef(record.factSnapshotRef, snapshotRef)
        && context.componentKindIds.includes(record.componentKindId));
      return selected.map((record) => structuredClone(record));
    },
  });
}

export async function validateProviderOutput(
  provider: CapabilityProvider,
  context: CapabilityProviderContext,
  records: readonly CapabilityRecord[],
): Promise<void> {
  const manifestErrors = validateCapabilityProviderManifest(provider.manifest);
  if (manifestErrors.length) throw new TypeError(`Invalid capability provider manifest: ${manifestErrors.join("; ")}`);
  if (!await verifyFactSnapshot(context.factSnapshot)) throw new TypeError("capability provider fact snapshot content hash mismatch");
  const factSnapshotRef = capabilityFactSnapshotRef(context.factSnapshot);
  const snapshotFactIds = new Set(context.factSnapshot.factRefs.map((ref) => ref.factId));
  const keys = new Set<string>();
  for (const record of records) {
    if (validateCapabilityRecord(record).length || !await verifyCapabilityRecord(record)) throw new TypeError("capability provider emitted invalid or corrupt record");
    if (!sameSnapshotRef(record.factSnapshotRef, factSnapshotRef)) throw new TypeError("capability provider crossed fact snapshot authority");
    if (!context.componentKindIds.includes(record.componentKindId)
      || !provider.manifest.componentKindIds.includes(record.componentKindId)) throw new TypeError("capability provider emitted undeclared component kind");
    if (record.facets.some((facet) => !provider.manifest.facetIds.includes(facet.facetId))) throw new TypeError("capability provider emitted undeclared facet");
    if (record.facets.some((facet) => facet.sourceFactIds.some((factId) => !snapshotFactIds.has(factId)))) throw new TypeError("capability provider source fact is outside the exact fact snapshot");
    if (!record.providerRefs.includes(`${provider.manifest.providerId}@${provider.manifest.providerVersion}`)) throw new TypeError("capability record is not bound to emitting provider version");
    const key = `${record.componentKindId}\0${record.subjectSkuId}`;
    if (keys.has(key)) throw new TypeError("capability provider emitted duplicate subject");
    keys.add(key);
  }
}

import { createCapabilityRecord, type CapabilityRecord } from "./facets";
import type { CapabilityProvider, CapabilityProviderContext } from "./provider";
import { validateCapabilityProviderContext, validateCapabilityProviderManifest, validateProviderOutput } from "./provider";
import { compareCanonical } from "./validation";

export class CapabilityProviderRegistry {
  private readonly providers = new Map<string, CapabilityProvider>();

  constructor(providers: readonly CapabilityProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: CapabilityProvider): void {
    const errors = validateCapabilityProviderManifest(provider.manifest);
    if (errors.length) throw new TypeError(`Invalid capability provider manifest: ${errors.join("; ")}`);
    if (this.providers.has(provider.manifest.providerId)) throw new Error(`capability provider already registered: ${provider.manifest.providerId}`);
    this.providers.set(provider.manifest.providerId, provider);
  }

  manifests() {
    return [...this.providers.values()]
      .map(({ manifest }) => structuredClone(manifest))
      .sort((left, right) => compareCanonical(left.providerId, right.providerId));
  }

  async resolve(context: CapabilityProviderContext): Promise<CapabilityRecord[]> {
    const errors = validateCapabilityProviderContext(context);
    if (errors.length) throw new TypeError(`Invalid capability provider context: ${errors.join("; ")}`);
    const result = new Map<string, CapabilityRecord>();
    const providers = [...this.providers.values()].sort((left, right) => compareCanonical(left.manifest.providerId, right.manifest.providerId));
    for (const provider of providers) {
      if (!provider.manifest.componentKindIds.some((kind) => context.componentKindIds.includes(kind))) continue;
      const records = await provider.provide(structuredClone(context));
      await validateProviderOutput(provider, context, records);
      for (const record of records) {
        const key = `${record.componentKindId}\0${record.subjectSkuId}`;
        const existing = result.get(key);
        if (!existing) {
          result.set(key, structuredClone(record));
          continue;
        }
        const existingFacetIds = new Set(existing.facets.map((facet) => facet.facetId));
        const duplicateFacet = record.facets.find((facet) => existingFacetIds.has(facet.facetId));
        if (duplicateFacet) throw new Error(`multiple capability providers emitted facet ${duplicateFacet.facetId} for subject ${record.subjectSkuId}`);
        result.set(key, await createCapabilityRecord({
          schemaVersion: "capability-record-v1",
          subjectSkuId: record.subjectSkuId,
          componentKindId: record.componentKindId,
          factSnapshotRef: record.factSnapshotRef,
          facets: [...existing.facets, ...record.facets],
          providerRefs: [...new Set([...existing.providerRefs, ...record.providerRefs])],
        }));
      }
    }
    return [...result.values()].sort((left, right) => compareCanonical(`${left.componentKindId}\0${left.subjectSkuId}`, `${right.componentKindId}\0${right.subjectSkuId}`));
  }
}

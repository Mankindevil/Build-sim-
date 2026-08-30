import { COMPONENT_KIND_REGISTRY, FACET_REGISTRY } from "../contracts/registries";
import { createStaticCapabilityProvider, type CapabilityProviderManifest } from "./provider";
import { CapabilityProviderRegistry } from "./registry";

/**
 * The production capability provider is deliberately data-only today: it
 * declares the exact governed vocabulary consumed by the generic evaluator,
 * while capability records remain bound to the evaluation FactSnapshot.
 * Keeping it as a real provider instance (rather than a version string) makes
 * the manifest available to the artifact authority and future providers can be
 * added without changing the lockfile contract.
 */
export function createBuiltinCapabilityProviderRegistry(): CapabilityProviderRegistry {
  return new CapabilityProviderRegistry([createStaticCapabilityProvider({
    providerId: "buildsim.fact-capability-provider",
    providerVersion: "1.0.0",
    componentKindIds: Object.keys(COMPONENT_KIND_REGISTRY) as Array<keyof typeof COMPONENT_KIND_REGISTRY>,
    facetIds: Object.keys(FACET_REGISTRY) as Array<keyof typeof FACET_REGISTRY>,
    records: [],
  })]);
}

export function builtinCapabilityProviderManifests(): CapabilityProviderManifest[] {
  return createBuiltinCapabilityProviderRegistry().manifests();
}

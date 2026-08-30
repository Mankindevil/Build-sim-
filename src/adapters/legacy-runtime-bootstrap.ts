import type { BuildConfig } from "../config/types";
import type { SkuCatalog } from "../sku/types";
import { CaseRuntimeAdapterRegistry, DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY } from "./runtime";
import {
  N6_CASE_RUNTIME_ADAPTER,
  planN6PanelWiring,
} from "./jonsbo-n6/assembly";

/**
 * Deliberate V2 rollback/composition seam. Generic core never imports this
 * module; concrete application entrypoints opt into the bundled legacy case.
 */
export function bootstrapLegacyCaseRuntime(): void {
  registerLegacyV2CaseRuntimeAdapter();
}

export function createLegacyV2CaseRuntimeRegistry(): CaseRuntimeAdapterRegistry {
  return CaseRuntimeAdapterRegistry.create([N6_CASE_RUNTIME_ADAPTER]);
}

/** Explicit flag-off application composition; generic modules never import it. */
export function registerLegacyV2CaseRuntimeAdapter(
  registry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
): CaseRuntimeAdapterRegistry {
  const existing = registry.resolveExact(N6_CASE_RUNTIME_ADAPTER.identity);
  if (!existing) registry.register(N6_CASE_RUNTIME_ADAPTER);
  else if (existing.adapterId !== N6_CASE_RUNTIME_ADAPTER.adapterId
    || existing.adapterVersion !== N6_CASE_RUNTIME_ADAPTER.adapterVersion
    || existing.identity.manifestHash !== N6_CASE_RUNTIME_ADAPTER.identity.manifestHash
    || existing.identity.projectionHash !== N6_CASE_RUNTIME_ADAPTER.identity.projectionHash) {
    throw new Error("legacy case runtime adapter bootstrap identity conflict");
  }
  return registry;
}

export function planLegacyPanelWiring(config: BuildConfig, catalog: SkuCatalog) {
  return planN6PanelWiring(config, catalog);
}

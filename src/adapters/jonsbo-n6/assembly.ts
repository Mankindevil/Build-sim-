import adapterSeed from "../../../data/cases/jonsbo-n6/adapter.json";
import profile from "../../../data/cases/jonsbo-n6/profile.json";
import geometry from "../../../data/cases/jonsbo-n6/geometry.json";
import routing from "../../../data/cases/jonsbo-n6/routing.json";
import assembly from "../../../data/cases/jonsbo-n6/assembly.json";
import calibration from "../../../data/cases/jonsbo-n6/calibration.json";
import type { BuildConfig } from "../../config/types";
import type { PlacedPart } from "../../core/geometry";
import type { RoutedCable } from "../../core/routing";
import type { SkuCatalog } from "../../sku/types";
import {
  DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
  type CaseRuntimeAdapterRegistry,
} from "../runtime";
import type { CaseAdapterManifest } from "../contracts";
import type { CaseRuntimeModel, CaseRuntimeModelInput } from "../runtime-model";
import { createDeclarativeCaseRuntime } from "../declarative-case/runtime";

function legacyRuntimeModelInput(manifest: CaseAdapterManifest): CaseRuntimeModelInput {
  return {
    schemaVersion: "case-runtime-model-v1",
    runtimeId: "runtime.case.jonsbo-n6",
    runtimeVersion: "1.0.0",
    interpreterId: "declarative-case-v1",
    authorityStatus: "legacy_unverified",
    authorityRefs: { factIds: [], derivationIds: [], evidenceContentHashes: [] },
    identity: { ...manifest.identity },
    manifestHash: manifest.contentHash,
    documents: {
      profile: structuredClone(profile), geometry: structuredClone(geometry), routing: structuredClone(routing),
      assembly: structuredClone(assembly), calibration: structuredClone(calibration),
    },
    sourceRefs: [
      "data/cases/jonsbo-n6/profile.json", "data/cases/jonsbo-n6/geometry.json",
      "data/cases/jonsbo-n6/routing.json", "data/cases/jonsbo-n6/assembly.json",
      "data/cases/jonsbo-n6/calibration.json",
    ],
  };
}

const MANIFEST_HASH = "197b755a467ee0b1584790929bd435910e22cdf0ffbd2be45d729da20a1b3069";
const PROJECTION_HASH = "4670e52ef781ef4b0214a7233b80b60acb65d77d38c24db7fab1064d1e844788";
const manifest = {
  ...structuredClone(adapterSeed.manifest),
  contentHash: MANIFEST_HASH,
} as unknown as CaseAdapterManifest;
const legacyModel = {
  ...legacyRuntimeModelInput(manifest),
  // The flag-off seam is never persisted or admitted as artifact authority.
  contentHash: "0".repeat(64),
} as CaseRuntimeModel;
const runtime = createDeclarativeCaseRuntime(manifest, legacyModel, PROJECTION_HASH);

/** Explicit flag-off rollback composition; importing this module mutates nothing. */
export const N6_CASE_RUNTIME_ADAPTER = runtime.adapter;
export const N6_WIRING_PROFILE = runtime.wiringProfile;
export const buildN6Assembly = (parts: PlacedPart[], cables: RoutedCable[]) => runtime.buildAssembly(parts, cables);
export const checkN6BackplaneHarness = (config: BuildConfig, catalog: SkuCatalog) => runtime.checkBackplaneHarness(config, catalog);
export const planN6Wiring = (config: BuildConfig, catalog: SkuCatalog) => runtime.planWiring(config, catalog);
export const planN6PanelWiring = (config: BuildConfig, catalog: SkuCatalog) => runtime.planPanelWiring(config, catalog);

export function registerN6CaseRuntimeAdapter(
  registry: CaseRuntimeAdapterRegistry = DEFAULT_CASE_RUNTIME_ADAPTER_REGISTRY,
): void {
  if (!registry.resolveExact(N6_CASE_RUNTIME_ADAPTER.identity)) registry.register(N6_CASE_RUNTIME_ADAPTER);
}

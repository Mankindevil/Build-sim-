import {
  canonicalize,
  createLockedArtifactRef,
  hashContent,
  sha256Hex,
  verifyContentAddressedRef,
  type LockedArtifactRef,
} from "../hash";
import {
  compareCanonical,
  deepFreeze,
  hasExactKeys,
  isPortableId,
  isSha256,
  safeRecord,
} from "../capabilities/validation";
import {
  validateCapabilityProviderManifest,
  type CapabilityProviderManifest,
} from "../capabilities/provider";
import {
  createCaseAdapterManifest,
  validateCaseAdapterManifest,
  verifyCaseAdapterManifest,
  type CaseAdapterIdentity,
  type CaseAdapterManifest,
  type CaseAdapterSeed,
} from "./contracts";
import {
  hydrateRuntimeCaseAdapterRegistryArtifactRuntime,
  validateRuntimeCaseAdapterRegistryRuntime,
} from "./provisional-runtime.mjs";
import {
  caseRuntimeModelCanonicalBytes,
  verifyCaseRuntimeModel,
  type CaseRuntimeModel,
} from "./runtime-model";

export type CaseAdapterLookupIdentity = Pick<CaseAdapterIdentity, "skuId" | "region" | "revision">;

export interface AdapterArtifactSource {
  moduleId: string;
  bytes: string;
}

export interface CaseAdapterRuntimeIdentity {
  adapterId: string;
  adapterVersion: string;
  manifestHash: string;
  executionStatus: "ready" | "partial";
  runtimeId: string | null;
  runtimeVersion: string | null;
  interpreterId: "declarative-case-v1" | null;
  modelHash: string | null;
  modelSourceModuleId: string | null;
  authorityStatus: CaseRuntimeModel["authorityStatus"] | null;
  interpreterImplementationHash: string | null;
  partialReason: "runtime-model-unavailable" | null;
  implementationModuleIds: string[];
}

export interface RuntimeCaseAdapterRegistryBinding {
  schemaVersion: "runtime-case-adapter-registry-binding-v2";
  registryRef: `sha256:${string}` | null;
  activeRuntimeGeneration: number;
  registrySourceRuntimeGeneration: number | null;
  registryGeneration: number;
  manifestHashes: string[];
  sourceModuleId: typeof RUNTIME_CASE_ADAPTER_REGISTRY_MODULE_ID;
}

export interface RuntimeCaseAdapterRegistrySnapshotInput {
  registryRef: `sha256:${string}` | null;
  /** Exact immutable FileArtifactRepository bytes. */
  registryBytes: string | null;
  activeRuntimeGeneration: number;
  registrySourceRuntimeGeneration: number | null;
  registryGeneration: number;
  manifests: readonly CaseAdapterManifest[];
}

export interface CapabilityProviderRuntimeIdentity {
  providerId: string;
  providerVersion: string;
  implementationModuleIds: string[];
}

export interface CaseAdapterArtifactPayload {
  schemaVersion: "workspace-adapter-snapshot-v1";
  catalog: {
    schemaVersion: "case-adapter-identity-catalog-v1";
    skus: Array<{ id: string; category: "case"; name: string }>;
  };
  caseManifests: CaseAdapterManifest[];
  runtimeModels: CaseRuntimeModel[];
  runtimeAdapters: CaseAdapterRuntimeIdentity[];
  capabilityProviderManifests: CapabilityProviderManifest[];
  capabilityProviderRuntimes: CapabilityProviderRuntimeIdentity[];
  runtimeRegistry: RuntimeCaseAdapterRegistryBinding;
  sources: AdapterArtifactSource[];
}

export interface CaseAdapterArtifact {
  payload: CaseAdapterArtifactPayload;
  ref: LockedArtifactRef;
  snapshotHash: string;
}

export interface CreateCaseAdapterArtifactOptions {
  catalog?: CaseAdapterArtifactPayload["catalog"];
  capabilityProviderManifests?: readonly CapabilityProviderManifest[];
  sources?: readonly AdapterArtifactSource[];
  adapterImplementationModuleIds?: readonly string[];
  capabilityProviderImplementationModuleIds?: readonly string[];
  runtimeRegistry?: RuntimeCaseAdapterRegistrySnapshotInput;
  runtimeModels?: readonly CaseRuntimeModel[];
}

export const CASE_ADAPTER_REGISTRY_MODULE_ID = "adapters/registry";
export const CASE_RUNTIME_COMPILER_MODULE_ID = "adapters/runtime-compiler";
export const DECLARATIVE_CASE_INTERPRETER_MODULE_ID = "adapters/declarative-case/runtime";
export const CAPABILITY_PROVIDER_MODULE_ID = "capabilities/provider";
export const CAPABILITY_PROVIDER_REGISTRY_MODULE_ID = "capabilities/registry";
export const CASE_ADAPTER_MANIFEST_REGISTRATION_MODULE_ID = "adapters/manifest-registration.json";
export const CAPABILITY_PROVIDER_REGISTRATION_MODULE_ID = "capabilities/provider-registration.json";
export const ADAPTER_CATALOG_REGISTRATION_MODULE_ID = "adapters/catalog-registration.json";
export const RUNTIME_CASE_ADAPTER_REGISTRY_MODULE_ID = "adapters/runtime-case-adapter-registry.json";
export const CASE_RUNTIME_MODEL_REGISTRATION_MODULE_ID = "adapters/runtime-model-registration.json";
export const CASE_RUNTIME_MODEL_SOURCE_PREFIX = "adapters/runtime-model";

const ARTIFACT_CONTRACT = Object.freeze({ domain: "artifact.adapter-snapshot", schemaVersion: "1.0.0" } as const);
const ARTIFACT_MEDIA = "application/vnd.buildsim.adapter-snapshot+json";
const bundledCaseSeedModules = import.meta.glob("../../data/cases/*/adapter.json", {
  eager: true,
  import: "default",
}) as Record<string, CaseAdapterSeed>;

function identityKey(identity: CaseAdapterLookupIdentity): string {
  if (![identity.skuId, identity.region, identity.revision].every(isPortableId)) throw new TypeError("case adapter lookup identity invalid");
  return `${identity.skuId}\0${identity.region}\0${identity.revision}`;
}

function runtimeKey(adapterId: string, adapterVersion: string, manifestHash: string): string {
  return `${adapterId}\0${adapterVersion}\0${manifestHash}`;
}

function providerKey(providerId: string, providerVersion: string): string {
  return `${providerId}\0${providerVersion}`;
}

function runtimeModelSourceModuleId(modelHash: string): string {
  if (!isSha256(modelHash)) throw new TypeError("case runtime model content hash invalid");
  return `${CASE_RUNTIME_MODEL_SOURCE_PREFIX}/${modelHash}.json`;
}

async function interpreterImplementationClosureHash(
  interpreterId: "declarative-case-v1",
  implementationModuleIds: readonly string[],
  sources: readonly AdapterArtifactSource[],
): Promise<string> {
  const byId = new Map(sources.map((source) => [source.moduleId, source.bytes]));
  const implementationSources = [...implementationModuleIds].sort(compareCanonical).map((moduleId) => {
    const bytes = byId.get(moduleId);
    if (bytes === undefined) throw new TypeError(`case runtime interpreter source is unavailable: ${moduleId}`);
    return { moduleId, bytes };
  });
  return hashContent({ interpreterId, implementationSources }, ARTIFACT_CONTRACT);
}

function defaultProviderManifest(manifests: readonly CaseAdapterManifest[]): CapabilityProviderManifest {
  return {
    providerId: "buildsim.case-adapter-capability-provider",
    providerVersion: "1.0.0",
    contractVersion: "capability-provider-v1",
    componentKindIds: ["case"],
    facetIds: [...new Set(manifests.flatMap((manifest) => manifest.capabilityBindings.map((binding) => binding.facetId)))].sort(compareCanonical),
    replayable: true,
  };
}

function normalizedSources(input: readonly AdapterArtifactSource[]): AdapterArtifactSource[] {
  const sources = input.map((source) => ({ moduleId: source.moduleId.normalize("NFC"), bytes: source.bytes }))
    .sort((left, right) => compareCanonical(left.moduleId, right.moduleId));
  if (!sources.length || sources.some((source) => !isPortableId(source.moduleId) || !source.bytes)
    || new Set(sources.map((source) => source.moduleId)).size !== sources.length) {
    throw new TypeError("case adapter artifact sources invalid or duplicated");
  }
  return sources;
}

function fallbackSources(): AdapterArtifactSource[] {
  return [
    { moduleId: CASE_ADAPTER_REGISTRY_MODULE_ID, bytes: "case-adapter-registry-v1" },
    { moduleId: CASE_RUNTIME_COMPILER_MODULE_ID, bytes: "case-runtime-compiler-v1" },
    { moduleId: DECLARATIVE_CASE_INTERPRETER_MODULE_ID, bytes: "declarative-case-interpreter-v1" },
    { moduleId: CAPABILITY_PROVIDER_MODULE_ID, bytes: "capability-provider-runtime-v1" },
    { moduleId: CAPABILITY_PROVIDER_REGISTRY_MODULE_ID, bytes: "capability-provider-registry-v1" },
  ];
}

function exactPortableIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPortableId) && new Set(value).size === value.length;
}

async function normalizedRuntimeModels(
  manifests: readonly CaseAdapterManifest[],
  input: readonly CaseRuntimeModel[],
): Promise<CaseRuntimeModel[]> {
  const manifestsByHash = new Map(manifests.map((manifest) => [manifest.contentHash, manifest]));
  const models = input.map((model) => structuredClone(model))
    .sort((left, right) => compareCanonical(left.manifestHash, right.manifestHash));
  if (new Set(models.map((model) => model.manifestHash)).size !== models.length) {
    throw new TypeError("case runtime models duplicate a manifest binding");
  }
  for (const model of models) {
    const manifest = manifestsByHash.get(model.manifestHash);
    // Aggregate fact sets do not prove which fact/derivation owns each model
    // field. Until a field-path binding schema exists, governed status must
    // fail closed instead of promoting arbitrary executable bytes.
    if (model.authorityStatus !== "legacy_unverified"
      || !manifest || !await verifyCaseRuntimeModel(manifest, model)) {
      throw new TypeError("case runtime model/manifest closure invalid");
    }
  }
  return models;
}

function verifyRuntimeModelDataSourceClosure(
  model: CaseRuntimeModel,
  sources: readonly AdapterArtifactSource[],
): boolean {
  const byId = new Map(sources.map((source) => [source.moduleId, source.bytes]));
  const expectedDocumentNames = ["profile", "geometry", "routing", "assembly", "calibration"] as const;
  if (model.sourceRefs.length !== expectedDocumentNames.length + 1
    || model.sourceRefs.some((ref) => !byId.has(ref))) return false;
  const registrations = model.sourceRefs.filter((ref) => ref.endsWith("/runtime-model.json"));
  if (registrations.length !== 1) return false;
  let registration: unknown;
  try { registration = JSON.parse(byId.get(registrations[0]!)!); }
  catch { return false; }
  const record = safeRecord(registration);
  if (!record || !hasExactKeys(record, [
    "schemaVersion", "runtimeId", "runtimeVersion", "interpreterId", "authorityStatus",
    "authorityRefs", "identity", "documents",
  ]) || record.schemaVersion !== "case-runtime-model-data-seed-v1"
    || record.runtimeId !== model.runtimeId || record.runtimeVersion !== model.runtimeVersion
    || record.interpreterId !== model.interpreterId || record.authorityStatus !== model.authorityStatus
    || canonicalize(record.authorityRefs) !== canonicalize(model.authorityRefs)
    || canonicalize(record.identity) !== canonicalize(model.identity)) return false;
  const documentRefs = safeRecord(record.documents);
  if (!documentRefs || !hasExactKeys(documentRefs, expectedDocumentNames)) return false;
  const unsortedSourceRefs = [registrations[0]!, ...expectedDocumentNames.map((name) => documentRefs[name])];
  if (unsortedSourceRefs.some((ref) => !isPortableId(ref))) return false;
  const expectedSourceRefs = (unsortedSourceRefs as string[]).sort(compareCanonical);
  if (expectedSourceRefs.some((ref) => !isPortableId(ref))
    || canonicalize(expectedSourceRefs) !== canonicalize(model.sourceRefs)) return false;
  for (const name of expectedDocumentNames) {
    const ref = documentRefs[name] as string;
    let document: unknown;
    try { document = JSON.parse(byId.get(ref)!); }
    catch { return false; }
    if (canonicalize(document) !== canonicalize(model.documents[name])) return false;
  }
  return true;
}

function validCatalog(value: unknown, manifestSkuIds: ReadonlySet<string>): boolean {
  const catalog = safeRecord(value);
  // This is deliberately an identity-only projection. Product dimensions,
  // prices, and compatibility attributes remain owned by their own locked
  // authorities and cannot hitchhike into an adapter snapshot.
  if (!catalog || !hasExactKeys(catalog, ["schemaVersion", "skus"])
    || catalog.schemaVersion !== "case-adapter-identity-catalog-v1" || !Array.isArray(catalog.skus)) return false;
  const skuIds = new Set<string>();
  for (const candidate of catalog.skus) {
    const sku = safeRecord(candidate);
    if (!sku || !hasExactKeys(sku, ["id", "category", "name"])
      || !isPortableId(sku.id) || sku.category !== "case" || sku.name !== sku.id || skuIds.has(sku.id)) return false;
    skuIds.add(sku.id);
  }
  return skuIds.size === manifestSkuIds.size && [...manifestSkuIds].every((skuId) => skuIds.has(skuId));
}

function parsedRegistration(sources: readonly (Record<string, unknown> | null)[], moduleId: string): unknown | null {
  const source = sources.find((candidate) => candidate?.moduleId === moduleId);
  if (!source || typeof source.bytes !== "string") return null;
  try { return JSON.parse(source.bytes); }
  catch { return null; }
}

function runtimeRegistryMarker(binding: Omit<RuntimeCaseAdapterRegistryBinding, "sourceModuleId">): string {
  return canonicalize({ domain: "buildsim.runtime-case-adapter-registry-binding-v2", binding });
}

function normalizedRuntimeRegistry(
  input: RuntimeCaseAdapterRegistrySnapshotInput | undefined,
): { binding: RuntimeCaseAdapterRegistryBinding; bytes: string } {
  const registryRef = input?.registryRef ?? null;
  const registryBytes = input?.registryBytes ?? null;
  const activeRuntimeGeneration = input?.activeRuntimeGeneration ?? 1;
  const registrySourceRuntimeGeneration = input?.registrySourceRuntimeGeneration ?? null;
  const registryGeneration = input?.registryGeneration ?? 0;
  const manifestHashes = [...(input?.manifests ?? [])].map((manifest) => manifest.contentHash).sort(compareCanonical);
  if (!Number.isSafeInteger(activeRuntimeGeneration) || activeRuntimeGeneration < 1
    || (registrySourceRuntimeGeneration !== null && (!Number.isSafeInteger(registrySourceRuntimeGeneration)
      || registrySourceRuntimeGeneration < 1 || registrySourceRuntimeGeneration > activeRuntimeGeneration))
    || !Number.isSafeInteger(registryGeneration) || registryGeneration < 0
    || new Set(manifestHashes).size !== manifestHashes.length
    || manifestHashes.some((hash) => !isSha256(hash))) {
    throw new TypeError("runtime case adapter registry binding invalid");
  }
  if ((registryRef === null) !== (registryBytes === null)
    || (registryRef === null && (registrySourceRuntimeGeneration !== null
      || registryGeneration !== 0 || manifestHashes.length !== 0))
    || (registryRef !== null && (!/^sha256:[a-f0-9]{64}$/.test(registryRef)
      || !registryBytes || registrySourceRuntimeGeneration === null
      || registryGeneration <= 0 || manifestHashes.length === 0))) {
    throw new TypeError("runtime case adapter registry ref/bytes/generation closure invalid");
  }
  const binding: RuntimeCaseAdapterRegistryBinding = {
    schemaVersion: "runtime-case-adapter-registry-binding-v2",
    registryRef,
    activeRuntimeGeneration,
    registrySourceRuntimeGeneration,
    registryGeneration,
    manifestHashes,
    sourceModuleId: RUNTIME_CASE_ADAPTER_REGISTRY_MODULE_ID,
  };
  return {
    binding,
    bytes: registryBytes ?? runtimeRegistryMarker({
      schemaVersion: binding.schemaVersion,
      registryRef: binding.registryRef,
      activeRuntimeGeneration: binding.activeRuntimeGeneration,
      registrySourceRuntimeGeneration: binding.registrySourceRuntimeGeneration,
      registryGeneration: binding.registryGeneration,
      manifestHashes: binding.manifestHashes,
    }),
  };
}

async function verifyRuntimeRegistryClosure(
  value: unknown,
  sources: readonly (Record<string, unknown> | null)[],
  manifests: readonly CaseAdapterManifest[],
): Promise<boolean> {
  const binding = safeRecord(value);
  if (!binding || !hasExactKeys(binding, [
    "schemaVersion", "registryRef", "activeRuntimeGeneration", "registrySourceRuntimeGeneration",
    "registryGeneration", "manifestHashes", "sourceModuleId",
  ]) || binding.schemaVersion !== "runtime-case-adapter-registry-binding-v2"
    || binding.sourceModuleId !== RUNTIME_CASE_ADAPTER_REGISTRY_MODULE_ID
    || !Number.isSafeInteger(binding.activeRuntimeGeneration) || Number(binding.activeRuntimeGeneration) < 1
    || (binding.registrySourceRuntimeGeneration !== null
      && (!Number.isSafeInteger(binding.registrySourceRuntimeGeneration)
        || Number(binding.registrySourceRuntimeGeneration) < 1
        || Number(binding.registrySourceRuntimeGeneration) > Number(binding.activeRuntimeGeneration)))
    || !Number.isSafeInteger(binding.registryGeneration) || Number(binding.registryGeneration) < 0
    || !Array.isArray(binding.manifestHashes)
    || binding.manifestHashes.some((hash) => !isSha256(hash))
    || new Set(binding.manifestHashes).size !== binding.manifestHashes.length
    || canonicalize(binding.manifestHashes) !== canonicalize([...(binding.manifestHashes as string[])].sort(compareCanonical))) return false;
  const source = sources.find((candidate) => candidate?.moduleId === RUNTIME_CASE_ADAPTER_REGISTRY_MODULE_ID);
  if (!source || typeof source.bytes !== "string" || !source.bytes) return false;
  const registryRef = binding.registryRef;
  if (registryRef === null) {
    if (binding.registrySourceRuntimeGeneration !== null
      || binding.registryGeneration !== 0 || binding.manifestHashes.length !== 0) return false;
    return source.bytes === runtimeRegistryMarker({
      schemaVersion: "runtime-case-adapter-registry-binding-v2",
      registryRef: null,
      activeRuntimeGeneration: Number(binding.activeRuntimeGeneration),
      registrySourceRuntimeGeneration: null,
      registryGeneration: 0,
      manifestHashes: [],
    });
  }
  if (typeof registryRef !== "string" || !/^sha256:[a-f0-9]{64}$/.test(registryRef)
    || binding.registrySourceRuntimeGeneration === null || binding.registryGeneration === 0
    || binding.manifestHashes.length === 0
    || await sha256Hex(source.bytes) !== registryRef.slice("sha256:".length)) return false;
  let material: unknown;
  try { material = JSON.parse(source.bytes); }
  catch { return false; }
  const hydrated = hydrateRuntimeCaseAdapterRegistryArtifactRuntime(material, registryRef);
  if (!hydrated || validateRuntimeCaseAdapterRegistryRuntime(hydrated).length) return false;
  const registry = safeRecord(hydrated);
  if (!registry || registry.runtimeGeneration !== binding.registrySourceRuntimeGeneration
    || registry.registryGeneration !== binding.registryGeneration
    || !Array.isArray(registry.entries)) return false;
  const lockedByHash = new Map(manifests.map((manifest) => [manifest.contentHash, manifest]));
  const entryHashes: string[] = [];
  for (const candidate of registry.entries) {
    const entry = safeRecord(candidate);
    const manifest = entry?.manifest as CaseAdapterManifest | undefined;
    if (!entry || !manifest || entry.manifestHash !== manifest.contentHash || !isSha256(entry.manifestHash)
      || !await verifyCaseAdapterManifest(manifest)
      || canonicalize(lockedByHash.get(manifest.contentHash)) !== canonicalize(manifest)) return false;
    entryHashes.push(manifest.contentHash);
  }
  return new Set(entryHashes).size === entryHashes.length
    && canonicalize(entryHashes.sort(compareCanonical)) === canonicalize(binding.manifestHashes);
}

export async function verifyCaseAdapterSnapshotPayload(value: unknown): Promise<boolean> {
  try {
    const payload = safeRecord(value);
    if (!payload || !hasExactKeys(payload, [
      "schemaVersion", "catalog", "caseManifests", "runtimeModels", "runtimeAdapters", "capabilityProviderManifests",
      "capabilityProviderRuntimes", "runtimeRegistry", "sources",
    ]) || payload.schemaVersion !== "workspace-adapter-snapshot-v1"
      || !Array.isArray(payload.caseManifests) || payload.caseManifests.length === 0
      || !Array.isArray(payload.runtimeModels)
      || !Array.isArray(payload.runtimeAdapters) || payload.runtimeAdapters.length !== payload.caseManifests.length
      || !Array.isArray(payload.capabilityProviderManifests) || payload.capabilityProviderManifests.length === 0
      || !Array.isArray(payload.capabilityProviderRuntimes)
      || payload.capabilityProviderRuntimes.length !== payload.capabilityProviderManifests.length
      || !Array.isArray(payload.sources) || payload.sources.length === 0) return false;

    const manifests = payload.caseManifests as CaseAdapterManifest[];
    if (!(await Promise.all(manifests.map(verifyCaseAdapterManifest))).every(Boolean)) return false;
    const manifestKeys = manifests.map((manifest) => runtimeKey(manifest.adapterId, manifest.adapterVersion, manifest.contentHash));
    const identityKeys = manifests.map((manifest) => identityKey(manifest.identity));
    if (new Set(manifestKeys).size !== manifests.length || new Set(identityKeys).size !== manifests.length) return false;

    const sources = payload.sources.map(safeRecord);
    if (sources.some((source) => !source || !hasExactKeys(source, ["moduleId", "bytes"])
      || !isPortableId(source.moduleId) || typeof source.bytes !== "string" || !source.bytes)) return false;
    const sourceIds = sources.map((source) => source!.moduleId as string);
    if (new Set(sourceIds).size !== sourceIds.length) return false;
    const sourceIdSet = new Set(sourceIds);
    const artifactSources = sources.map((source) => ({
      moduleId: source!.moduleId as string,
      bytes: source!.bytes as string,
    }));
    if (canonicalize(parsedRegistration(sources, CASE_ADAPTER_MANIFEST_REGISTRATION_MODULE_ID)) !== canonicalize(manifests)
      || canonicalize(parsedRegistration(sources, CASE_RUNTIME_MODEL_REGISTRATION_MODULE_ID)) !== canonicalize(payload.runtimeModels)
      || canonicalize(parsedRegistration(sources, CAPABILITY_PROVIDER_REGISTRATION_MODULE_ID)) !== canonicalize(payload.capabilityProviderManifests)
      || canonicalize(parsedRegistration(sources, ADAPTER_CATALOG_REGISTRATION_MODULE_ID)) !== canonicalize(payload.catalog)) return false;

    const modelsByManifestHash = new Map<string, CaseRuntimeModel>();
    for (const candidate of payload.runtimeModels) {
      const model = candidate as CaseRuntimeModel;
      const manifest = manifests.find((entry) => entry.contentHash === model?.manifestHash);
      if (!manifest || model.authorityStatus !== "legacy_unverified" || modelsByManifestHash.has(model.manifestHash)
        || !await verifyCaseRuntimeModel(manifest, model)) return false;
      const modelSourceId = runtimeModelSourceModuleId(model.contentHash);
      const modelSource = sources.find((source) => source?.moduleId === modelSourceId);
      if (!modelSource || modelSource.bytes !== caseRuntimeModelCanonicalBytes(model)
        || !verifyRuntimeModelDataSourceClosure(model, artifactSources)) return false;
      modelsByManifestHash.set(model.manifestHash, model);
    }

    const runtimeKeys: string[] = [];
    for (const candidate of payload.runtimeAdapters) {
      const runtime = safeRecord(candidate);
      if (!runtime || !hasExactKeys(runtime, [
        "adapterId", "adapterVersion", "manifestHash", "executionStatus", "runtimeId", "runtimeVersion",
        "interpreterId", "modelHash", "modelSourceModuleId", "authorityStatus", "interpreterImplementationHash",
        "partialReason", "implementationModuleIds",
      ]) || !isPortableId(runtime.adapterId) || !isPortableId(runtime.adapterVersion) || !isSha256(runtime.manifestHash)
        || !Array.isArray(runtime.implementationModuleIds)
        || (runtime.implementationModuleIds as unknown[]).some((moduleId) => !isPortableId(moduleId))
        || new Set(runtime.implementationModuleIds).size !== runtime.implementationModuleIds.length
        || (runtime.implementationModuleIds as string[]).some((moduleId) => !sourceIdSet.has(moduleId))) return false;
      const model = modelsByManifestHash.get(runtime.manifestHash as string);
      if (runtime.executionStatus === "ready") {
        if (!model || runtime.runtimeId !== model.runtimeId || runtime.runtimeVersion !== model.runtimeVersion
          || runtime.interpreterId !== model.interpreterId || runtime.modelHash !== model.contentHash
          || runtime.modelSourceModuleId !== runtimeModelSourceModuleId(model.contentHash)
          || runtime.authorityStatus !== model.authorityStatus
          || !isSha256(runtime.interpreterImplementationHash)
          || runtime.interpreterImplementationHash !== await interpreterImplementationClosureHash(
            model.interpreterId,
            runtime.implementationModuleIds as string[],
            artifactSources,
          )
          || runtime.partialReason !== null || !exactPortableIdArray(runtime.implementationModuleIds)) return false;
      } else if (runtime.executionStatus === "partial") {
        if (model || runtime.runtimeId !== null || runtime.runtimeVersion !== null || runtime.interpreterId !== null
          || runtime.modelHash !== null || runtime.modelSourceModuleId !== null
          || runtime.authorityStatus !== null
          || runtime.interpreterImplementationHash !== null
          || runtime.partialReason !== "runtime-model-unavailable"
          || runtime.implementationModuleIds.length !== 0) return false;
      } else return false;
      runtimeKeys.push(runtimeKey(runtime.adapterId, runtime.adapterVersion, runtime.manifestHash));
    }
    if (new Set(runtimeKeys).size !== runtimeKeys.length || canonicalize(runtimeKeys.sort(compareCanonical)) !== canonicalize(manifestKeys.sort(compareCanonical))) return false;

    const providerKeys: string[] = [];
    for (const manifest of payload.capabilityProviderManifests) {
      if (validateCapabilityProviderManifest(manifest).length) return false;
      providerKeys.push(providerKey(manifest.providerId, manifest.providerVersion));
    }
    if (new Set(providerKeys).size !== providerKeys.length) return false;
    const providerRuntimeKeys: string[] = [];
    for (const candidate of payload.capabilityProviderRuntimes) {
      const runtime = safeRecord(candidate);
      if (!runtime || !hasExactKeys(runtime, ["providerId", "providerVersion", "implementationModuleIds"])
        || !isPortableId(runtime.providerId) || !isPortableId(runtime.providerVersion)
        || !exactPortableIdArray(runtime.implementationModuleIds)
        || (runtime.implementationModuleIds as string[]).some((moduleId) => !sourceIdSet.has(moduleId))) return false;
      providerRuntimeKeys.push(providerKey(runtime.providerId, runtime.providerVersion));
    }
    if (new Set(providerRuntimeKeys).size !== providerRuntimeKeys.length
      || canonicalize(providerRuntimeKeys.sort(compareCanonical)) !== canonicalize(providerKeys.sort(compareCanonical))) return false;

    if (!await verifyRuntimeRegistryClosure(payload.runtimeRegistry, sources, manifests)) return false;

    return validCatalog(payload.catalog, new Set(manifests.map((manifest) => manifest.identity.skuId)));
  } catch {
    return false;
  }
}

export class CaseAdapterRegistry {
  private readonly manifests = new Map<string, CaseAdapterManifest>();

  private constructor() {}

  static async create(manifests: readonly CaseAdapterManifest[] = []): Promise<CaseAdapterRegistry> {
    const registry = new CaseAdapterRegistry();
    for (const manifest of manifests) await registry.register(manifest);
    return registry;
  }

  async register(manifest: CaseAdapterManifest): Promise<void> {
    const errors = validateCaseAdapterManifest(manifest);
    if (errors.length) throw new TypeError(`Invalid case adapter manifest: ${errors.join("; ")}`);
    if (!await verifyCaseAdapterManifest(manifest)) throw new TypeError("case adapter manifest content hash mismatch");
    const key = identityKey(manifest.identity);
    if (this.manifests.has(key)) throw new Error(`case adapter already registered: ${key.replaceAll("\0", "@")}`);
    this.manifests.set(key, structuredClone(manifest));
  }

  resolve(identity: CaseAdapterLookupIdentity): CaseAdapterManifest | null {
    const manifest = this.manifests.get(identityKey(identity));
    return manifest ? structuredClone(manifest) : null;
  }

  list(): CaseAdapterManifest[] {
    return [...this.manifests.entries()]
      .sort(([left], [right]) => compareCanonical(left, right))
      .map(([, manifest]) => structuredClone(manifest));
  }

  async createArtifact(options: CreateCaseAdapterArtifactOptions = {}): Promise<CaseAdapterArtifact> {
    const manifests = this.list();
    if (manifests.length === 0) throw new Error("case adapter registry cannot snapshot an empty registry");
    if (!(await Promise.all(manifests.map(verifyCaseAdapterManifest))).every(Boolean)) throw new Error("case adapter registry contains a corrupt manifest");
    const runtimeModels = await normalizedRuntimeModels(manifests, options.runtimeModels ?? []);
    const runtimeModelsByManifestHash = new Map(runtimeModels.map((model) => [model.manifestHash, model]));
    const capabilityProviderManifests = [...(options.capabilityProviderManifests ?? [defaultProviderManifest(manifests)])]
      .map((manifest) => structuredClone(manifest))
      .sort((left, right) => compareCanonical(providerKey(left.providerId, left.providerVersion), providerKey(right.providerId, right.providerVersion)));
    const catalog: CaseAdapterArtifactPayload["catalog"] = structuredClone(options.catalog ?? {
      schemaVersion: "case-adapter-identity-catalog-v1",
      skus: manifests.map((manifest) => ({
        id: manifest.identity.skuId,
        category: "case" as const,
        name: manifest.identity.skuId,
      })),
    });
    const registrationIds = new Set([
      CASE_ADAPTER_MANIFEST_REGISTRATION_MODULE_ID,
      CAPABILITY_PROVIDER_REGISTRATION_MODULE_ID,
      ADAPTER_CATALOG_REGISTRATION_MODULE_ID,
      RUNTIME_CASE_ADAPTER_REGISTRY_MODULE_ID,
      CASE_RUNTIME_MODEL_REGISTRATION_MODULE_ID,
      ...runtimeModels.map((model) => runtimeModelSourceModuleId(model.contentHash)),
    ]);
    const runtimeRegistry = normalizedRuntimeRegistry(options.runtimeRegistry);
    const sources = normalizedSources([
      ...(options.sources ?? fallbackSources()).filter((source) => !registrationIds.has(source.moduleId)),
      { moduleId: CASE_ADAPTER_MANIFEST_REGISTRATION_MODULE_ID, bytes: canonicalize(manifests) },
      { moduleId: CAPABILITY_PROVIDER_REGISTRATION_MODULE_ID, bytes: canonicalize(capabilityProviderManifests) },
      { moduleId: ADAPTER_CATALOG_REGISTRATION_MODULE_ID, bytes: canonicalize(catalog) },
      { moduleId: RUNTIME_CASE_ADAPTER_REGISTRY_MODULE_ID, bytes: runtimeRegistry.bytes },
      { moduleId: CASE_RUNTIME_MODEL_REGISTRATION_MODULE_ID, bytes: canonicalize(runtimeModels) },
      ...runtimeModels.map((model) => ({
        moduleId: runtimeModelSourceModuleId(model.contentHash),
        bytes: caseRuntimeModelCanonicalBytes(model),
      })),
    ]);
    const sourceIds = new Set(sources.map((source) => source.moduleId));
    const adapterImplementationModuleIds = [...(options.adapterImplementationModuleIds ?? [
      CASE_ADAPTER_REGISTRY_MODULE_ID,
      CASE_RUNTIME_COMPILER_MODULE_ID,
      DECLARATIVE_CASE_INTERPRETER_MODULE_ID,
    ])].sort(compareCanonical);
    const capabilityProviderImplementationModuleIds = [...(options.capabilityProviderImplementationModuleIds ?? [
      CAPABILITY_PROVIDER_MODULE_ID,
      CAPABILITY_PROVIDER_REGISTRY_MODULE_ID,
    ])].sort(compareCanonical);
    if (adapterImplementationModuleIds.some((id) => !sourceIds.has(id))
      || capabilityProviderImplementationModuleIds.some((id) => !sourceIds.has(id))) {
      throw new TypeError("adapter/provider runtime implementation source closure is incomplete");
    }
    const runtimeAdapters = await Promise.all(manifests.map(async (manifest): Promise<CaseAdapterRuntimeIdentity> => {
      const model = runtimeModelsByManifestHash.get(manifest.contentHash);
      return model ? {
        adapterId: manifest.adapterId,
        adapterVersion: manifest.adapterVersion,
        manifestHash: manifest.contentHash,
        executionStatus: "ready",
        runtimeId: model.runtimeId,
        runtimeVersion: model.runtimeVersion,
        interpreterId: model.interpreterId,
        modelHash: model.contentHash,
        modelSourceModuleId: runtimeModelSourceModuleId(model.contentHash),
        authorityStatus: model.authorityStatus,
        interpreterImplementationHash: await interpreterImplementationClosureHash(
          model.interpreterId,
          adapterImplementationModuleIds,
          sources,
        ),
        partialReason: null,
        implementationModuleIds: adapterImplementationModuleIds,
      } : {
        adapterId: manifest.adapterId,
        adapterVersion: manifest.adapterVersion,
        manifestHash: manifest.contentHash,
        executionStatus: "partial",
        runtimeId: null,
        runtimeVersion: null,
        interpreterId: null,
        modelHash: null,
        modelSourceModuleId: null,
        authorityStatus: null,
        interpreterImplementationHash: null,
        partialReason: "runtime-model-unavailable",
        implementationModuleIds: [],
      };
    }));
    const payload: CaseAdapterArtifactPayload = {
      schemaVersion: "workspace-adapter-snapshot-v1",
      catalog,
      caseManifests: manifests,
      runtimeModels,
      runtimeAdapters,
      capabilityProviderManifests,
      capabilityProviderRuntimes: capabilityProviderManifests.map((manifest) => ({
        providerId: manifest.providerId,
        providerVersion: manifest.providerVersion,
        implementationModuleIds: capabilityProviderImplementationModuleIds,
      })),
      runtimeRegistry: runtimeRegistry.binding,
      sources,
    };
    if (!await verifyCaseAdapterSnapshotPayload(payload)) throw new TypeError("case adapter artifact payload failed closure validation");
    const ref = await createLockedArtifactRef(payload, "adapterSnapshot", "case-adapter-registry-v1", ARTIFACT_MEDIA, ARTIFACT_CONTRACT);
    return deepFreeze({ payload, ref, snapshotHash: ref.contentHash }) as CaseAdapterArtifact;
  }
}

/** Vite bundles every governed production case seed; no generic server module names a concrete case. */
export async function createBundledCaseAdapterRegistry(): Promise<CaseAdapterRegistry> {
  const seeds = Object.entries(bundledCaseSeedModules).sort(([left], [right]) => compareCanonical(left, right));
  if (!seeds.length) throw new Error("bundled case adapter registry is empty");
  const manifests = await Promise.all(seeds.map(([, seed]) => createCaseAdapterManifest(structuredClone(seed.manifest))));
  return CaseAdapterRegistry.create(manifests);
}

export async function verifyCaseAdapterArtifact(value: CaseAdapterArtifact): Promise<boolean> {
  if (!value || typeof value !== "object" || value.snapshotHash !== value.ref?.contentHash
    || value.ref?.role !== "adapterSnapshot" || value.ref?.mediaType !== ARTIFACT_MEDIA
    || !await verifyCaseAdapterSnapshotPayload(value.payload)) return false;
  return verifyContentAddressedRef(value.payload, {
    ref: value.ref.ref,
    hashSpecVersion: value.ref.hashSpecVersion,
    algorithm: value.ref.algorithm,
    contentHash: value.ref.contentHash,
    domain: value.ref.domain,
    schemaVersion: value.ref.schemaVersion,
    canonicalizationPolicyId: value.ref.canonicalizationPolicyId,
  });
}

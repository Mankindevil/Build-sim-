import { createHash } from "node:crypto";
import { validateCaseAdapterManifestRuntime } from "./case-manifest-runtime.mjs";
import {
  hydrateRuntimeCaseAdapterRegistryArtifactRuntime,
  validateRuntimeCaseAdapterRegistryRuntime,
} from "./provisional-runtime.mjs";
import {
  caseRuntimeModelCanonicalBytesRuntime,
  caseRuntimeModelContentHashRuntime,
  runtimeModelSnapshotReferencesRuntime,
  verifyCaseRuntimeModelRuntime,
} from "./runtime-model-runtime.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const SHA_REF = /^sha256:([a-f0-9]{64})$/u;
const MODEL_SOURCE_PREFIX = "adapters/runtime-model";
const MANIFEST_REGISTRATION = "adapters/manifest-registration.json";
const MODEL_REGISTRATION = "adapters/runtime-model-registration.json";
const PROVIDER_REGISTRATION = "capabilities/provider-registration.json";
const CATALOG_REGISTRATION = "adapters/catalog-registration.json";
const RUNTIME_REGISTRY_SOURCE = "adapters/runtime-case-adapter-registry.json";
const DOCUMENT_NAMES = Object.freeze(["profile", "geometry", "routing", "assembly", "calibration"]);
const COMPONENT_KINDS = new Set([
  "case", "motherboard", "cpu", "memory_module", "gpu", "psu", "cpu_cooler", "aio", "radiator", "pump",
  "case_fan", "fan_rgb_hub", "storage_drive", "hba", "raid_controller", "storage_expander", "backplane",
  "nic", "capture_card", "expansion_board", "pcie_card", "cable", "adapter", "bracket",
]);
const CAPABILITY_FACETS = new Set([
  "identity.category", "identity.manufacturer", "identity.model", "identity.revision",
  "physical.width", "physical.height", "physical.depth", "mount.standard", "mount.point_ids",
  "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset", "motherboard.memory_type",
  "motherboard.memory_slot_count", "motherboard.memory_population_rules", "motherboard.form_factor",
  "motherboard.bios_version", "motherboard.bios_upgrade_methods", "motherboard.display_outputs",
  "motherboard.supported_operating_systems", "memory.type", "memory.capacity", "io.port_types",
  "io.header_types", "io.endpoint_ids", "case.motherboard_form_factors", "case.side_panel",
  "case.gpu_max_length", "case.cpu_cooler_max_height", "gpu.length", "gpu.slot_width",
  "gpu.power_connectors", "psu.capacity", "psu.connectors", "power.source_type", "power.load",
  "power.cable_families", "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing",
  "storage.interface", "storage.boot_support", "storage.capacity_bytes", "storage.recording_technology", "hba.mode",
  "cooling.fan_mounts", "cooling.radiator_support", "cooling.pump_header", "firmware.version",
  "firmware.upgrade_path_refs", "driver.supported_operating_systems", "driver.package_versions",
  "thermal.curve_refs", "acoustic.curve_refs", "package.contents", "resource.kind", "cable.connector_standard",
  "fastener.thread", "fastener.length_mm", "fastener.head", "tool.drive", "consumable.type", "accessory.standard", "acoustic.noise_class",
]);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) {
  return object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function portable(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.normalize("NFC")
    && !/\s|[\u0000-\u001f\u007f]/u.test(value);
}
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite adapter artifact number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object" || value === undefined || ancestors.has(value)) {
    throw new TypeError("non-canonical adapter artifact value");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key, index) => key !== String(index))) throw new TypeError("sparse adapter artifact array");
      return `[${value.map((entry) => canonical(entry, ancestors)).join(",")}]`;
    }
    return `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key.normalize("NFC"), child])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
function same(left, right) { try { return canonical(left) === canonical(right); } catch { return false; } }
function sha(bytes) { return createHash("sha256").update(bytes, "utf8").digest("hex"); }
function contentHash(value) {
  const preimage = ["buildsim", "hash-spec-v1", "artifact.adapter-snapshot", "1.0.0", canonical(value)].join("\0");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
function parse(bytes) { try { return JSON.parse(bytes); } catch { return null; } }
function unique(values) { return new Set(values).size === values.length; }
function sorted(values) { return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0); }
function modelSourceId(hash) { return `${MODEL_SOURCE_PREFIX}/${hash}.json`; }
function runtimeKey(value) { return `${value.adapterId}\0${value.adapterVersion}\0${value.manifestHash ?? value.contentHash}`; }
function identityKey(value) { return `${value.skuId}\0${value.region}\0${value.revision}`; }
function providerKey(value) { return `${value.providerId}\0${value.providerVersion}`; }

function validateSources(value) {
  if (!Array.isArray(value) || value.length < 1 || value.some((source) => !exact(source, ["moduleId", "bytes"])
    || !portable(source.moduleId) || typeof source.bytes !== "string" || source.bytes.length === 0)
    || !unique(value.map((source) => source.moduleId))) return null;
  return new Map(value.map((source) => [source.moduleId, source.bytes]));
}

function verifyModelDataSources(model, sources) {
  if (!Array.isArray(model.sourceRefs) || model.sourceRefs.length !== DOCUMENT_NAMES.length + 1
    || model.sourceRefs.some((ref) => !portable(ref) || !sources.has(ref))) return false;
  const registrations = model.sourceRefs.filter((ref) => ref.endsWith("/runtime-model.json"));
  if (registrations.length !== 1) return false;
  const registration = parse(sources.get(registrations[0]));
  if (!exact(registration, ["schemaVersion", "runtimeId", "runtimeVersion", "interpreterId", "authorityStatus", "authorityRefs", "identity", "documents"])
    || registration.schemaVersion !== "case-runtime-model-data-seed-v1"
    || registration.runtimeId !== model.runtimeId || registration.runtimeVersion !== model.runtimeVersion
    || registration.interpreterId !== model.interpreterId || registration.authorityStatus !== model.authorityStatus
    || !same(registration.authorityRefs, model.authorityRefs) || !same(registration.identity, model.identity)
    || !exact(registration.documents, DOCUMENT_NAMES)) return false;
  const expectedRefs = sorted([registrations[0], ...DOCUMENT_NAMES.map((name) => registration.documents[name])]);
  if (expectedRefs.some((ref) => !portable(ref)) || !same(expectedRefs, model.sourceRefs)) return false;
  return DOCUMENT_NAMES.every((name) => same(parse(sources.get(registration.documents[name])), model.documents[name]));
}

function validateCatalog(catalog, manifests) {
  if (!exact(catalog, ["schemaVersion", "skus"]) || catalog.schemaVersion !== "case-adapter-identity-catalog-v1"
    || !Array.isArray(catalog.skus) || catalog.skus.some((sku) => !exact(sku, ["id", "category", "name"])
      || !portable(sku.id) || sku.category !== "case" || sku.name !== sku.id)
    || !unique(catalog.skus.map((sku) => sku.id))) return false;
  const manifestIds = new Set(manifests.map((manifest) => manifest.identity.skuId));
  return catalog.skus.length === manifestIds.size && catalog.skus.every((sku) => manifestIds.has(sku.id));
}

function validateProviderManifest(value) {
  return exact(value, ["providerId", "providerVersion", "contractVersion", "componentKindIds", "facetIds", "replayable"])
    && portable(value.providerId) && portable(value.providerVersion) && value.contractVersion === "capability-provider-v1"
    && value.replayable === true && Array.isArray(value.componentKindIds) && value.componentKindIds.length > 0
    && value.componentKindIds.every((id) => portable(id) && COMPONENT_KINDS.has(id)) && unique(value.componentKindIds)
    && Array.isArray(value.facetIds) && value.facetIds.length > 0
    && value.facetIds.every((id) => portable(id) && CAPABILITY_FACETS.has(id)) && unique(value.facetIds);
}

function implementationHash(interpreterId, moduleIds, sources) {
  const implementationSources = sorted(moduleIds).map((moduleId) => ({ moduleId, bytes: sources.get(moduleId) }));
  if (implementationSources.some((source) => typeof source.bytes !== "string")) return null;
  return contentHash({ interpreterId, implementationSources });
}

function validateRegistry(binding, sources, manifests) {
  if (!exact(binding, ["schemaVersion", "registryRef", "activeRuntimeGeneration", "registrySourceRuntimeGeneration", "registryGeneration", "manifestHashes", "sourceModuleId"])
    || binding.schemaVersion !== "runtime-case-adapter-registry-binding-v2"
    || binding.sourceModuleId !== RUNTIME_REGISTRY_SOURCE || !Number.isSafeInteger(binding.activeRuntimeGeneration)
    || binding.activeRuntimeGeneration < 1
    || (binding.registrySourceRuntimeGeneration !== null
      && (!Number.isSafeInteger(binding.registrySourceRuntimeGeneration)
        || binding.registrySourceRuntimeGeneration < 1
        || binding.registrySourceRuntimeGeneration > binding.activeRuntimeGeneration))
    || !Number.isSafeInteger(binding.registryGeneration) || binding.registryGeneration < 0
    || !Array.isArray(binding.manifestHashes) || binding.manifestHashes.some((hash) => !HASH.test(hash))
    || !unique(binding.manifestHashes) || !same(binding.manifestHashes, sorted(binding.manifestHashes))) return false;
  const bytes = sources.get(RUNTIME_REGISTRY_SOURCE);
  if (typeof bytes !== "string") return false;
  if (binding.registryRef === null) {
    return binding.registrySourceRuntimeGeneration === null
      && binding.registryGeneration === 0 && binding.manifestHashes.length === 0
      && bytes === canonical({ domain: "buildsim.runtime-case-adapter-registry-binding-v2", binding: {
        schemaVersion: binding.schemaVersion,
        registryRef: null,
        activeRuntimeGeneration: binding.activeRuntimeGeneration,
        registrySourceRuntimeGeneration: null,
        registryGeneration: 0,
        manifestHashes: [],
      } });
  }
  const ref = SHA_REF.exec(String(binding.registryRef));
  if (!ref || ref[1] !== sha(bytes) || binding.registrySourceRuntimeGeneration === null
    || binding.registryGeneration < 1 || binding.manifestHashes.length < 1) return false;
  const hydrated = hydrateRuntimeCaseAdapterRegistryArtifactRuntime(parse(bytes), binding.registryRef);
  if (!hydrated || validateRuntimeCaseAdapterRegistryRuntime(hydrated).length
    || hydrated.runtimeGeneration !== binding.registrySourceRuntimeGeneration
    || hydrated.registryGeneration !== binding.registryGeneration || !Array.isArray(hydrated.entries)) return false;
  const manifestsByHash = new Map(manifests.map((manifest) => [manifest.contentHash, manifest]));
  if (hydrated.entries.some((entry) => entry.manifestHash !== entry.manifest?.contentHash
    || !same(manifestsByHash.get(entry.manifestHash), entry.manifest))) return false;
  return same(sorted(hydrated.entries.map((entry) => entry.manifestHash)), binding.manifestHashes);
}

/** Total JS-safe semantic validator used by graph, Doctor, backup and restore. */
export function validateWorkspaceCaseAdapterSnapshotRuntime(value) {
  try {
    const fields = ["schemaVersion", "catalog", "caseManifests", "runtimeModels", "runtimeAdapters", "capabilityProviderManifests", "capabilityProviderRuntimes", "runtimeRegistry", "sources"];
    if (!exact(value, fields) || value.schemaVersion !== "workspace-adapter-snapshot-v1") return ["workspace case adapter snapshot fields invalid"];
    const errors = [];
    const sources = validateSources(value.sources);
    if (!sources) return ["workspace case adapter snapshot sources invalid"];
    if (!Array.isArray(value.caseManifests) || value.caseManifests.length < 1
      || value.caseManifests.some((manifest) => validateCaseAdapterManifestRuntime(manifest).length)
      || !unique(value.caseManifests.map(runtimeKey)) || !unique(value.caseManifests.map((manifest) => identityKey(manifest.identity)))) {
      errors.push("workspace case adapter manifest closure invalid");
    }
    const manifests = Array.isArray(value.caseManifests) ? value.caseManifests : [];
    if (!same(parse(sources.get(MANIFEST_REGISTRATION)), manifests)
      || !same(parse(sources.get(MODEL_REGISTRATION)), value.runtimeModels)
      || !same(parse(sources.get(PROVIDER_REGISTRATION)), value.capabilityProviderManifests)
      || !same(parse(sources.get(CATALOG_REGISTRATION)), value.catalog)) errors.push("workspace case adapter registration bytes invalid");
    const manifestsByHash = new Map(manifests.map((manifest) => [manifest.contentHash, manifest]));
    const modelsByManifest = new Map(); const modelsByHash = new Map();
    if (!Array.isArray(value.runtimeModels)) errors.push("workspace case runtime models invalid");
    else for (const model of value.runtimeModels) {
      const manifest = manifestsByHash.get(model?.manifestHash);
      if (!manifest || model.authorityStatus !== "legacy_unverified"
        || modelsByManifest.has(model.manifestHash) || !verifyCaseRuntimeModelRuntime(model, manifest)
        || caseRuntimeModelContentHashRuntime(model) !== model.contentHash
        || sources.get(modelSourceId(model.contentHash)) !== caseRuntimeModelCanonicalBytesRuntime(model)
        || !verifyModelDataSources(model, sources)) errors.push("workspace case runtime model semantic closure invalid");
      else { modelsByManifest.set(model.manifestHash, model); modelsByHash.set(model.contentHash, model); }
    }
    if (!Array.isArray(value.runtimeAdapters) || value.runtimeAdapters.length !== manifests.length) errors.push("workspace case runtime descriptor cardinality invalid");
    else {
      const descriptorKeys = [];
      for (const descriptor of value.runtimeAdapters) {
        const descriptorFields = ["adapterId", "adapterVersion", "manifestHash", "executionStatus", "runtimeId", "runtimeVersion", "interpreterId", "modelHash", "modelSourceModuleId", "authorityStatus", "interpreterImplementationHash", "partialReason", "implementationModuleIds"];
        const manifest = manifestsByHash.get(descriptor?.manifestHash);
        if (!exact(descriptor, descriptorFields) || !manifest || descriptor.adapterId !== manifest.adapterId
          || descriptor.adapterVersion !== manifest.adapterVersion || !Array.isArray(descriptor.implementationModuleIds)
          || !unique(descriptor.implementationModuleIds) || descriptor.implementationModuleIds.some((id) => !portable(id) || !sources.has(id))) {
          errors.push("workspace case runtime descriptor identity/source closure invalid"); continue;
        }
        const model = modelsByManifest.get(descriptor.manifestHash);
        if (descriptor.executionStatus === "ready") {
          if (!model || descriptor.runtimeId !== model.runtimeId || descriptor.runtimeVersion !== model.runtimeVersion
            || descriptor.interpreterId !== model.interpreterId || descriptor.modelHash !== model.contentHash
            || descriptor.modelSourceModuleId !== modelSourceId(model.contentHash) || descriptor.authorityStatus !== model.authorityStatus
            || descriptor.partialReason !== null || descriptor.implementationModuleIds.length < 1
            || descriptor.interpreterImplementationHash !== implementationHash(model.interpreterId, descriptor.implementationModuleIds, sources)) {
            errors.push("workspace ready case runtime descriptor/model/interpreter closure invalid");
          }
        } else if (descriptor.executionStatus === "partial") {
          if (model || descriptor.runtimeId !== null || descriptor.runtimeVersion !== null || descriptor.interpreterId !== null
            || descriptor.modelHash !== null || descriptor.modelSourceModuleId !== null || descriptor.authorityStatus !== null
            || descriptor.interpreterImplementationHash !== null || descriptor.partialReason !== "runtime-model-unavailable"
            || descriptor.implementationModuleIds.length !== 0) errors.push("workspace partial case runtime descriptor is dishonest");
        } else errors.push("workspace case runtime descriptor executionStatus invalid");
        descriptorKeys.push(runtimeKey(descriptor));
      }
      if (!unique(descriptorKeys) || !same(sorted(descriptorKeys), sorted(manifests.map(runtimeKey)))) errors.push("workspace case runtime descriptor set mismatch");
    }
    if (!Array.isArray(value.capabilityProviderManifests) || value.capabilityProviderManifests.length < 1
      || value.capabilityProviderManifests.some((manifest) => !validateProviderManifest(manifest))
      || !unique(value.capabilityProviderManifests.map(providerKey))) errors.push("workspace capability provider manifests invalid");
    if (!Array.isArray(value.capabilityProviderRuntimes)
      || value.capabilityProviderRuntimes.some((runtime) => !exact(runtime, ["providerId", "providerVersion", "implementationModuleIds"])
        || !portable(runtime.providerId) || !portable(runtime.providerVersion) || !Array.isArray(runtime.implementationModuleIds)
        || runtime.implementationModuleIds.length < 1 || !unique(runtime.implementationModuleIds)
        || runtime.implementationModuleIds.some((id) => !portable(id) || !sources.has(id)))
      || !same(sorted(value.capabilityProviderRuntimes.map(providerKey)), sorted(value.capabilityProviderManifests.map(providerKey)))) {
      errors.push("workspace capability provider runtime closure invalid");
    }
    if (!validateCatalog(value.catalog, manifests)) errors.push("workspace case adapter identity catalog invalid");
    if (!validateRegistry(value.runtimeRegistry, sources, manifests)) errors.push("workspace runtime case adapter registry closure invalid");
    return errors;
  } catch { return ["workspace case adapter snapshot runtime validation failed closed"]; }
}

/** External replay authorities referenced by an otherwise valid snapshot. */
export function workspaceCaseAdapterSnapshotReferencesRuntime(value) {
  if (validateWorkspaceCaseAdapterSnapshotRuntime(value).length) return null;
  const refs = [];
  if (value.runtimeRegistry.registryRef) refs.push({ ref: value.runtimeRegistry.registryRef, necessity: "required_for_replay" });
  for (const model of value.runtimeModels) {
    if (model.authorityStatus !== "governed_fact_derivation_bound") continue;
    const manifest = value.caseManifests.find((candidate) => candidate.contentHash === model.manifestHash);
    const modelRefs = runtimeModelSnapshotReferencesRuntime(model, manifest);
    if (!modelRefs) return null;
    refs.push(...modelRefs.factIds.map((factId) => ({ ref: `fact:${factId}`, necessity: "required_for_replay" })));
    refs.push(...modelRefs.derivationIds.map((derivationId) => ({ ref: `fact-inference:${derivationId}`, necessity: "required_for_replay" })));
    // Contract: evidenceContentHashes are exclusively locked EvidenceClaim
    // content hashes. Graph closure rejects a missing claim node; they are not
    // generic ArtifactRepository hashes and cannot be reinterpreted as such.
    refs.push(...modelRefs.evidenceContentHashes.map((hash) => ({ ref: `evidence-claim:claim-sha256-${hash}`, necessity: "required_for_replay" })));
  }
  const byKey = new Map(refs.map((item) => [`${item.ref}\0${item.necessity}`, item]));
  return [...byKey.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

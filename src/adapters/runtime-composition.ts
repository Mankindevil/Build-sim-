import { compareCanonical, hasExactKeys, isPortableId, safeRecord } from "../capabilities/validation";
import type { CaseAdapterManifest } from "./contracts";
import {
  createCaseRuntimeModel,
  verifyCaseRuntimeModel,
  type CaseRuntimeModel,
} from "./runtime-model";

export interface BundledCaseRuntimeDataModules {
  documents: Readonly<Record<string, unknown>>;
  rawBytes: Readonly<Record<string, string>>;
}

const bundledRuntimeDataDocuments = import.meta.glob("../../data/cases/*/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;
const bundledRuntimeDataBytes = import.meta.glob("../../data/cases/*/*.json", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

export interface BundledCaseRuntimeModelSnapshot {
  models: CaseRuntimeModel[];
  /** Exact checked-in JSON bytes, keyed by artifact-portable module ID. */
  sources: Array<{ moduleId: string; bytes: string }>;
}

const RUNTIME_DATA_FILES = ["profile", "geometry", "routing", "assembly", "calibration"] as const;

function artifactModuleId(importId: string): string {
  const normalized = importId.replaceAll("\\", "/");
  const marker = normalized.indexOf("data/cases/");
  if (marker < 0) throw new TypeError(`case runtime data module path is outside data/cases: ${importId}`);
  const moduleId = normalized.slice(marker);
  if (!isPortableId(moduleId)) throw new TypeError(`case runtime data module ID invalid: ${moduleId}`);
  return moduleId;
}

/**
 * Data-only model composition. No case implementation module participates in
 * the flag-on path: ordinary data/cases documents bind to an exact manifest by
 * caseId and are compiled by the shared declarative interpreter.
 */
export async function createBundledCaseRuntimeModelSnapshot(
  manifests: readonly CaseAdapterManifest[],
  modules: BundledCaseRuntimeDataModules = {
    documents: bundledRuntimeDataDocuments,
    rawBytes: bundledRuntimeDataBytes,
  },
): Promise<BundledCaseRuntimeModelSnapshot> {
  const models: CaseRuntimeModel[] = [];
  const sources = new Map<string, string>();
  const importsByModuleId = new Map(Object.keys(modules.documents).map((importId) => [artifactModuleId(importId), importId]));
  if (importsByModuleId.size !== Object.keys(modules.documents).length) {
    throw new Error("case runtime data modules contain duplicate portable module IDs");
  }
  const registrations = Object.entries(modules.documents)
    .filter(([importId]) => importId.endsWith("/runtime-model.json"))
    .sort(([left], [right]) => compareCanonical(left, right));
  for (const [registrationImportId, registrationValue] of registrations) {
    const registration = safeRecord(registrationValue);
    if (!registration || !hasExactKeys(registration, [
      "schemaVersion", "runtimeId", "runtimeVersion", "interpreterId", "authorityStatus",
      "authorityRefs", "identity", "documents",
    ]) || registration.schemaVersion !== "case-runtime-model-data-seed-v1"
      || ![registration.runtimeId, registration.runtimeVersion].every(isPortableId)
      || registration.interpreterId !== "declarative-case-v1") {
      throw new TypeError(`case runtime data registration invalid: ${registrationImportId}`);
    }
    const identity = safeRecord(registration.identity);
    const authorityRefs = safeRecord(registration.authorityRefs);
    const documentRefs = safeRecord(registration.documents);
    if (!identity || !hasExactKeys(identity, ["skuId", "region", "revision"])
      || ![identity.skuId, identity.region, identity.revision].every(isPortableId)
      || !authorityRefs || !hasExactKeys(authorityRefs, ["factIds", "derivationIds", "evidenceContentHashes"])
      || !documentRefs || !hasExactKeys(documentRefs, RUNTIME_DATA_FILES)) {
      throw new TypeError(`case runtime data registration closure invalid: ${registrationImportId}`);
    }
    const matches = manifests.filter((manifest) => manifest.identity.skuId === identity.skuId
      && manifest.identity.region === identity.region && manifest.identity.revision === identity.revision);
    if (matches.length !== 1) {
      throw new Error(`case runtime data registration must bind exactly one manifest identity: ${registrationImportId}`);
    }
    const manifest = matches[0]!;
    const documents = Object.fromEntries(RUNTIME_DATA_FILES.map((name) => {
      const moduleId = documentRefs[name];
      if (typeof moduleId !== "string" || !isPortableId(moduleId)) {
        throw new TypeError(`case runtime data document ref invalid: ${registrationImportId}#${name}`);
      }
      const importId = importsByModuleId.get(moduleId);
      if (!importId || !(importId in modules.documents) || !(importId in modules.rawBytes)) {
        throw new Error(`case runtime data document or exact bytes unavailable: ${moduleId}`);
      }
      return [name, structuredClone(modules.documents[importId])];
    })) as Record<(typeof RUNTIME_DATA_FILES)[number], never>;
    const registrationModuleId = artifactModuleId(registrationImportId);
    const sourceModuleIds = [registrationModuleId, ...RUNTIME_DATA_FILES.map((name) => documentRefs[name] as string)]
      .sort(compareCanonical);
    const sourceImportIds = sourceModuleIds.map((moduleId) => importsByModuleId.get(moduleId));
    for (const importId of sourceImportIds) {
      if (!importId) throw new Error("case runtime data source module is unavailable");
      const bytes = modules.rawBytes[importId];
      if (typeof bytes !== "string" || !bytes) throw new Error(`case runtime exact data bytes unavailable: ${importId}`);
      const moduleId = artifactModuleId(importId);
      const existing = sources.get(moduleId);
      if (existing !== undefined && existing !== bytes) {
        throw new Error(`case runtime data source identity has conflicting exact bytes: ${moduleId}`);
      }
      sources.set(moduleId, bytes);
    }
    const model = await createCaseRuntimeModel(manifest, {
      schemaVersion: "case-runtime-model-v1",
      runtimeId: registration.runtimeId as string,
      runtimeVersion: registration.runtimeVersion as string,
      interpreterId: "declarative-case-v1",
      authorityStatus: registration.authorityStatus as "legacy_unverified" | "governed_fact_derivation_bound",
      authorityRefs: structuredClone(registration.authorityRefs) as CaseRuntimeModel["authorityRefs"],
      identity: {
        skuId: manifest.identity.skuId,
        region: manifest.identity.region,
        revision: manifest.identity.revision,
      },
      manifestHash: manifest.contentHash,
      documents,
      sourceRefs: sourceModuleIds,
    });
    if (!await verifyCaseRuntimeModel(manifest, model)) {
      throw new Error(`case runtime data model failed exact manifest closure: ${registrationImportId}`);
    }
    models.push(model);
  }
  if (new Set(models.map((model) => model.manifestHash)).size !== models.length) {
    throw new Error("case runtime model registrations duplicate a manifest binding");
  }
  return {
    models: models.sort((left, right) => compareCanonical(left.manifestHash, right.manifestHash)),
    sources: [...sources].sort(([left], [right]) => compareCanonical(left, right))
      .map(([moduleId, bytes]) => ({ moduleId, bytes })),
  };
}

export async function createBundledCaseRuntimeModels(
  manifests: readonly CaseAdapterManifest[],
  modules?: BundledCaseRuntimeDataModules,
): Promise<CaseRuntimeModel[]> {
  return (await createBundledCaseRuntimeModelSnapshot(manifests, modules)).models;
}

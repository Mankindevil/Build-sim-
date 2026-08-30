import type { CanonicalJsonValue } from "../hash/canonical";
import { deepFreeze, normalizeNfcJson } from "../capabilities/validation";
import { compareCanonical } from "../capabilities/validation";
import { verifyCaseAdapterManifest, type CaseAdapterManifest } from "./contracts";
import {
  caseRuntimeModelCanonicalBytesRuntime,
  caseRuntimeModelContentHashRuntime,
  validateCaseRuntimeModelInputRuntime,
  validateCaseRuntimeModelRuntime,
  verifyCaseRuntimeModelRuntime,
} from "./runtime-model-runtime.mjs";

export interface CaseRuntimeModelDocuments {
  profile: CanonicalJsonValue;
  geometry: CanonicalJsonValue;
  routing: CanonicalJsonValue;
  assembly: CanonicalJsonValue;
  calibration: CanonicalJsonValue;
}

export interface CaseRuntimeModelInput {
  schemaVersion: "case-runtime-model-v1";
  runtimeId: string;
  runtimeVersion: string;
  interpreterId: "declarative-case-v1";
  authorityStatus: "legacy_unverified" | "governed_fact_derivation_bound";
  /**
   * v1 only admits `legacy_unverified` at runtime. The governed discriminator is
   * reserved and fails closed until every interpreted field carries an exact
   * fact/derivation binding rather than an unrelated aggregate reference set.
   */
  authorityRefs: {
    factIds: string[];
    derivationIds: string[];
    evidenceContentHashes: string[];
  };
  identity: { skuId: string; region: string; revision: string };
  manifestHash: string;
  documents: CaseRuntimeModelDocuments;
  sourceRefs: string[];
}

export interface CaseRuntimeModel extends CaseRuntimeModelInput {
  contentHash: string;
}

export function validateCaseRuntimeModelInput(value: unknown, manifest: CaseAdapterManifest | null = null): string[] {
  return validateCaseRuntimeModelInputRuntime(value, manifest);
}

export function validateCaseRuntimeModel(value: unknown, manifest: CaseAdapterManifest | null = null): string[] {
  return validateCaseRuntimeModelRuntime(value, manifest);
}

function modelMaterial(value: CaseRuntimeModelInput | CaseRuntimeModel): CaseRuntimeModelInput {
  const clone = structuredClone(value) as CaseRuntimeModel;
  const { contentHash: _contentHash, ...material } = clone;
  material.sourceRefs.sort(compareCanonical);
  return normalizeNfcJson(material);
}

/** Exact canonical JSON bytes persisted beside the model content hash. */
export function caseRuntimeModelCanonicalBytes(value: CaseRuntimeModelInput | CaseRuntimeModel): string {
  const bytes = caseRuntimeModelCanonicalBytesRuntime(modelMaterial(value));
  if (bytes === null) throw new TypeError("case runtime model cannot be canonicalized");
  return bytes;
}

/** SHA-256 over the registered adapter-artifact domain and canonical model material. */
export function caseRuntimeModelContentHash(value: CaseRuntimeModelInput | CaseRuntimeModel): Promise<string> {
  const contentHash = caseRuntimeModelContentHashRuntime(modelMaterial(value));
  if (contentHash === null) return Promise.reject(new TypeError("case runtime model cannot be hashed"));
  return Promise.resolve(contentHash);
}

function assertExactManifestBinding(manifest: CaseAdapterManifest, model: CaseRuntimeModelInput | CaseRuntimeModel): void {
  if (model.manifestHash !== manifest.contentHash || model.identity.skuId !== manifest.identity.skuId
    || model.identity.region !== manifest.identity.region || model.identity.revision !== manifest.identity.revision) {
    throw new TypeError("case runtime model does not close the exact manifest identity/hash");
  }
}

export async function createCaseRuntimeModel(
  manifest: CaseAdapterManifest,
  input: CaseRuntimeModelInput,
): Promise<CaseRuntimeModel> {
  if (!await verifyCaseAdapterManifest(manifest)) throw new TypeError("case runtime model manifest integrity invalid");
  const material = modelMaterial(input);
  const errors = validateCaseRuntimeModelInputRuntime(material, manifest);
  if (errors.length) throw new TypeError(`Invalid case runtime model: ${errors.join("; ")}`);
  assertExactManifestBinding(manifest, material);
  const model = { ...material, contentHash: await caseRuntimeModelContentHash(material) };
  const modelErrors = validateCaseRuntimeModelRuntime(model, manifest);
  if (modelErrors.length) throw new TypeError(`Invalid case runtime model: ${modelErrors.join("; ")}`);
  return deepFreeze(model) as CaseRuntimeModel;
}

export async function verifyCaseRuntimeModel(
  manifest: CaseAdapterManifest,
  value: unknown,
): Promise<boolean> {
  return await verifyCaseAdapterManifest(manifest) && verifyCaseRuntimeModelRuntime(value, manifest);
}

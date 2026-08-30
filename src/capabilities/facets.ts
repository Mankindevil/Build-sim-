import {
  CAPABILITY_FACET_REGISTRY,
  isComponentKindId,
  validateCapabilityFacet,
  type CapabilityFacet,
  type ComponentKindId,
} from "../contracts/registries";
import { hashContent } from "../hash";
import { validateFactSnapshot, type FactSnapshot } from "../facts/contracts";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isPortableId,
  isSha256,
  isUniquePortableIdArray,
  normalizeNfcJson,
  safeRecord,
  validateFactSnapshotRef,
} from "./validation";

export interface CapabilityFactSnapshotRef {
  snapshotId: string;
  contentHash: string;
}

export function capabilityFactSnapshotRef(snapshot: FactSnapshot): CapabilityFactSnapshotRef {
  const errors = validateFactSnapshot(snapshot);
  if (errors.length) throw new TypeError(`Invalid fact snapshot: ${errors.join("; ")}`);
  return Object.freeze({ snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash });
}

export interface CapabilityRecordInput {
  schemaVersion: "capability-record-v1";
  subjectSkuId: string;
  componentKindId: ComponentKindId;
  factSnapshotRef: CapabilityFactSnapshotRef;
  facets: CapabilityFacet[];
  providerRefs: string[];
}

export interface CapabilityRecord extends CapabilityRecordInput {
  contentHash: string;
}

const CAPABILITY_CONTRACT = Object.freeze({ domain: "artifact.adapter-snapshot", schemaVersion: "1.0.0" } as const);

function validateCapabilityRecordUnsafe(value: unknown, requireHash: boolean): string[] {
  const record = safeRecord(value);
  if (!record) return ["capability record must be an object"];
  const required = ["schemaVersion", "subjectSkuId", "componentKindId", "factSnapshotRef", "facets", "providerRefs"];
  const errors: string[] = [];
  if (!hasExactKeys(record, required, requireHash ? ["contentHash"] : []) || (requireHash && !("contentHash" in record))) {
    errors.push("capability record contains unknown or missing fields");
  }
  if (containsNonNfcText(record)) errors.push("capability record contains non-NFC text");
  if (record.schemaVersion !== "capability-record-v1") errors.push("capability record schemaVersion invalid");
  if (!isPortableId(record.subjectSkuId) || !isComponentKindId(record.componentKindId)) errors.push("capability record subject/kind invalid");
  errors.push(...validateFactSnapshotRef(record.factSnapshotRef).map((error) => `capability record ${error}`));
  if (!isUniquePortableIdArray(record.providerRefs)) errors.push("capability record providerRefs invalid");
  if (!Array.isArray(record.facets) || record.facets.length === 0) errors.push("capability record facets invalid");
  else {
    record.facets.forEach((facet, index) => {
      try {
        errors.push(...validateCapabilityFacet(facet).map((error) => `capability record facets.${index}: ${error}`));
      } catch {
        errors.push(`capability record facets.${index}: inaccessible capability facet`);
      }
      const facetRecord = safeRecord(facet);
      if (facetRecord && typeof facetRecord.facetId === "string" && Object.prototype.hasOwnProperty.call(CAPABILITY_FACET_REGISTRY, facetRecord.facetId)) {
        const definition = CAPABILITY_FACET_REGISTRY[facetRecord.facetId as keyof typeof CAPABILITY_FACET_REGISTRY];
        if (facetRecord.safetyClass !== definition.safetyClass) errors.push(`capability record facets.${index}: registry safety mismatch`);
      }
    });
    const ids = record.facets.map((facet) => safeRecord(facet)?.facetId).filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) errors.push("capability record facet IDs must be unique");
  }
  if (requireHash && !isSha256(record.contentHash)) errors.push("capability record contentHash invalid");
  return errors;
}

export function validateCapabilityRecordInput(value: unknown): string[] {
  try { return validateCapabilityRecordUnsafe(value, false); }
  catch { return ["capability record input is inaccessible or invalid"]; }
}

export function validateCapabilityRecord(value: unknown): string[] {
  try { return validateCapabilityRecordUnsafe(value, true); }
  catch { return ["capability record is inaccessible or invalid"]; }
}

function normalizeCapabilityRecord(input: CapabilityRecordInput): CapabilityRecordInput {
  const normalized = normalizeNfcJson(input);
  normalized.facets = [...normalized.facets]
    .map((facet) => ({
      ...facet,
      ...(Array.isArray(facet.value) ? { value: [...facet.value].sort(compareCanonical) } : {}),
      sourceFactIds: [...facet.sourceFactIds].sort(compareCanonical),
    }))
    .sort((left, right) => compareCanonical(left.facetId, right.facetId));
  normalized.providerRefs = [...normalized.providerRefs].sort(compareCanonical);
  return normalized;
}

export async function capabilityRecordContentHash(value: CapabilityRecordInput | CapabilityRecord): Promise<string> {
  return hashContent(value, CAPABILITY_CONTRACT);
}

export async function createCapabilityRecord(input: CapabilityRecordInput): Promise<CapabilityRecord> {
  const normalized = normalizeCapabilityRecord(input);
  const errors = validateCapabilityRecordInput(normalized);
  if (errors.length) throw new TypeError(`Invalid capability record: ${errors.join("; ")}`);
  const record: CapabilityRecord = { ...normalized, contentHash: await capabilityRecordContentHash(normalized) };
  return deepFreeze(record) as CapabilityRecord;
}

export async function verifyCapabilityRecord(value: unknown): Promise<boolean> {
  if (validateCapabilityRecord(value).length) return false;
  const record = value as CapabilityRecord;
  return record.contentHash === await capabilityRecordContentHash(record);
}

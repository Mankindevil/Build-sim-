import {
  isComponentKindId,
  validateCapabilityFacet,
  validateFacetPredicate,
  type CapabilityFacet,
  type ComponentKindId,
  type FacetId,
  type GovernedFacetPredicate,
} from "../contracts/registries";
import { hashContent } from "../hash";
import { validateFactSnapshot, type FactSnapshot } from "../facts/contracts";
import { verifyFactSnapshot } from "../facts/snapshots";
import type { CapabilityFactSnapshotRef, CapabilityRecord } from "./facets";
import { capabilityFactSnapshotRef, validateCapabilityRecord, verifyCapabilityRecord } from "./facets";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isPortableId,
  isSha256,
  normalizeNfcJson,
  safeRecord,
  sameSnapshotRef,
  validateFactSnapshotRef,
} from "./validation";

/**
 * Frozen selection vocabulary. Identity names/manufacturers and package prose
 * are deliberately absent so candidate generation cannot become SKU search.
 */
export const CANDIDATE_INDEX_FACET_IDS = deepFreeze([
  "identity.category",
  "physical.width", "physical.height", "physical.depth",
  "mount.standard", "mount.point_ids",
  "cpu.socket", "motherboard.cpu_socket", "motherboard.chipset", "motherboard.memory_type",
  "motherboard.memory_slot_count", "motherboard.memory_population_rules", "motherboard.form_factor",
  "motherboard.bios_version", "motherboard.bios_upgrade_methods", "motherboard.display_outputs",
  "motherboard.supported_operating_systems", "memory.type", "memory.capacity",
  "io.port_types", "io.header_types", "io.endpoint_ids",
  "case.motherboard_form_factors", "case.side_panel", "case.gpu_max_length", "case.cpu_cooler_max_height",
  "gpu.length", "gpu.slot_width", "gpu.power_connectors",
  "psu.capacity", "psu.connectors", "power.source_type", "power.load", "power.cable_families",
  "pcie.lane_count", "pcie.slot_types", "pcie.lane_sharing",
  "storage.interface", "storage.boot_support", "storage.capacity_bytes", "storage.recording_technology", "hba.mode",
  "cooling.fan_mounts", "cooling.radiator_support", "cooling.pump_header",
  "firmware.version", "firmware.upgrade_path_refs",
  "driver.supported_operating_systems", "driver.package_versions",
  "thermal.curve_refs", "acoustic.curve_refs", "acoustic.noise_class",
] as const satisfies readonly FacetId[]);
export type CandidateIndexFacetId = (typeof CANDIDATE_INDEX_FACET_IDS)[number];

export interface RequirementCapabilityIndexEntry {
  subjectSkuId: string;
  componentKindId: ComponentKindId;
  capabilityRecordHash: string;
  facets: CapabilityFacet[];
}

export interface RequirementCapabilityIndex {
  schemaVersion: "requirement-capability-index-v1";
  factSnapshotRef: CapabilityFactSnapshotRef;
  entries: RequirementCapabilityIndexEntry[];
  contentHash: string;
}

export interface RequirementCapabilityQuery {
  factSnapshotRef: CapabilityFactSnapshotRef;
  componentKindId: ComponentKindId;
  predicates: GovernedFacetPredicate[];
}

const CONTRACT = Object.freeze({ domain: "artifact.rule-set", schemaVersion: "1.0.0" } as const);
const ALLOWLIST = new Set<FacetId>(CANDIDATE_INDEX_FACET_IDS);

function validateIndexEntry(value: unknown): string[] {
  const entry = safeRecord(value);
  if (!entry || !hasExactKeys(entry, ["subjectSkuId", "componentKindId", "capabilityRecordHash", "facets"])) return ["requirement capability index entry shape invalid"];
  const errors: string[] = [];
  if (!isPortableId(entry.subjectSkuId) || !isComponentKindId(entry.componentKindId)) errors.push("requirement capability index entry subject/kind invalid");
  if (!isSha256(entry.capabilityRecordHash)) errors.push("requirement capability index entry record hash invalid");
  if (!Array.isArray(entry.facets) || entry.facets.length === 0) errors.push("requirement capability index entry facets invalid");
  else {
    entry.facets.forEach((facet, index) => {
      try { errors.push(...validateCapabilityFacet(facet).map((error) => `facets.${index}: ${error}`)); }
      catch { errors.push(`facets.${index}: inaccessible capability facet`); }
      const facetId = safeRecord(facet)?.facetId;
      if (typeof facetId === "string" && !ALLOWLIST.has(facetId as FacetId)) errors.push(`facets.${index}: facetId is not candidate-index allowlisted`);
    });
    const ids = entry.facets.map((facet) => safeRecord(facet)?.facetId).filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) errors.push("requirement capability index entry facet IDs must be unique");
  }
  return errors;
}

export function validateRequirementCapabilityIndex(value: unknown): string[] {
  try {
    const index = safeRecord(value);
    if (!index) return ["requirement capability index must be an object"];
    const errors: string[] = [];
    if (!hasExactKeys(index, ["schemaVersion", "factSnapshotRef", "entries", "contentHash"])) errors.push("requirement capability index contains unknown fields");
    if (containsNonNfcText(index)) errors.push("requirement capability index contains non-NFC text");
    if (index.schemaVersion !== "requirement-capability-index-v1") errors.push("requirement capability index schemaVersion invalid");
    errors.push(...validateFactSnapshotRef(index.factSnapshotRef).map((error) => `requirement capability index ${error}`));
    if (!isSha256(index.contentHash)) errors.push("requirement capability index contentHash invalid");
    if (!Array.isArray(index.entries)) errors.push("requirement capability index entries invalid");
    else {
      index.entries.forEach((entry, position) => errors.push(...validateIndexEntry(entry).map((error) => `entries.${position}: ${error}`)));
      const identities = index.entries.map((entry) => {
        const record = safeRecord(entry);
        return `${String(record?.componentKindId)}\0${String(record?.subjectSkuId)}`;
      });
      if (new Set(identities).size !== identities.length) errors.push("requirement capability index subjects must be unique");
    }
    return errors;
  } catch {
    return ["requirement capability index is inaccessible or invalid"];
  }
}

function normalizeEntries(records: readonly CapabilityRecord[]): RequirementCapabilityIndexEntry[] {
  return records.map((record) => ({
    subjectSkuId: record.subjectSkuId,
    componentKindId: record.componentKindId,
    capabilityRecordHash: record.contentHash,
    facets: record.facets
      .filter((facet) => ALLOWLIST.has(facet.facetId))
      .map((facet) => structuredClone(facet))
      .sort((left, right) => compareCanonical(left.facetId, right.facetId)),
  })).sort((left, right) => compareCanonical(`${left.componentKindId}\0${left.subjectSkuId}`, `${right.componentKindId}\0${right.subjectSkuId}`));
}

export async function requirementCapabilityIndexContentHash(value: Omit<RequirementCapabilityIndex, "contentHash"> | RequirementCapabilityIndex): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function buildRequirementCapabilityIndex(
  records: readonly CapabilityRecord[],
  factSnapshot: FactSnapshot,
): Promise<RequirementCapabilityIndex> {
  let factSnapshotRef: CapabilityFactSnapshotRef;
  try {
    const snapshotErrors = validateFactSnapshot(factSnapshot);
    if (snapshotErrors.length || !await verifyFactSnapshot(factSnapshot)) throw new TypeError(snapshotErrors.length ? snapshotErrors.join("; ") : "content hash mismatch");
    factSnapshotRef = capabilityFactSnapshotRef(factSnapshot);
  } catch (error) {
    throw new TypeError(`Invalid fact snapshot authority: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(records)) throw new TypeError("capability records must be an array");
  const snapshotFactIds = new Set(factSnapshot.factRefs.map((ref) => ref.factId));
  for (const record of records) {
    if (validateCapabilityRecord(record).length || !await verifyCapabilityRecord(record)) throw new TypeError("capability record invalid or content hash mismatch");
    if (!sameSnapshotRef(record.factSnapshotRef, factSnapshotRef)) throw new TypeError("capability record fact snapshot does not match index fact snapshot");
    if (record.facets.some((facet: CapabilityFacet) => facet.sourceFactIds.some((factId: string) => !snapshotFactIds.has(factId)))) throw new TypeError("capability record source fact is outside index fact snapshot");
  }
  const identities = records.map((record) => `${record.componentKindId}\0${record.subjectSkuId}`);
  if (new Set(identities).size !== identities.length) throw new TypeError("capability index input subjects must be unique");
  const entries = normalizeEntries(records);
  if (entries.some((entry) => entry.facets.length === 0)) throw new TypeError("capability record has no candidate-index allowlisted facets");
  const material = normalizeNfcJson({ schemaVersion: "requirement-capability-index-v1" as const, factSnapshotRef, entries });
  const index: RequirementCapabilityIndex = { ...material, contentHash: await requirementCapabilityIndexContentHash(material) };
  const errors = validateRequirementCapabilityIndex(index);
  if (errors.length) throw new TypeError(`Invalid requirement capability index: ${errors.join("; ")}`);
  return deepFreeze(index) as RequirementCapabilityIndex;
}

export async function verifyRequirementCapabilityIndex(value: unknown): Promise<boolean> {
  if (validateRequirementCapabilityIndex(value).length) return false;
  const index = value as RequirementCapabilityIndex;
  return index.contentHash === await requirementCapabilityIndexContentHash(index);
}

function validateQuery(value: unknown): string[] {
  const query = safeRecord(value);
  if (!query) return ["requirement capability query must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(query, ["factSnapshotRef", "componentKindId", "predicates"])) errors.push("requirement capability query contains unknown fields");
  errors.push(...validateFactSnapshotRef(query.factSnapshotRef));
  if (!isComponentKindId(query.componentKindId)) errors.push("requirement capability query componentKindId invalid");
  if (!Array.isArray(query.predicates)) errors.push("requirement capability query predicates invalid");
  else query.predicates.forEach((predicate, position) => {
    try { errors.push(...validateFacetPredicate(predicate).map((error) => `predicates.${position}: ${error}`)); }
    catch { errors.push(`predicates.${position}: inaccessible predicate`); }
    const facetId = safeRecord(predicate)?.facetId;
    if (typeof facetId === "string" && !ALLOWLIST.has(facetId as FacetId)) errors.push(`predicates.${position}: facetId is not candidate-index allowlisted`);
  });
  return errors;
}

function predicateMatches(facet: CapabilityFacet | undefined, predicate: GovernedFacetPredicate): boolean {
  if (!facet || facet.facetId !== predicate.facetId || facet.unitId !== predicate.unitId) return false;
  if (predicate.operator === "includes") return Array.isArray(facet.value) && typeof predicate.value === "string" && facet.value.includes(predicate.value);
  if (predicate.operator === "eq") return facet.value === predicate.value;
  if (typeof facet.value !== "number") return false;
  if (predicate.operator === "gte") return typeof predicate.value === "number" && facet.value >= predicate.value;
  if (predicate.operator === "lte") return typeof predicate.value === "number" && facet.value <= predicate.value;
  return Array.isArray(predicate.value) && facet.value >= predicate.value[0] && facet.value <= predicate.value[1];
}

export async function queryRequirementCapabilityIndex(
  index: RequirementCapabilityIndex,
  query: RequirementCapabilityQuery,
): Promise<RequirementCapabilityIndexEntry[]> {
  const indexErrors = validateRequirementCapabilityIndex(index);
  if (indexErrors.length) throw new TypeError(`Invalid requirement capability index: ${indexErrors.join("; ")}`);
  if (!await verifyRequirementCapabilityIndex(index)) throw new TypeError("requirement capability index content hash mismatch");
  const queryErrors = validateQuery(query);
  if (queryErrors.length) throw new TypeError(`Invalid requirement capability query: ${queryErrors.join("; ")}`);
  if (!sameSnapshotRef(index.factSnapshotRef, query.factSnapshotRef)) throw new Error("requirement capability index fact snapshot mismatch");
  return index.entries
    .filter((entry) => entry.componentKindId === query.componentKindId)
    .filter((entry) => query.predicates.every((predicate) => predicateMatches(entry.facets.find((facet) => facet.facetId === predicate.facetId), predicate)))
    .map((entry) => structuredClone(entry));
}

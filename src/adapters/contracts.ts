import {
  validateHardwareAdapterManifest,
  type FacetId,
  type HardwareAdapterManifest,
} from "../contracts/registries";
import { hashContent } from "../hash";
import type { ConflictSet, FactRecord, FactSnapshot } from "../facts/contracts";
import type { FactRecordInput } from "../facts/hash";
import type { EvidenceClaim, EvidenceClaimLocator, EvidenceClaimSubject } from "../evidence/contracts";
import {
  createAssemblyResourcePattern,
  createBundleItem,
  validateAssemblyResourcePattern,
  validateBundleItemInput,
  verifyAssemblyResourcePattern,
  verifyBundleItem,
  type AssemblyResourcePattern,
  type AssemblyResourcePatternInput,
  type BundleItem,
  type BundleItemInput,
} from "../assembly/resources";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  isFiniteNonNegative,
  isPortableId,
  isPositiveSafeInteger,
  isSha256,
  isUniquePortableIdArray,
  normalizeNfcJson,
  safeRecord,
} from "../capabilities/validation";

/** Immutable, serializable legacy adapter registry state used by evaluation replay. */
export interface AdapterSnapshot {
  schemaVersion: "adapter-snapshot-v1";
  snapshotId: string;
  adapters: HardwareAdapterManifest[];
  createdAt: string;
  contentHash: string;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validateAdapterSnapshotValue(value: unknown): string[] {
  const snapshot = safeRecord(value);
  if (!snapshot) return ["adapter snapshot must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(snapshot, ["schemaVersion", "snapshotId", "adapters", "createdAt", "contentHash"])) errors.push("adapter snapshot contains unknown fields");
  if (snapshot.schemaVersion !== "adapter-snapshot-v1") errors.push("adapter snapshot schemaVersion invalid");
  if (!isPortableId(snapshot.snapshotId)) errors.push("adapter snapshot snapshotId invalid");
  if (!isIsoTimestamp(snapshot.createdAt)) errors.push("adapter snapshot createdAt invalid");
  if (!isSha256(snapshot.contentHash)) errors.push("adapter snapshot contentHash invalid");
  if (!Array.isArray(snapshot.adapters) || snapshot.adapters.length === 0) {
    errors.push("adapter snapshot requires at least one registered manifest");
  } else {
    const adapterIds: string[] = [];
    snapshot.adapters.forEach((adapter, index) => {
      const record = safeRecord(adapter);
      if (record && typeof record.adapterId === "string") adapterIds.push(record.adapterId);
      errors.push(...validateHardwareAdapterManifest(adapter).map((error) => `adapter snapshot adapters.${index}: ${error}`));
    });
    if (new Set(adapterIds).size !== adapterIds.length) errors.push("adapter snapshot adapterId values must be unique");
  }
  return errors;
}

/** Bind every legacy snapshot entry to the frozen serializable adapter registry. */
export function validateAdapterSnapshot(value: unknown): string[] {
  try { return validateAdapterSnapshotValue(value); }
  catch { return ["adapter snapshot validation failed"]; }
}

export interface CaseAdapterIdentity {
  skuId: string;
  region: string;
  revision: string;
  identityFactIds: string[];
}

/**
 * A verified binding has no geometric inference and therefore zero error.
 * Any reconstructed anchor is explicitly provisional, names its derivation,
 * and carries a positive symmetric error bound in millimetres.
 */
export interface CaseManifestBinding {
  status: "verified" | "provisional";
  sourceFactIds: string[];
  derivationIds: string[];
  uncertaintyMm: number;
}

export type Vec3Mm = [number, number, number];

export interface CaseSpatialNode {
  nodeId: string;
  centerMm: Vec3Mm;
  sizeMm: Vec3Mm;
  binding: CaseManifestBinding;
}

export type CaseMountKind = "motherboard" | "psu" | "drive" | "fan" | "radiator" | "pcie" | "backplane" | "accessory";

export interface CaseMount {
  mountId: string;
  kind: CaseMountKind;
  standardIds: string[];
  quantity: number;
  location: string;
  binding: CaseManifestBinding;
}

export interface CasePortAnchor {
  portId: string;
  connectorStandardId: string;
  direction: "input" | "output" | "bidirectional";
  quantity: number;
  anchorMm: Vec3Mm;
  binding: CaseManifestBinding;
}

export interface CaseRoutingZone {
  zoneId: string;
  kind: "free" | "channel" | "opening";
  centerMm: Vec3Mm;
  sizeMm: Vec3Mm;
  connectsToZoneIds: string[];
  binding: CaseManifestBinding;
}

export interface CaseAssemblyConstraint {
  constraintId: string;
  beforeActionId: string;
  afterActionId: string;
  binding: CaseManifestBinding;
}

export interface CaseCapabilityBinding {
  facetId: FacetId;
  sourceFactIds: string[];
}

export interface CaseGeometryManifest {
  envelope: CaseSpatialNode;
  interiorSpaces: CaseSpatialNode[];
  forbiddenZones: CaseSpatialNode[];
  serviceCorridors: CaseSpatialNode[];
}

export interface CaseAdapterManifestInput {
  schemaVersion: "case-adapter-manifest-v1";
  adapterId: string;
  adapterVersion: string;
  identity: CaseAdapterIdentity;
  capabilityBindings: CaseCapabilityBinding[];
  geometry: CaseGeometryManifest;
  mounts: CaseMount[];
  ports: CasePortAnchor[];
  routingZones: CaseRoutingZone[];
  assemblyConstraints: CaseAssemblyConstraint[];
  bundleItems: BundleItemInput[];
  resourcePatterns: AssemblyResourcePatternInput[];
  sourceRefs: string[];
}

export interface CaseAdapterManifest extends Omit<CaseAdapterManifestInput, "bundleItems" | "resourcePatterns"> {
  bundleItems: BundleItem[];
  resourcePatterns: AssemblyResourcePattern[];
  contentHash: string;
}

export interface CaseAdapterSeed {
  schemaVersion: "case-adapter-seed-v1";
  manifest: CaseAdapterManifestInput;
  factInputs: FactRecordInput[];
  evidenceSources: CaseAdapterEvidenceSourceSeed[];
  snapshotCreatedAt: string;
}

export interface CaseAdapterEvidenceSourceSeed {
  evidenceSourceId: string;
  authority: "official" | "third_party";
  subject: EvidenceClaimSubject;
  documentId: `doc-sha256-${string}`;
  documentSha256: string;
  captureId: `capture-sha256-${string}`;
  retrievedAt: string;
  factLocators: Array<{ factId: string; locator: EvidenceClaimLocator }>;
}

export interface CaseAdapterFactClosure {
  snapshot: FactSnapshot;
  facts: FactRecord[];
  conflicts: ConflictSet[];
  evidenceClaims: EvidenceClaim[];
}

const CASE_ADAPTER_CONTRACT = Object.freeze({ domain: "artifact.adapter-snapshot", schemaVersion: "1.0.0" } as const);
const MOUNT_KINDS = new Set<CaseMountKind>(["motherboard", "psu", "drive", "fan", "radiator", "pcie", "backplane", "accessory"]);
const ROUTING_KINDS = new Set<CaseRoutingZone["kind"]>(["free", "channel", "opening"]);

function uniqueIdErrors(values: readonly unknown[], idField: string, label: string): string[] {
  const ids = values.map((value) => safeRecord(value)?.[idField]).filter((id): id is string => typeof id === "string");
  return ids.length === values.length && new Set(ids).size === ids.length ? [] : [`${label} IDs must be unique and valid`];
}

function validateVec3(value: unknown, label: string, positive: boolean): string[] {
  return Array.isArray(value) && value.length === 3
    && value.every((item) => typeof item === "number" && Number.isFinite(item) && (!positive || item > 0))
    ? [] : [`${label} invalid`];
}

export function validateCaseManifestBinding(value: unknown): string[] {
  const binding = safeRecord(value);
  if (!binding) return ["case manifest binding must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(binding, ["status", "sourceFactIds", "derivationIds", "uncertaintyMm"])) errors.push("case manifest binding contains unknown or missing fields");
  if (!isUniquePortableIdArray(binding.sourceFactIds)) errors.push("case manifest binding sourceFactIds invalid");
  if (!isUniquePortableIdArray(binding.derivationIds, false)) errors.push("case manifest binding derivationIds invalid");
  if (!isFiniteNonNegative(binding.uncertaintyMm)) errors.push("case manifest binding uncertainty invalid");
  if (binding.status === "verified") {
    if (binding.uncertaintyMm !== 0) errors.push("verified binding uncertainty must be zero");
    if (Array.isArray(binding.derivationIds) && binding.derivationIds.length !== 0) errors.push("verified binding cannot carry derivation IDs");
  } else if (binding.status === "provisional") {
    if (!(typeof binding.uncertaintyMm === "number" && binding.uncertaintyMm > 0)) errors.push("provisional binding requires positive uncertainty");
    if (!Array.isArray(binding.derivationIds) || binding.derivationIds.length === 0) errors.push("provisional binding requires a derivation ID");
  } else errors.push("case manifest binding status invalid");
  return errors;
}

function validateSpatialNode(value: unknown, label: string): string[] {
  const node = safeRecord(value);
  if (!node) return [`${label} must be an object`];
  const errors: string[] = [];
  if (!hasExactKeys(node, ["nodeId", "centerMm", "sizeMm", "binding"])) errors.push(`${label} contains unknown or missing fields`);
  if (!isPortableId(node.nodeId)) errors.push(`${label} nodeId invalid`);
  errors.push(...validateVec3(node.centerMm, `${label} center`, false));
  errors.push(...validateVec3(node.sizeMm, `${label} size`, true));
  errors.push(...validateCaseManifestBinding(node.binding).map((error) => `${label} ${error}`));
  return errors;
}

function validateMount(value: unknown, index: number): string[] {
  const mount = safeRecord(value);
  const label = `mounts.${index}`;
  if (!mount) return [`${label} must be an object`];
  const errors: string[] = [];
  if (!hasExactKeys(mount, ["mountId", "kind", "standardIds", "quantity", "location", "binding"])) errors.push(`${label} contains unknown or missing fields`);
  if (!isPortableId(mount.mountId) || !MOUNT_KINDS.has(mount.kind as CaseMountKind) || !isPortableId(mount.location)) errors.push(`${label} identity invalid`);
  if (!isUniquePortableIdArray(mount.standardIds) || !isPositiveSafeInteger(mount.quantity, 4096)) errors.push(`${label} standards/quantity invalid`);
  errors.push(...validateCaseManifestBinding(mount.binding).map((error) => `${label} ${error}`));
  return errors;
}

function validatePort(value: unknown, index: number): string[] {
  const port = safeRecord(value);
  const label = `ports.${index}`;
  if (!port) return [`${label} must be an object`];
  const errors: string[] = [];
  if (!hasExactKeys(port, ["portId", "connectorStandardId", "direction", "quantity", "anchorMm", "binding"])) errors.push(`${label} contains unknown or missing fields`);
  if (!isPortableId(port.portId) || !isPortableId(port.connectorStandardId)
    || !["input", "output", "bidirectional"].includes(String(port.direction))) errors.push(`${label} identity invalid`);
  if (!isPositiveSafeInteger(port.quantity, 4096)) errors.push(`${label} quantity invalid`);
  errors.push(...validateVec3(port.anchorMm, `${label} anchor`, false));
  errors.push(...validateCaseManifestBinding(port.binding).map((error) => `${label} ${error}`));
  return errors;
}

function validateRoutingZone(value: unknown, index: number): string[] {
  const zone = safeRecord(value);
  const label = `routingZones.${index}`;
  if (!zone) return [`${label} must be an object`];
  const errors: string[] = [];
  if (!hasExactKeys(zone, ["zoneId", "kind", "centerMm", "sizeMm", "connectsToZoneIds", "binding"])) errors.push(`${label} contains unknown or missing fields`);
  if (!isPortableId(zone.zoneId) || !ROUTING_KINDS.has(zone.kind as CaseRoutingZone["kind"])) errors.push(`${label} identity invalid`);
  errors.push(...validateVec3(zone.centerMm, `${label} center`, false));
  errors.push(...validateVec3(zone.sizeMm, `${label} size`, true));
  if (!isUniquePortableIdArray(zone.connectsToZoneIds, false)) errors.push(`${label} connectsToZoneIds invalid`);
  errors.push(...validateCaseManifestBinding(zone.binding).map((error) => `${label} ${error}`));
  return errors;
}

function validateConstraint(value: unknown, index: number): string[] {
  const constraint = safeRecord(value);
  const label = `assemblyConstraints.${index}`;
  if (!constraint) return [`${label} must be an object`];
  const errors: string[] = [];
  if (!hasExactKeys(constraint, ["constraintId", "beforeActionId", "afterActionId", "binding"])) errors.push(`${label} contains unknown or missing fields`);
  if (![constraint.constraintId, constraint.beforeActionId, constraint.afterActionId].every(isPortableId)) errors.push(`${label} identity invalid`);
  if (constraint.beforeActionId === constraint.afterActionId) errors.push(`${label} actions must differ`);
  errors.push(...validateCaseManifestBinding(constraint.binding).map((error) => `${label} ${error}`));
  return errors;
}

function validateIdentity(value: unknown): string[] {
  const identity = safeRecord(value);
  if (!identity) return ["case adapter identity must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(identity, ["skuId", "region", "revision", "identityFactIds"])) errors.push("case adapter identity contains unknown or missing fields");
  if (![identity.skuId, identity.region, identity.revision].every(isPortableId)) errors.push("case adapter exact identity invalid");
  if (!isUniquePortableIdArray(identity.identityFactIds)) errors.push("case adapter identityFactIds invalid");
  return errors;
}

function validateCapabilityBinding(value: unknown, index: number): string[] {
  const binding = safeRecord(value);
  const label = `capabilityBindings.${index}`;
  if (!binding) return [`${label} must be an object`];
  const errors: string[] = [];
  if (!hasExactKeys(binding, ["facetId", "sourceFactIds"])) errors.push(`${label} contains unknown or missing fields`);
  if (typeof binding.facetId !== "string") errors.push(`${label} facetId invalid`);
  else {
    // validateCapabilityFacet will enforce the same registry at projection time;
    // here a key lookup avoids accepting caller-defined property names.
    const registry = (awaitlessFacetRegistry as Readonly<Record<string, unknown>>);
    if (!Object.prototype.hasOwnProperty.call(registry, binding.facetId)) errors.push(`${label} facetId is not allowlisted`);
  }
  if (!isUniquePortableIdArray(binding.sourceFactIds)) errors.push(`${label} sourceFactIds invalid`);
  return errors;
}

// Kept as a local alias so validation remains synchronous and total.
import { FACET_REGISTRY as awaitlessFacetRegistry } from "../contracts/registries";

function validateGeometry(value: unknown): string[] {
  const geometry = safeRecord(value);
  if (!geometry) return ["geometry must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(geometry, ["envelope", "interiorSpaces", "forbiddenZones", "serviceCorridors"])) errors.push("geometry contains unknown or missing fields");
  errors.push(...validateSpatialNode(geometry.envelope, "geometry envelope"));
  for (const [field, allowEmpty] of [["interiorSpaces", false], ["forbiddenZones", true], ["serviceCorridors", true]] as const) {
    const nodes = geometry[field];
    if (!Array.isArray(nodes) || (!allowEmpty && nodes.length === 0)) errors.push(`geometry ${field} invalid`);
    else {
      nodes.forEach((node, index) => errors.push(...validateSpatialNode(node, `geometry ${field}.${index}`)));
      errors.push(...uniqueIdErrors(nodes, "nodeId", `geometry ${field}`));
    }
  }
  const all = [geometry.envelope, ...(Array.isArray(geometry.interiorSpaces) ? geometry.interiorSpaces : []), ...(Array.isArray(geometry.forbiddenZones) ? geometry.forbiddenZones : []), ...(Array.isArray(geometry.serviceCorridors) ? geometry.serviceCorridors : [])];
  errors.push(...uniqueIdErrors(all, "nodeId", "geometry"));
  return errors;
}

function spatialNodeInsideEnvelope(nodeValue: unknown, envelopeValue: unknown): boolean {
  const node = safeRecord(nodeValue);
  const envelope = safeRecord(envelopeValue);
  const nodeCenter = node?.centerMm;
  const nodeSize = node?.sizeMm;
  const envelopeCenterValue = envelope?.centerMm;
  const envelopeSizeValue = envelope?.sizeMm;
  if (!Array.isArray(nodeCenter) || !Array.isArray(nodeSize)
    || !Array.isArray(envelopeCenterValue) || !Array.isArray(envelopeSizeValue)
    || nodeCenter.length !== 3 || nodeSize.length !== 3 || envelopeCenterValue.length !== 3 || envelopeSizeValue.length !== 3) return false;
  return [0, 1, 2].every((axis) => {
    const center = Number(nodeCenter[axis]);
    const size = Number(nodeSize[axis]);
    const envelopeCenter = Number(envelopeCenterValue[axis]);
    const envelopeSize = Number(envelopeSizeValue[axis]);
    return [center, size, envelopeCenter, envelopeSize].every(Number.isFinite)
      && size > 0 && envelopeSize > 0
      && Math.abs(center - envelopeCenter) + size / 2 <= envelopeSize / 2 + 1e-9;
  });
}

function pointInsideEnvelope(pointValue: unknown, envelopeValue: unknown): boolean {
  const envelope = safeRecord(envelopeValue);
  const envelopeCenterValue = envelope?.centerMm;
  const envelopeSizeValue = envelope?.sizeMm;
  if (!Array.isArray(pointValue) || pointValue.length !== 3
    || !Array.isArray(envelopeCenterValue) || !Array.isArray(envelopeSizeValue)
    || envelopeCenterValue.length !== 3 || envelopeSizeValue.length !== 3) return false;
  return [0, 1, 2].every((axis) => {
    const point = Number(pointValue[axis]);
    const center = Number(envelopeCenterValue[axis]);
    const size = Number(envelopeSizeValue[axis]);
    return [point, center, size].every(Number.isFinite) && size > 0 && Math.abs(point - center) <= size / 2 + 1e-9;
  });
}

function assemblyConstraintCycle(entries: readonly unknown[]): boolean {
  const adjacency = new Map<string, Set<string>>();
  for (const entry of entries) {
    const record = safeRecord(entry);
    if (!record || typeof record.beforeActionId !== "string" || typeof record.afterActionId !== "string") continue;
    const targets = adjacency.get(record.beforeActionId) ?? new Set<string>();
    targets.add(record.afterActionId);
    adjacency.set(record.beforeActionId, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of adjacency.get(node) ?? []) if (visit(target)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...adjacency.keys()].some(visit);
}

function validateManifestUnsafe(value: unknown, requireHash: boolean): string[] {
  const manifest = safeRecord(value);
  if (!manifest) return ["case adapter manifest must be an object"];
  const required = [
    "schemaVersion", "adapterId", "adapterVersion", "identity", "capabilityBindings", "geometry", "mounts", "ports",
    "routingZones", "assemblyConstraints", "bundleItems", "resourcePatterns", "sourceRefs",
  ];
  const errors: string[] = [];
  if (!hasExactKeys(manifest, required, requireHash ? ["contentHash"] : []) || (requireHash && !("contentHash" in manifest))) errors.push("case adapter manifest contains unknown or missing fields");
  if (containsNonNfcText(manifest)) errors.push("case adapter manifest contains non-NFC text");
  if (manifest.schemaVersion !== "case-adapter-manifest-v1" || !isPortableId(manifest.adapterId) || !isPortableId(manifest.adapterVersion)) errors.push("case adapter manifest identity/version invalid");
  errors.push(...validateIdentity(manifest.identity));
  if (!Array.isArray(manifest.capabilityBindings) || manifest.capabilityBindings.length === 0) errors.push("case adapter capabilityBindings invalid");
  else {
    manifest.capabilityBindings.forEach((binding, index) => errors.push(...validateCapabilityBinding(binding, index)));
    errors.push(...uniqueIdErrors(manifest.capabilityBindings, "facetId", "capability binding"));
  }
  errors.push(...validateGeometry(manifest.geometry));
  for (const [field, validator, allowEmpty] of [
    ["mounts", validateMount, false], ["ports", validatePort, false], ["routingZones", validateRoutingZone, true], ["assemblyConstraints", validateConstraint, true],
  ] as const) {
    const entries = manifest[field];
    if (!Array.isArray(entries) || (!allowEmpty && entries.length === 0)) errors.push(`case adapter ${field} invalid`);
    else {
      entries.forEach((entry, index) => errors.push(...validator(entry, index)));
      const idField = field === "mounts" ? "mountId" : field === "ports" ? "portId" : field === "routingZones" ? "zoneId" : "constraintId";
      errors.push(...uniqueIdErrors(entries, idField, field));
    }
  }
  if (Array.isArray(manifest.routingZones)) {
    const zoneIds = new Set(manifest.routingZones.map((zone) => safeRecord(zone)?.zoneId));
    for (const zone of manifest.routingZones) {
      const record = safeRecord(zone);
      if (record && Array.isArray(record.connectsToZoneIds)
        && record.connectsToZoneIds.some((id) => id === record.zoneId || !zoneIds.has(id))) errors.push(`routing zone ${String(record.zoneId)} has invalid connection`);
    }
  }
  const geometry = safeRecord(manifest.geometry);
  const envelope = geometry?.envelope;
  if (geometry && envelope) {
    for (const field of ["interiorSpaces", "forbiddenZones", "serviceCorridors"] as const) {
      const nodes = geometry[field];
      if (Array.isArray(nodes)) nodes.forEach((node, index) => {
        if (!spatialNodeInsideEnvelope(node, envelope)) errors.push(`geometry ${field}.${index} exceeds case envelope`);
      });
    }
    if (Array.isArray(manifest.routingZones)) manifest.routingZones.forEach((zone, index) => {
      if (!spatialNodeInsideEnvelope(zone, envelope)) errors.push(`routingZones.${index} exceeds case envelope`);
    });
    if (Array.isArray(manifest.ports)) manifest.ports.forEach((port, index) => {
      const portRecord = safeRecord(port);
      if (!portRecord || !pointInsideEnvelope(portRecord.anchorMm, envelope)) errors.push(`ports.${index} anchor exceeds case envelope`);
    });
  }
  if (Array.isArray(manifest.assemblyConstraints) && assemblyConstraintCycle(manifest.assemblyConstraints)) {
    errors.push("assembly constraints contain a dependency cycle");
  }
  if (!Array.isArray(manifest.bundleItems)) errors.push("case adapter bundleItems invalid");
  else manifest.bundleItems.forEach((item, index) => {
    const itemErrors = requireHash
      ? (safeRecord(item) && isSha256(safeRecord(item)?.contentHash) ? [] : ["bundle item contentHash invalid"])
      : validateBundleItemInput(item);
    errors.push(...itemErrors.map((error) => `bundleItems.${index}: ${error}`));
    const record = safeRecord(item);
    const identity = safeRecord(manifest.identity);
    if (record && identity && (record.ownerSkuId !== identity.skuId || record.region !== identity.region || record.revision !== identity.revision)) {
      errors.push(`bundleItems.${index}: exact owner SKU/region/revision mismatch`);
    }
  });
  if (!Array.isArray(manifest.resourcePatterns)) errors.push("case adapter resourcePatterns invalid");
  else if (requireHash) manifest.resourcePatterns.forEach((pattern, index) => errors.push(...validateAssemblyResourcePattern(pattern).map((error) => `resourcePatterns.${index}: ${error}`)));
  else manifest.resourcePatterns.forEach((pattern, index) => {
    const record = safeRecord(pattern);
    if (!record || record.schemaVersion !== "assembly-resource-pattern-v1" || !isPortableId(record.patternId)) errors.push(`resourcePatterns.${index}: input invalid`);
  });
  if (!isUniquePortableIdArray(manifest.sourceRefs)) errors.push("case adapter sourceRefs invalid");
  if (requireHash && !isSha256(manifest.contentHash)) errors.push("case adapter contentHash invalid");
  return errors;
}

export function validateCaseAdapterManifestInput(value: unknown): string[] {
  try { return validateManifestUnsafe(value, false); }
  catch { return ["case adapter manifest input is inaccessible or invalid"]; }
}

export function validateCaseAdapterManifest(value: unknown): string[] {
  try { return validateManifestUnsafe(value, true); }
  catch { return ["case adapter manifest is inaccessible or invalid"]; }
}

function normalizeBinding(binding: CaseManifestBinding): CaseManifestBinding {
  return {
    ...binding,
    sourceFactIds: [...binding.sourceFactIds].sort(compareCanonical),
    derivationIds: [...binding.derivationIds].sort(compareCanonical),
  };
}

function normalizeSpatial(node: CaseSpatialNode): CaseSpatialNode {
  return { ...node, centerMm: [...node.centerMm] as Vec3Mm, sizeMm: [...node.sizeMm] as Vec3Mm, binding: normalizeBinding(node.binding) };
}

function stripManifestHashes(value: CaseAdapterManifestInput | CaseAdapterManifest): CaseAdapterManifestInput {
  const cloned = structuredClone(value) as CaseAdapterManifest;
  const { contentHash: _manifestHash, ...withoutManifestHash } = cloned;
  const bundleItems = cloned.bundleItems.map((item) => {
    const { contentHash: _bundleHash, ...result } = item;
    return result;
  });
  const resourcePatterns = cloned.resourcePatterns.map((pattern) => {
    const { contentHash: _patternHash, ...result } = pattern;
    return result;
  });
  return { ...withoutManifestHash, bundleItems, resourcePatterns };
}

function normalizeManifestInput(input: CaseAdapterManifestInput): CaseAdapterManifestInput {
  const normalized = normalizeNfcJson(input);
  normalized.identity.identityFactIds.sort(compareCanonical);
  normalized.capabilityBindings = normalized.capabilityBindings.map((binding) => ({ ...binding, sourceFactIds: [...binding.sourceFactIds].sort(compareCanonical) }))
    .sort((left, right) => compareCanonical(left.facetId, right.facetId));
  normalized.geometry = {
    envelope: normalizeSpatial(normalized.geometry.envelope),
    interiorSpaces: normalized.geometry.interiorSpaces.map(normalizeSpatial).sort((left, right) => compareCanonical(left.nodeId, right.nodeId)),
    forbiddenZones: normalized.geometry.forbiddenZones.map(normalizeSpatial).sort((left, right) => compareCanonical(left.nodeId, right.nodeId)),
    serviceCorridors: normalized.geometry.serviceCorridors.map(normalizeSpatial).sort((left, right) => compareCanonical(left.nodeId, right.nodeId)),
  };
  normalized.mounts = normalized.mounts.map((mount) => ({ ...mount, standardIds: [...mount.standardIds].sort(compareCanonical), binding: normalizeBinding(mount.binding) }))
    .sort((left, right) => compareCanonical(left.mountId, right.mountId));
  normalized.ports = normalized.ports.map((port) => ({ ...port, anchorMm: [...port.anchorMm] as Vec3Mm, binding: normalizeBinding(port.binding) }))
    .sort((left, right) => compareCanonical(left.portId, right.portId));
  normalized.routingZones = normalized.routingZones.map((zone) => ({
    ...zone, centerMm: [...zone.centerMm] as Vec3Mm, sizeMm: [...zone.sizeMm] as Vec3Mm, connectsToZoneIds: [...zone.connectsToZoneIds].sort(compareCanonical), binding: normalizeBinding(zone.binding),
  })).sort((left, right) => compareCanonical(left.zoneId, right.zoneId));
  normalized.assemblyConstraints = normalized.assemblyConstraints.map((constraint) => ({ ...constraint, binding: normalizeBinding(constraint.binding) }))
    .sort((left, right) => compareCanonical(left.constraintId, right.constraintId));
  normalized.sourceRefs.sort(compareCanonical);
  return normalized;
}

export async function caseAdapterManifestContentHash(value: CaseAdapterManifestInput | CaseAdapterManifest): Promise<string> {
  return hashContent(value, CASE_ADAPTER_CONTRACT);
}

export async function createCaseAdapterManifest(value: CaseAdapterManifestInput | CaseAdapterManifest): Promise<CaseAdapterManifest> {
  const normalized = normalizeManifestInput(stripManifestHashes(value));
  const errors = validateCaseAdapterManifestInput(normalized);
  if (errors.length) throw new TypeError(`Invalid case adapter manifest: ${errors.join("; ")}`);
  const bundleItems = await Promise.all(normalized.bundleItems.map(createBundleItem));
  bundleItems.sort((left, right) => compareCanonical(left.bundleItemId, right.bundleItemId));
  const resourcePatterns = await Promise.all(normalized.resourcePatterns.map(createAssemblyResourcePattern));
  resourcePatterns.sort((left, right) => compareCanonical(left.patternId, right.patternId));
  const material = { ...normalized, bundleItems, resourcePatterns };
  const manifest: CaseAdapterManifest = { ...material, contentHash: await caseAdapterManifestContentHash(material) };
  const manifestErrors = validateCaseAdapterManifest(manifest);
  if (manifestErrors.length) throw new TypeError(`Invalid case adapter manifest: ${manifestErrors.join("; ")}`);
  return deepFreeze(manifest) as CaseAdapterManifest;
}

export async function verifyCaseAdapterManifest(value: unknown): Promise<boolean> {
  if (validateCaseAdapterManifest(value).length) return false;
  const manifest = value as CaseAdapterManifest;
  if (!(await Promise.all(manifest.bundleItems.map(verifyBundleItem))).every(Boolean)) return false;
  if (!(await Promise.all(manifest.resourcePatterns.map(verifyAssemblyResourcePattern))).every(Boolean)) return false;
  return manifest.contentHash === await caseAdapterManifestContentHash(manifest);
}

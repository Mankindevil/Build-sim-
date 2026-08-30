import type { ObservationFieldId } from "../contracts/registries";
import { hashContent, isSha256Hex, legacySha256Hex } from "../hash";
import {
  canProjectUserObservation,
  validateUserObservation,
  validateUserObservationSnapshot,
  type ObservationSubjectRef,
  type ObservationUncertainty,
  type UserObservation,
} from "../observations/contracts";
import { validateCaseInstanceOverridesRuntime } from "../observations/canonical-runtime.mjs";
import type { ResolvedObservationRepositorySnapshotClosure } from "../observations/repository";
import {
  resolveObservationProjectionContext,
  type CaseObservationAnchorScope,
} from "../observations/subject-resolution";
import { canonicalJson } from "../plans/canonical";
import { validateBuildConfigV3, type BuildConfigV3 } from "../topology/contracts";
import {
  compareCanonical,
  deepFreeze,
  hasExactKeys,
  isPortableId,
  safeRecord,
} from "../capabilities/validation";
import {
  verifyCaseAdapterManifest,
  type CaseAdapterManifest,
} from "./contracts";

const SPATIAL_HASH_CONTRACT = Object.freeze({ domain: "spatial-topology", schemaVersion: "1.0.0" } as const);
const CONTENT_HASH_CONTRACT = Object.freeze({ domain: "artifact", schemaVersion: "1.0.0" } as const);

type OverrideTargetKind = "envelope" | "anchor" | "routing" | "clearance" | "pose";
type OverrideProperty =
  | "width" | "height" | "depth"
  | "x" | "y" | "z"
  | "roll" | "pitch" | "yaw"
  | "clearance";

export type CaseInstanceOverrideFieldId = Extract<ObservationFieldId,
  | "physical.clearance"
  | "case.envelope.width" | "case.envelope.height" | "case.envelope.depth"
  | "case.anchor.x" | "case.anchor.y" | "case.anchor.z"
  | "case.routing.width" | "case.routing.height" | "case.routing.depth"
  | "case.pose.x" | "case.pose.y" | "case.pose.z"
  | "case.pose.roll" | "case.pose.pitch" | "case.pose.yaw"
>;

interface OverrideFieldDefinition {
  targetKind: OverrideTargetKind;
  property: OverrideProperty;
  unit: "mm" | "degree";
  subjectKinds: readonly ObservationSubjectRef["kind"][];
}

/** The only user-observation fields that may alter an instance spatial input. */
export const CASE_INSTANCE_OVERRIDE_FIELD_REGISTRY = deepFreeze({
  "physical.clearance": { targetKind: "clearance", property: "clearance", unit: "mm", subjectKinds: ["placement", "connection", "mount", "port"] },
  "case.envelope.width": { targetKind: "envelope", property: "width", unit: "mm", subjectKinds: ["instance"] },
  "case.envelope.height": { targetKind: "envelope", property: "height", unit: "mm", subjectKinds: ["instance"] },
  "case.envelope.depth": { targetKind: "envelope", property: "depth", unit: "mm", subjectKinds: ["instance"] },
  "case.anchor.x": { targetKind: "anchor", property: "x", unit: "mm", subjectKinds: ["mount", "port"] },
  "case.anchor.y": { targetKind: "anchor", property: "y", unit: "mm", subjectKinds: ["mount", "port"] },
  "case.anchor.z": { targetKind: "anchor", property: "z", unit: "mm", subjectKinds: ["mount", "port"] },
  "case.routing.width": { targetKind: "routing", property: "width", unit: "mm", subjectKinds: ["mount", "port", "connection"] },
  "case.routing.height": { targetKind: "routing", property: "height", unit: "mm", subjectKinds: ["mount", "port", "connection"] },
  "case.routing.depth": { targetKind: "routing", property: "depth", unit: "mm", subjectKinds: ["mount", "port", "connection"] },
  "case.pose.x": { targetKind: "pose", property: "x", unit: "mm", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.y": { targetKind: "pose", property: "y", unit: "mm", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.z": { targetKind: "pose", property: "z", unit: "mm", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.roll": { targetKind: "pose", property: "roll", unit: "degree", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.pitch": { targetKind: "pose", property: "pitch", unit: "degree", subjectKinds: ["placement", "mount", "port"] },
  "case.pose.yaw": { targetKind: "pose", property: "yaw", unit: "degree", subjectKinds: ["placement", "mount", "port"] },
} as const satisfies Record<CaseInstanceOverrideFieldId, OverrideFieldDefinition>);

export interface CaseInstanceOverrideEntry {
  observationId: string;
  observationRecordHash: string;
  subjectRef: ObservationSubjectRef;
  subjectRevisionHash: string;
  fieldId: CaseInstanceOverrideFieldId;
  targetKind: OverrideTargetKind;
  property: OverrideProperty;
  value: number;
  unit: "mm" | "degree";
  uncertainty: ObservationUncertainty;
}

export interface CaseInstanceOverrides {
  schemaVersion: "case-instance-overrides-v1";
  planId: string;
  instanceId: string;
  subjectRevisionHash: string;
  observationSnapshotId: string;
  observationSnapshotHash: string;
  baseManifestHash: string;
  baseProjectionHash: string;
  overrides: CaseInstanceOverrideEntry[];
  spatialHash: string;
  contentHash: string;
}

export interface CaseInstanceOverrideRequest {
  planId: string;
  instanceId: string;
  observationSnapshotId: string;
  observationSnapshotHash: string;
  baseManifestHash: string;
  baseProjectionHash: string;
}

export interface CaseInstanceOverrideRootClosure {
  config: BuildConfigV3;
  baseManifest: CaseAdapterManifest;
  baseProjectionHash: string;
  observationClosure: ResolvedObservationRepositorySnapshotClosure;
}

/**
 * Production trust seam. Its implementation owns the active-root plan,
 * observation and locked-adapter repositories. It must resolve a *current*
 * snapshot closure (for example ObservationRepository's
 * getCurrentSnapshotClosureAtRoot), not merely a readable historical one.
 */
export interface RootBoundCaseInstanceOverrideAuthority {
  readonly authorityKind: "case-instance-override-root-bound-v1";
  resolveCaseInstanceOverrideClosureAtRoot(
    activeRoot: string,
    request: Readonly<CaseInstanceOverrideRequest>,
  ): Promise<CaseInstanceOverrideRootClosure | null>;
}

function requestErrors(value: unknown): string[] {
  const request = safeRecord(value);
  if (!request || !hasExactKeys(request, [
    "planId", "instanceId", "observationSnapshotId", "observationSnapshotHash", "baseManifestHash", "baseProjectionHash",
  ])) return ["case instance override request shape invalid"];
  const errors: string[] = [];
  for (const field of ["planId", "instanceId", "observationSnapshotId"] as const) {
    if (!isPortableId(request[field])) errors.push(`case instance override request ${field} invalid`);
  }
  for (const field of ["observationSnapshotHash", "baseManifestHash", "baseProjectionHash"] as const) {
    if (!isSha256Hex(request[field])) errors.push(`case instance override request ${field} invalid`);
  }
  return errors;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fieldDefinition(fieldId: ObservationFieldId): OverrideFieldDefinition | null {
  return Object.prototype.hasOwnProperty.call(CASE_INSTANCE_OVERRIDE_FIELD_REGISTRY, fieldId)
    ? CASE_INSTANCE_OVERRIDE_FIELD_REGISTRY[fieldId as CaseInstanceOverrideFieldId]
    : null;
}

function subjectTargetsCase(
  subject: ObservationSubjectRef,
  config: BuildConfigV3,
  instanceId: string,
): boolean {
  if (subject.kind === "instance" || subject.kind === "port" || subject.kind === "firmware_instance") {
    return subject.instanceId === instanceId;
  }
  if (subject.kind === "mount") return subject.ownerInstanceId === instanceId;
  if (subject.kind === "placement") {
    return config.placements.find((entry) => entry.placementId === subject.placementId)?.mountOwnerInstanceId === instanceId;
  }
  if (subject.kind === "connection") {
    const connection = config.connections.find((entry) => entry.connectionId === subject.connectionId);
    return connection?.from.instanceId === instanceId || connection?.to.instanceId === instanceId;
  }
  return false;
}

function hasLockedAnchor(
  subject: ObservationSubjectRef,
  config: BuildConfigV3,
  manifest: CaseAdapterManifest,
  instanceId: string,
): boolean {
  if (subject.kind === "mount") return subject.ownerInstanceId === instanceId
    && manifest.mounts.some((entry) => entry.mountId === subject.mountId);
  if (subject.kind === "port") return subject.instanceId === instanceId
    && manifest.ports.some((entry) => entry.portId === subject.portId);
  if (subject.kind === "placement") {
    const placement = config.placements.find((entry) => entry.placementId === subject.placementId);
    return Boolean(placement && placement.mountOwnerInstanceId === instanceId
      && manifest.mounts.some((entry) => entry.mountId === placement.mountId));
  }
  if (subject.kind === "connection") {
    const connection = config.connections.find((entry) => entry.connectionId === subject.connectionId);
    if (!connection) return false;
    const caseEndpoints = [connection.from, connection.to].filter((endpoint) => endpoint.instanceId === instanceId);
    return caseEndpoints.length > 0 && caseEndpoints.every((endpoint) => manifest.ports.some((entry) => entry.portId === endpoint.portId));
  }
  return subject.kind === "instance" && subject.instanceId === instanceId;
}

function entrySortKey(entry: Pick<CaseInstanceOverrideEntry, "targetKind" | "subjectRef" | "property" | "observationId">): string {
  return canonicalJson([entry.targetKind, entry.subjectRef, entry.property, entry.observationId]);
}

function targetSlotKey(entry: Pick<CaseInstanceOverrideEntry, "targetKind" | "subjectRef" | "property">): string {
  return canonicalJson([entry.targetKind, entry.subjectRef, entry.property]);
}

async function assertObservationClosure(
  planId: string,
  closure: ResolvedObservationRepositorySnapshotClosure,
): Promise<void> {
  if (!closure || validateUserObservationSnapshot(closure.snapshot).length
    || closure.snapshot.planId !== planId
    || closure.snapshot.contentHash !== await hashContent(closure.snapshot, {
      domain: "user-observation-snapshot",
      schemaVersion: "user-observation-snapshot-v1",
    })) throw new TypeError("case instance override observation snapshot integrity invalid");
  if (!Array.isArray(closure.observations)
    || closure.observations.length !== closure.snapshot.observationIds.length) {
    throw new TypeError("case instance override observation closure is incomplete");
  }
  const byId = new Map(closure.observations.map((entry) => [entry.observation?.observationId, entry]));
  if (byId.size !== closure.observations.length) throw new TypeError("case instance override observation closure has duplicate IDs");
  for (const observationId of closure.snapshot.observationIds) {
    const record = byId.get(observationId);
    if (!record || !hasExactKeys(safeRecord(record) ?? {}, ["recordHash", "observation", "projectionContext", "attachmentClosureVerified"])
      || record.attachmentClosureVerified !== true
      || record.observation.planId !== planId
      || validateUserObservation(record.observation).length
      || record.observation.status !== "active" || !record.observation.confirmedByUser
      || record.observation.validatedAt === undefined || record.observation.invalidatedAt !== undefined
      || !canProjectUserObservation(record.observation, record.projectionContext)
      || closure.snapshot.observationRecordHashes?.[observationId] !== record.recordHash
      || record.recordHash !== await legacySha256Hex(record.observation)) {
      throw new TypeError("case instance override observation closure contains a non-current record");
    }
    const { contentHash: _ignored, ...base } = record.observation;
    if (record.observation.contentHash !== await legacySha256Hex(base)) {
      throw new TypeError("case instance override observation content hash invalid");
    }
  }
}

async function caseSpatialSubjectRevision(config: BuildConfigV3, instanceId: string): Promise<string> {
  const component = config.components.find((entry) => entry.instanceId === instanceId)!;
  const placements = config.placements
    .filter((entry) => entry.mountOwnerInstanceId === instanceId)
    .sort((left, right) => compareCanonical(left.placementId, right.placementId));
  const connections = config.connections
    .filter((entry) => entry.from.instanceId === instanceId || entry.to.instanceId === instanceId)
    .sort((left, right) => compareCanonical(left.connectionId, right.connectionId));
  return hashContent({ component, placements, connections }, SPATIAL_HASH_CONTRACT);
}

function spatialHashMaterial(value: Omit<CaseInstanceOverrides, "spatialHash" | "contentHash">): unknown {
  return {
    schemaVersion: "case-instance-spatial-input-v1",
    planId: value.planId,
    instanceId: value.instanceId,
    subjectRevisionHash: value.subjectRevisionHash,
    observationSnapshotHash: value.observationSnapshotHash,
    baseManifestHash: value.baseManifestHash,
    baseProjectionHash: value.baseProjectionHash,
    overrides: value.overrides,
  };
}

/**
 * Pure, immutable production resolver. All mutable authorities are read once
 * through the same active-root seam; this function never writes a registry,
 * manifest, observation, config, or adapterSnapshot artifact.
 */
export async function resolveCaseInstanceOverridesAtRoot(
  activeRoot: string,
  request: CaseInstanceOverrideRequest,
  authority: RootBoundCaseInstanceOverrideAuthority,
): Promise<CaseInstanceOverrides> {
  if (typeof activeRoot !== "string" || !activeRoot.startsWith("/") || activeRoot.includes("\0")) {
    throw new TypeError("case instance override active root invalid");
  }
  const errors = requestErrors(request);
  if (errors.length) throw new TypeError(errors.join("; "));
  if (!authority || authority.authorityKind !== "case-instance-override-root-bound-v1"
    || typeof authority.resolveCaseInstanceOverrideClosureAtRoot !== "function") {
    throw new TypeError("root-bound case instance override authority is required");
  }
  const resolved = await authority.resolveCaseInstanceOverrideClosureAtRoot(activeRoot, deepFreeze(structuredClone(request)));
  const resolvedRecord = safeRecord(resolved);
  if (!resolvedRecord || !hasExactKeys(resolvedRecord, ["config", "baseManifest", "baseProjectionHash", "observationClosure"])) {
    throw new TypeError("case instance override root closure unavailable or invalid");
  }
  const { config, baseManifest, baseProjectionHash, observationClosure } = resolved as CaseInstanceOverrideRootClosure;
  if (validateBuildConfigV3(config).length || config.id !== request.planId) {
    throw new TypeError("case instance override config invalid or cross-plan");
  }
  if (!await verifyCaseAdapterManifest(baseManifest)
    || baseManifest.contentHash !== request.baseManifestHash
    || baseProjectionHash !== request.baseProjectionHash) {
    throw new TypeError("case instance override locked adapter binding invalid");
  }
  const caseInstance = config.components.find((entry) => entry.instanceId === request.instanceId);
  if (!caseInstance || caseInstance.kind !== "case" || caseInstance.identity.status !== "resolved"
    || caseInstance.identity.skuId !== baseManifest.identity.skuId) {
    throw new TypeError("case instance override exact case identity is missing or mismatched");
  }
  await assertObservationClosure(request.planId, observationClosure);
  if (observationClosure.snapshot.snapshotId !== request.observationSnapshotId
    || observationClosure.snapshot.contentHash !== request.observationSnapshotHash) {
    throw new TypeError("case instance override observation snapshot binding mismatch");
  }

  const caseScope: CaseObservationAnchorScope = {
    caseInstanceId: request.instanceId,
    baseManifestHash: request.baseManifestHash,
    manifest: baseManifest,
  };
  const entries: CaseInstanceOverrideEntry[] = [];
  for (const record of observationClosure.observations) {
    const observation: UserObservation = record.observation;
    const definition = fieldDefinition(observation.fieldId);
    const targetsCase = subjectTargetsCase(observation.subjectRef, config, request.instanceId);
    if (!targetsCase) continue;
    if (!hasLockedAnchor(observation.subjectRef, config, baseManifest, request.instanceId)) {
      throw new TypeError("case instance override observation targets an unknown locked manifest anchor");
    }
    const currentContext = await resolveObservationProjectionContext(
      request.planId,
      config,
      observation.subjectRef,
      caseScope,
    );
    if (!currentContext.subjectExists || !canProjectUserObservation(observation, currentContext)
      || !sameJson(record.projectionContext, currentContext)) {
      throw new TypeError("case instance override observation is stale for the current case subject");
    }
    if (!definition) continue;
    if (!definition.subjectKinds.includes(observation.subjectRef.kind)
      || observation.unit !== definition.unit
      || typeof observation.value !== "number" || !Number.isFinite(observation.value)
      || !observation.uncertainty) {
      throw new TypeError("case instance override observation field/unit/uncertainty invalid");
    }
    entries.push({
      observationId: observation.observationId,
      observationRecordHash: record.recordHash,
      subjectRef: structuredClone(observation.subjectRef),
      subjectRevisionHash: observation.subjectRevisionHash,
      fieldId: observation.fieldId as CaseInstanceOverrideFieldId,
      targetKind: definition.targetKind,
      property: definition.property,
      value: observation.value,
      unit: definition.unit,
      uncertainty: structuredClone(observation.uncertainty),
    });
  }
  entries.sort((left, right) => compareCanonical(entrySortKey(left), entrySortKey(right)));
  const slots = entries.map(targetSlotKey);
  if (new Set(slots).size !== slots.length) {
    throw new TypeError("case instance override has ambiguous current observations for one spatial target");
  }

  const base: Omit<CaseInstanceOverrides, "spatialHash" | "contentHash"> = {
    schemaVersion: "case-instance-overrides-v1",
    planId: request.planId,
    instanceId: request.instanceId,
    subjectRevisionHash: await caseSpatialSubjectRevision(config, request.instanceId),
    observationSnapshotId: request.observationSnapshotId,
    observationSnapshotHash: request.observationSnapshotHash,
    baseManifestHash: request.baseManifestHash,
    baseProjectionHash: request.baseProjectionHash,
    overrides: entries,
  };
  const withSpatial = { ...base, spatialHash: await hashContent(spatialHashMaterial(base), SPATIAL_HASH_CONTRACT) };
  const result: CaseInstanceOverrides = {
    ...withSpatial,
    contentHash: await hashContent(withSpatial, CONTENT_HASH_CONTRACT),
  };
  const resultErrors = validateCaseInstanceOverridesRuntime(result);
  if (resultErrors.length) throw new TypeError(`case instance override output invalid: ${resultErrors.join("; ")}`);
  return deepFreeze(result) as CaseInstanceOverrides;
}

/** TypeScript façade over the total JS validator used by backup/Doctor/runtime. */
export function validateCaseInstanceOverrides(value: unknown): string[] {
  return validateCaseInstanceOverridesRuntime(value);
}

export function resolveCaseInstanceOverrides(
  activeRoot: string,
  request: CaseInstanceOverrideRequest,
  authority: RootBoundCaseInstanceOverrideAuthority,
): Promise<CaseInstanceOverrides> {
  return resolveCaseInstanceOverridesAtRoot(activeRoot, request, authority);
}

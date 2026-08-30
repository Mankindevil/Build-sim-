import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import genericSeedJson from "./fixtures/adapters/generic-atx-case.json";
import {
  materializeCaseAdapterFixtureSeed,
  resolveCaseInstanceOverrides,
  validateCaseInstanceOverrides,
  type CaseAdapterManifest,
  type CaseAdapterSeed,
  type CaseInstanceOverrideRequest,
  type CaseInstanceOverrideRootClosure,
  type RootBoundCaseInstanceOverrideAuthority,
} from "../src/adapters";
import { hashContent, legacySha256Hex } from "../src/hash";
import {
  type ObservationSubjectRef,
  type UserObservation,
  type UserObservationSnapshot,
} from "../src/observations/contracts";
import {
  ObservationRepository,
  type ResolvedObservationRepositoryRecord,
  type ResolvedObservationRepositorySnapshotClosure,
} from "../src/observations/repository";
import { resolveObservationProjectionContext } from "../src/observations/subject-resolution";
import { verifyCaseInstanceOverridesRuntime } from "../src/observations/canonical-runtime.mjs";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";

const seed = genericSeedJson as unknown as CaseAdapterSeed;
const roots: string[] = [];
const capturedAt = "2026-08-28T05:00:00.000Z";
const validatedAt = "2026-08-28T05:01:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(planId: string, manifest: CaseAdapterManifest): BuildConfigV3 {
  const value = createEmptyBuildConfigV3(planId, `Override ${planId}`, "2026-08-28T05:02:00.000Z");
  value.components = ["case-a", "case-b"].map((instanceId) => ({
    instanceId,
    kind: "case" as const,
    role: instanceId,
    state: "planned" as const,
    identity: { status: "resolved" as const, skuId: manifest.identity.skuId, identityClaimIds: [`claim-${planId}-${instanceId}`] },
    source: "user" as const,
  }));
  return value;
}

async function observation(
  observationId: string,
  planId: string,
  currentConfig: BuildConfigV3,
  manifest: CaseAdapterManifest,
  caseInstanceId: string,
  subjectRef: ObservationSubjectRef,
  fieldId: UserObservation["fieldId"],
  value: number,
  unit: UserObservation["unit"],
  uncertainty: UserObservation["uncertainty"] = { plusMinus: 0.5 },
): Promise<{ observation: UserObservation; projectionContext: Awaited<ReturnType<typeof resolveObservationProjectionContext>> }> {
  const projectionContext = await resolveObservationProjectionContext(planId, currentConfig, subjectRef, {
    caseInstanceId,
    baseManifestHash: manifest.contentHash,
    manifest,
  });
  const base = {
    observationId,
    planId,
    subjectRef,
    fieldId,
    value,
    unit,
    uncertainty,
    method: "measurement" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: projectionContext.currentConfigHash,
    subjectRevisionHash: projectionContext.currentSubjectRevisionHash,
    capturedAt,
    validatedAt,
    status: "active" as const,
  };
  return { observation: { ...base, contentHash: await legacySha256Hex(base) }, projectionContext } as {
    observation: UserObservation;
    projectionContext: Awaited<ReturnType<typeof resolveObservationProjectionContext>>;
  };
}

async function closure(
  planId: string,
  snapshotId: string,
  records: Array<{ observation: UserObservation; projectionContext: ResolvedObservationRepositoryRecord["projectionContext"] }>,
): Promise<ResolvedObservationRepositorySnapshotClosure> {
  const observations = await Promise.all(records.map(async (entry): Promise<ResolvedObservationRepositoryRecord> => ({
    recordHash: await legacySha256Hex(entry.observation),
    observation: structuredClone(entry.observation),
    projectionContext: structuredClone(entry.projectionContext),
    attachmentClosureVerified: true,
  })));
  observations.sort((left, right) => left.observation.observationId.localeCompare(right.observation.observationId));
  const snapshotBase = {
    schemaVersion: "user-observation-snapshot-v1" as const,
    snapshotId,
    planId,
    observationIds: observations.map((entry) => entry.observation.observationId),
    observationRecordHashes: Object.fromEntries(observations.map((entry) => [entry.observation.observationId, entry.recordHash])),
    createdAt: "2026-08-28T05:03:00.000Z",
  };
  const snapshot: UserObservationSnapshot = {
    ...snapshotBase,
    contentHash: await hashContent(snapshotBase, {
      domain: "user-observation-snapshot",
      schemaVersion: "user-observation-snapshot-v1",
    }),
  };
  return { snapshot, observations };
}

function authority(resolve: (request: CaseInstanceOverrideRequest) => CaseInstanceOverrideRootClosure | null): RootBoundCaseInstanceOverrideAuthority {
  return {
    authorityKind: "case-instance-override-root-bound-v1",
    resolveCaseInstanceOverrideClosureAtRoot: async (_activeRoot, request) => structuredClone(resolve(request)),
  };
}

async function requestFor(
  planId: string,
  instanceId: string,
  baseManifest: CaseAdapterManifest,
  baseProjectionHash: string,
  observations: ResolvedObservationRepositorySnapshotClosure,
): Promise<CaseInstanceOverrideRequest> {
  return {
    planId,
    instanceId,
    observationSnapshotId: observations.snapshot.snapshotId,
    observationSnapshotHash: observations.snapshot.contentHash,
    baseManifestHash: baseManifest.contentHash,
    baseProjectionHash,
  };
}

describe("U5 plan-scoped case instance observation overrides", () => {
  it("resolves empty manifest mount/port anchors without requiring a placement or connection", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(seed);
    const manifestBefore = structuredClone(materialized.manifest);
    const currentConfig = config("plan-a", materialized.manifest);
    const mountId = materialized.manifest.mounts[0]!.mountId;
    const portId = materialized.manifest.ports[0]!.portId;
    expect(currentConfig.placements).toEqual([]);
    expect(currentConfig.connections).toEqual([]);
    const mount = await observation("observation-empty-mount", "plan-a", currentConfig, materialized.manifest, "case-a",
      { kind: "mount", ownerInstanceId: "case-a", mountId }, "case.anchor.x", 12, "mm");
    const port = await observation("observation-empty-port", "plan-a", currentConfig, materialized.manifest, "case-a",
      { kind: "port", instanceId: "case-a", portId }, "case.pose.yaw", 90, "degree", { plusMinus: 2 });
    expect(mount.projectionContext.subjectExists).toBe(true);
    expect(port.projectionContext.subjectExists).toBe(true);
    const observations = await closure("plan-a", "snapshot-empty-anchors", [mount, port]);
    const baseProjectionHash = await legacySha256Hex(materialized.projection);
    const request = await requestFor("plan-a", "case-a", materialized.manifest, baseProjectionHash, observations);
    const result = await resolveCaseInstanceOverrides("/runtime/root-a", request, authority(() => ({
      config: currentConfig,
      baseManifest: materialized.manifest,
      baseProjectionHash,
      observationClosure: observations,
    })));

    expect(result.overrides.map((entry) => [entry.targetKind, entry.property, entry.unit])).toEqual([
      ["anchor", "x", "mm"],
      ["pose", "yaw", "degree"],
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.overrides)).toBe(true);
    expect(validateCaseInstanceOverrides(result)).toEqual([]);
    expect(verifyCaseInstanceOverridesRuntime(result)).toBe(true);
    expect(materialized.manifest).toEqual(manifestBefore);
    expect(materialized.manifest.contentHash).toBe(request.baseManifestHash);
    expect("adapterSnapshotHash" in result).toBe(false);
  });

  it("isolates the same SKU across two plans and two instances in one plan", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(seed);
    const planA = config("plan-a", materialized.manifest);
    const planB = config("plan-b", materialized.manifest);
    const portId = materialized.manifest.ports[0]!.portId;
    const a1 = await observation("observation-a1", "plan-a", planA, materialized.manifest, "case-a",
      { kind: "port", instanceId: "case-a", portId }, "case.anchor.x", 10, "mm");
    const a2 = await observation("observation-a2", "plan-a", planA, materialized.manifest, "case-b",
      { kind: "port", instanceId: "case-b", portId }, "case.anchor.x", 20, "mm");
    const b1 = await observation("observation-b1", "plan-b", planB, materialized.manifest, "case-a",
      { kind: "port", instanceId: "case-a", portId }, "case.anchor.x", 10, "mm");
    const closureA = await closure("plan-a", "snapshot-plan-a", [a1, a2]);
    const closureB = await closure("plan-b", "snapshot-plan-b", [b1]);
    const baseProjectionHash = await legacySha256Hex(materialized.projection);
    const resolve = authority((request) => ({
      config: request.planId === "plan-a" ? planA : planB,
      baseManifest: materialized.manifest,
      baseProjectionHash,
      observationClosure: request.planId === "plan-a" ? closureA : closureB,
    }));
    const resultA1 = await resolveCaseInstanceOverrides("/runtime/root-a", await requestFor("plan-a", "case-a", materialized.manifest, baseProjectionHash, closureA), resolve);
    const resultA2 = await resolveCaseInstanceOverrides("/runtime/root-a", await requestFor("plan-a", "case-b", materialized.manifest, baseProjectionHash, closureA), resolve);
    const resultB1 = await resolveCaseInstanceOverrides("/runtime/root-a", await requestFor("plan-b", "case-a", materialized.manifest, baseProjectionHash, closureB), resolve);

    expect(resultA1.overrides.map((entry) => entry.value)).toEqual([10]);
    expect(resultA2.overrides.map((entry) => entry.value)).toEqual([20]);
    expect(resultB1.overrides.map((entry) => entry.value)).toEqual([10]);
    expect(new Set([resultA1.spatialHash, resultA2.spatialHash, resultB1.spatialHash]).size).toBe(3);
    expect(new Set([resultA1.contentHash, resultA2.contentHash, resultB1.contentHash]).size).toBe(3);
  });

  it("rejects stale movement, a swapped/missing locked anchor, and changed base locks", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(seed);
    const before = config("plan-a", materialized.manifest);
    before.components.push({
      instanceId: "disk-a", kind: "storage_drive", role: "disk", state: "planned",
      identity: { status: "resolved", skuId: "disk.example", identityClaimIds: ["claim-disk"] }, source: "user",
    });
    const mountId = materialized.manifest.mounts[0]!.mountId;
    before.placements = [{ placementId: "placement-a", componentInstanceId: "disk-a", mountOwnerInstanceId: "case-a", mountId }];
    const measured = await observation("observation-placement", "plan-a", before, materialized.manifest, "case-a",
      { kind: "placement", placementId: "placement-a" }, "case.pose.x", 25, "mm");
    const observations = await closure("plan-a", "snapshot-stale", [measured]);
    const baseProjectionHash = await legacySha256Hex(materialized.projection);
    const request = await requestFor("plan-a", "case-a", materialized.manifest, baseProjectionHash, observations);
    const moved = structuredClone(before);
    moved.placements[0]!.mountId = materialized.manifest.mounts[1]!.mountId;
    moved.updatedAt = "2026-08-28T05:04:00.000Z";
    await expect(resolveCaseInstanceOverrides("/runtime/root-a", request, authority(() => ({
      config: moved, baseManifest: materialized.manifest, baseProjectionHash, observationClosure: observations,
    })))).rejects.toThrow(/stale/i);

    const unknownAnchor = await observation("observation-unknown-anchor", "plan-a", before, materialized.manifest, "case-a",
      { kind: "mount", ownerInstanceId: "case-a", mountId }, "case.anchor.x", 12, "mm");
    unknownAnchor.observation.subjectRef = { kind: "mount", ownerInstanceId: "case-a", mountId: "transport-invented-anchor" };
    const changedBase = { ...unknownAnchor.observation };
    delete (changedBase as Partial<UserObservation>).contentHash;
    unknownAnchor.observation.contentHash = await legacySha256Hex(changedBase);
    const forged = await closure("plan-a", "snapshot-forged-anchor", [unknownAnchor]);
    const forgedRequest = await requestFor("plan-a", "case-a", materialized.manifest, baseProjectionHash, forged);
    await expect(resolveCaseInstanceOverrides("/runtime/root-a", forgedRequest, authority(() => ({
      config: before, baseManifest: materialized.manifest, baseProjectionHash, observationClosure: forged,
    })))).rejects.toThrow(/unknown locked manifest anchor/i);

    await expect(resolveCaseInstanceOverrides("/runtime/root-a", { ...request, baseProjectionHash: "f".repeat(64) }, authority(() => ({
      config: before, baseManifest: materialized.manifest, baseProjectionHash, observationClosure: observations,
    })))).rejects.toThrow(/locked adapter binding/i);
  });

  it("makes a superseded/retracted historical snapshot unavailable to current-root consumers", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(seed);
    const currentConfig = config("plan-a", materialized.manifest);
    const mountId = materialized.manifest.mounts[0]!.mountId;
    const measured = await observation("observation-current", "plan-a", currentConfig, materialized.manifest, "case-a",
      { kind: "mount", ownerInstanceId: "case-a", mountId }, "case.anchor.x", 12, "mm");
    const activeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-current-observation-root-"));
    roots.push(activeRoot);
    const contextResolver = (candidate: UserObservation) => resolveObservationProjectionContext("plan-a", currentConfig, candidate.subjectRef, {
      caseInstanceId: "case-a", baseManifestHash: materialized.manifest.contentHash, manifest: materialized.manifest,
    });
    const repository = new ObservationRepository({
      root: path.join(activeRoot, "observations"),
      now: () => "2026-08-28T05:05:00.000Z",
      attachments: { hasAvailable: async () => true, hasAvailableAtRoot: async () => true },
      projectionContextForObservation: contextResolver,
    });
    await repository.put({ observation: measured.observation });
    const snapshot = await repository.createSnapshot("plan-a", { resolveProjectionContext: contextResolver });
    await expect(repository.getCurrentSnapshotClosureAtRoot(activeRoot, "plan-a", snapshot.snapshotId, contextResolver)).resolves.not.toBeNull();
    await repository.retract({
      planId: "plan-a",
      observationId: measured.observation.observationId,
      expectedHash: await legacySha256Hex(measured.observation),
      replacementObservationId: "observation-retracted",
      context: measured.projectionContext,
    });
    await expect(repository.getCurrentSnapshotClosureAtRoot(activeRoot, "plan-a", snapshot.snapshotId, contextResolver)).resolves.toBeNull();
  });

  it("fails closed for wrong units/uncertainty and runtime hash tampering", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(seed);
    const currentConfig = config("plan-a", materialized.manifest);
    const portId = materialized.manifest.ports[0]!.portId;
    const valid = await observation("observation-valid", "plan-a", currentConfig, materialized.manifest, "case-a",
      { kind: "port", instanceId: "case-a", portId }, "case.pose.yaw", 90, "degree", { plusMinus: 2 });
    const observations = await closure("plan-a", "snapshot-valid", [valid]);
    const baseProjectionHash = await legacySha256Hex(materialized.projection);
    const request = await requestFor("plan-a", "case-a", materialized.manifest, baseProjectionHash, observations);
    const rootAuthority = authority(() => ({ config: currentConfig, baseManifest: materialized.manifest, baseProjectionHash, observationClosure: observations }));
    const result = await resolveCaseInstanceOverrides("/runtime/root-a", request, rootAuthority);
    const tampered = structuredClone(result);
    tampered.overrides[0]!.value = 91;
    expect(validateCaseInstanceOverrides(tampered)).toEqual(expect.arrayContaining([
      "case instance overrides spatialHash mismatch",
      "case instance overrides contentHash mismatch",
    ]));
    expect(verifyCaseInstanceOverridesRuntime({ get schemaVersion() { throw new Error("hostile"); } })).toBe(false);

    const invalid = structuredClone(valid);
    invalid.observation.unit = "mm";
    const withoutHash = { ...invalid.observation };
    delete (withoutHash as Partial<UserObservation>).contentHash;
    invalid.observation.contentHash = await legacySha256Hex(withoutHash);
    const invalidClosure = await closure("plan-a", "snapshot-wrong-unit", [invalid]);
    await expect(resolveCaseInstanceOverrides("/runtime/root-a", await requestFor("plan-a", "case-a", materialized.manifest, baseProjectionHash, invalidClosure), authority(() => ({
      config: currentConfig, baseManifest: materialized.manifest, baseProjectionHash, observationClosure: invalidClosure,
    })))).rejects.toThrow(/non-current record|field\/unit\/uncertainty/i);
  });
});

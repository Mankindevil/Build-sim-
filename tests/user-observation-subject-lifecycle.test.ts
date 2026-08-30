import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObservationSubjectRef, UserObservation } from "../src/observations/contracts";
import { ObservationRepository } from "../src/observations/repository";
import { resolveObservationProjectionContext } from "../src/observations/subject-resolution";
import { canonicalJson } from "../src/plans/canonical";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const now = (): string => "2026-08-28T02:00:00.000Z";

function config(planId: string): BuildConfigV3 {
  const value = createEmptyBuildConfigV3(planId, `Observation scope ${planId}`, "2026-08-28T01:00:00.000Z");
  value.components = [
    { instanceId: `${planId}-case`, kind: "case", role: "case", state: "planned", identity: { status: "unresolved", userText: "case" }, source: "user" },
    { instanceId: `${planId}-disk-a`, kind: "storage_drive", role: "data", state: "planned", identity: { status: "unresolved", userText: "disk a" }, source: "user" },
    { instanceId: `${planId}-disk-b`, kind: "storage_drive", role: "data", state: "planned", identity: { status: "unresolved", userText: "disk b" }, source: "user" },
    { instanceId: `${planId}-cable`, kind: "cable", role: "data", state: "planned", identity: { status: "unresolved", userText: "cable" }, source: "user" },
    { instanceId: `${planId}-board`, kind: "motherboard", role: "mainboard", state: "planned", identity: { status: "unresolved", userText: "board" }, source: "user" },
  ];
  value.placements = [{
    placementId: `${planId}-placement-a`,
    componentInstanceId: `${planId}-disk-a`,
    mountOwnerInstanceId: `${planId}-case`,
    mountId: "bay-1",
  }];
  value.connections = [{
    connectionId: `${planId}-route-a`,
    from: { instanceId: `${planId}-disk-a`, portId: "sata" },
    to: { instanceId: `${planId}-case`, portId: "backplane-1" },
    cableInstanceId: `${planId}-cable`,
    status: "planned",
  }];
  value.firmwareTargets = [{
    instanceId: `${planId}-board`,
    targetReleaseFactId: "firmware-release-a",
    requestedSettings: [],
    source: "user",
  }];
  return value;
}

async function observation(
  observationId: string,
  planId: string,
  currentConfig: BuildConfigV3,
  subjectRef: ObservationSubjectRef,
  shape: Pick<UserObservation, "fieldId" | "value" | "method"> & Partial<Pick<UserObservation, "unit" | "uncertainty">>,
): Promise<UserObservation> {
  const context = await resolveObservationProjectionContext(planId, currentConfig, subjectRef);
  const base = {
    observationId,
    planId,
    subjectRef,
    ...shape,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: context.currentConfigHash,
    subjectRevisionHash: context.currentSubjectRevisionHash,
    capturedAt: "2026-08-28T01:30:00.000Z",
    validatedAt: "2026-08-28T01:31:00.000Z",
    status: "active" as const,
  };
  return { ...base, contentHash: digest(base) } as UserObservation;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-observation-subject-lifecycle-"));
  roots.push(root);
  const configs = new Map<string, BuildConfigV3>([["plan-a", config("plan-a")], ["plan-b", config("plan-b")]]);
  const store = new ObservationRepository({
    root,
    now,
    attachments: { hasAvailable: async () => false },
    projectionContextForObservation: (candidate) => {
      const current = configs.get(candidate.planId);
      if (!current) throw new Error("plan config missing");
      return resolveObservationProjectionContext(candidate.planId, current, candidate.subjectRef);
    },
  });
  return { configs, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 observation subject lifecycle", () => {
  it("invalidates only slot/port/route and firmware subjects whose revision changed", async () => {
    const { configs, store } = await setup();
    const planA = configs.get("plan-a")!;
    const placement = await observation("observation-placement-a", "plan-a", planA,
      { kind: "placement", placementId: "plan-a-placement-a" },
      { fieldId: "physical.clearance", value: 4, unit: "mm", uncertainty: { plusMinus: 0.5 }, method: "measurement" });
    const connection = await observation("observation-connection-a", "plan-a", planA,
      { kind: "connection", connectionId: "plan-a-route-a" },
      { fieldId: "connection.connected", value: true, method: "visual_confirmation" });
    const port = await observation("observation-port-a", "plan-a", planA,
      { kind: "port", instanceId: "plan-a-disk-a", portId: "sata" },
      { fieldId: "port.presence", value: true, method: "visual_confirmation" });
    const firmware = await observation("observation-firmware-a", "plan-a", planA,
      { kind: "firmware_instance", instanceId: "plan-a-board" },
      { fieldId: "firmware.bios_version", value: "1.0.0", method: "visual_confirmation" });
    const planResult = await observation("observation-plan-result", "plan-a", planA,
      { kind: "plan" },
      { fieldId: "boot.result", value: "booted", method: "visual_confirmation" });
    const unrelated = await observation("observation-unrelated-instance", "plan-a", planA,
      { kind: "instance", instanceId: "plan-a-disk-b" },
      { fieldId: "physical.component_length", value: 147, unit: "mm", uncertainty: { plusMinus: 0.5 }, method: "measurement" });
    for (const candidate of [placement, connection, port, firmware, planResult, unrelated]) await store.put({ observation: candidate });

    const changed = structuredClone(planA);
    changed.placements[0]!.mountId = "bay-2";
    changed.connections[0]!.to.portId = "backplane-2";
    changed.firmwareTargets[0]!.targetReleaseFactId = "firmware-release-b";
    changed.updatedAt = "2026-08-28T02:01:00.000Z";
    configs.set("plan-a", changed);

    for (const staleId of [placement.observationId, connection.observationId, port.observationId, firmware.observationId, planResult.observationId]) {
      await expect(store.resolveForFact("plan-a", staleId)).resolves.toBeNull();
    }
    await expect(store.resolveForFact("plan-a", unrelated.observationId)).resolves.toMatchObject({
      observation: { observationId: unrelated.observationId },
    });
  });

  it("isolates plans and instances when an observation is retracted", async () => {
    const { configs, store } = await setup();
    const planA = configs.get("plan-a")!;
    const planB = configs.get("plan-b")!;
    const instanceA = await observation("observation-plan-a-instance", "plan-a", planA,
      { kind: "instance", instanceId: "plan-a-disk-b" },
      { fieldId: "physical.component_length", value: 147, unit: "mm", uncertainty: { plusMinus: 0.5 }, method: "measurement" });
    const otherInstanceA = await observation("observation-plan-a-other-instance", "plan-a", planA,
      { kind: "instance", instanceId: "plan-a-disk-a" },
      { fieldId: "physical.component_length", value: 149, unit: "mm", uncertainty: { plusMinus: 0.5 }, method: "measurement" });
    const instanceB = await observation("observation-plan-b-instance", "plan-b", planB,
      { kind: "instance", instanceId: "plan-b-disk-b" },
      { fieldId: "physical.component_length", value: 147, unit: "mm", uncertainty: { plusMinus: 0.5 }, method: "measurement" });
    for (const candidate of [instanceA, otherInstanceA, instanceB]) await store.put({ observation: candidate });

    const currentA = await resolveObservationProjectionContext("plan-a", planA, instanceA.subjectRef);
    const retracted = await store.retract({
      planId: "plan-a",
      observationId: instanceA.observationId,
      expectedHash: digest(instanceA),
      replacementObservationId: "observation-plan-a-retracted",
      context: currentA,
    });
    expect(retracted.status).toBe("retracted");
    await expect(store.resolveForFact("plan-a", instanceA.observationId)).resolves.toBeNull();
    await expect(store.resolveForFact("plan-a", retracted.observationId)).resolves.toBeNull();
    await expect(store.resolveForFact("plan-a", otherInstanceA.observationId)).resolves.toMatchObject({ observation: { observationId: otherInstanceA.observationId } });
    await expect(store.resolveForFact("plan-b", instanceB.observationId)).resolves.toMatchObject({ observation: { observationId: instanceB.observationId } });
    await expect(store.resolveForFact("plan-b", instanceA.observationId)).resolves.toBeNull();
  });
});

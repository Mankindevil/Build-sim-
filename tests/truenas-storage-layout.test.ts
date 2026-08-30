import { describe, expect, it } from "vitest";
import type { FactRecord } from "../src/facts/contracts";
import type { UserObservation } from "../src/observations/contracts";
import { hashPlanConfig, sha256Hex } from "../src/plans/canonical";
import { projectProductionTrueNasLayout } from "../src/storage/production";
import { createDestructiveActionPlan, evaluateTrueNasLayout, type StorageDiskAuthority } from "../src/storage/truenas";
import { validateStorageLayoutEvaluation } from "../src/storage/contracts";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { hash } from "./helpers/u7-fixtures";

const disk = (instanceId: string, port: string, capacityBytes = 1_000, media: StorageDiskAuthority["media"] = "CMR"): StorageDiskAuthority => ({
  instanceId, capacityBytes, media, faultDomain: "case-1", revisionHash: hash(instanceId[0] ?? "a"), factIds: [`fact.${instanceId}`], locatorObservationId: `obs.${instanceId}`,
  path: { controllerInstanceId: "hba-1", controllerPortId: port, transport: "sas", controllerMode: "it", factIds: [`fact.path.${instanceId}`] },
});

function productFact(skuId: string, field: string, value: unknown, unit?: string): FactRecord {
  return {
    schemaVersion: "fact-record-v1",
    factId: `fact.${skuId}.${field}`,
    subject: { kind: "product", skuId },
    field,
    value,
    ...(unit ? { unit } : {}),
    scope: "variant",
    authority: "official",
    safetyClass: "compatibility_critical",
    status: "active",
    evidenceRefs: [`claim.${skuId}.${field}`],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-29T00:00:00.000Z",
    contentHash: hash("a"),
  };
}

function productionConfig(): BuildConfigV3 {
  const config = createEmptyBuildConfigV3("plan-storage-production", "TrueNAS production", "2026-08-29T00:00:00.000Z");
  config.components = [
    ...["boot", "d1", "d2"].map((instanceId) => ({
      instanceId,
      kind: "storage_drive" as const,
      role: instanceId === "boot" ? "boot" : "data",
      state: "planned" as const,
      identity: { status: "resolved" as const, skuId: `sku.${instanceId}`, identityClaimIds: [`claim.${instanceId}`] },
      source: "user" as const,
    })),
    {
      instanceId: "hba-1", kind: "hba", role: "storage_controller", state: "planned",
      identity: { status: "resolved", skuId: "sku.hba", identityClaimIds: ["claim.hba"] }, source: "user",
    },
    {
      instanceId: "case-1", kind: "case", role: "enclosure", state: "planned",
      identity: { status: "resolved", skuId: "sku.case", identityClaimIds: ["claim.case"] }, source: "user",
    },
  ];
  config.placements = ["boot", "d1", "d2"].map((instanceId) => ({
    placementId: `placement.${instanceId}`, componentInstanceId: instanceId,
    mountOwnerInstanceId: "case-1", mountId: `bay.${instanceId}`,
  }));
  config.connections = ["boot", "d1", "d2"].map((instanceId, index) => ({
    connectionId: `connection.${instanceId}`,
    from: { instanceId, portId: "data" },
    to: { instanceId: "hba-1", portId: `port-${index}` },
    status: "planned" as const,
  }));
  config.logicalLayouts = [{
    layoutId: "layout-production",
    bootPoolDiskIds: ["boot"],
    vdevs: [{ vdevId: "data", topology: "mirror", diskInstanceIds: ["d1", "d2"] }],
    spareDiskIds: [],
  }];
  return config;
}

async function diskLocator(config: BuildConfigV3, configHash: string, instanceId: string): Promise<UserObservation> {
  const diskInstance = config.components.find((component) => component.instanceId === instanceId)!;
  return {
    observationId: `observation.locator.${instanceId}`,
    planId: config.id,
    subjectRef: { kind: "instance", instanceId },
    fieldId: "storage.disk_locator",
    value: `serial-and-bay-${instanceId}`,
    method: "user_assertion",
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: configHash,
    subjectRevisionHash: await sha256Hex(diskInstance),
    capturedAt: "2026-08-29T00:00:00.000Z",
    validatedAt: "2026-08-29T00:01:00.000Z",
    status: "active",
    contentHash: hash("b"),
  };
}

describe("U7 TrueNAS storage layout", () => {
  it("derives capacity, tolerance, controller paths, mixed loss and resilver risks without mutating selection", () => {
    const selection = { layoutId: "layout", bootPoolDiskIds: ["boot"], vdevs: [{ vdevId: "data", topology: "mirror" as const, diskInstanceIds: ["d1", "d2"] }], spareDiskIds: ["spare"] };
    const before = structuredClone(selection);
    const result = evaluateTrueNasLayout({ selection, systemProfileId: "system.truenas-scale", disks: [disk("boot", "p0", 256), disk("d1", "p1"), disk("d2", "p2", 900), disk("spare", "p3")] });
    expect(selection).toEqual(before);
    expect(result.usableBytes).toEqual({ min: 900, max: 900 });
    expect(result.vdevResults[0]).toMatchObject({ mixedCapacityLossBytes: 100, faultTolerance: { diskFailures: 1 }, diskInstanceIds: ["d1", "d2"] });
    expect(result.assumptions).toContain("RAID/RAIDZ is not backup.");
    expect(validateStorageLayoutEvaluation(result)).toEqual([]);
  });

  it("fails known SMR and opaque RAID paths instead of claiming TrueNAS readiness", () => {
    const result = evaluateTrueNasLayout({ selection: { layoutId: "layout", bootPoolDiskIds: ["boot"], vdevs: [{ vdevId: "data", topology: "mirror", diskInstanceIds: ["d1", "d2"] }], spareDiskIds: [] }, systemProfileId: "system.truenas-scale", disks: [disk("boot", "p0", 256), disk("d1", "p1", 1_000, "SMR"), { ...disk("d2", "p2"), path: { ...disk("d2", "p2").path, controllerMode: "raid" } }] });
    expect(result.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ verdict: "fail", decisionId: "decision.storage.media.data" }), expect.objectContaining({ verdict: "fail", decisionId: "decision.storage.path.d2" })]));
  });

  it("projects a production layout only from exact locked facts, topology paths, and same-plan locator observations", async () => {
    const config = productionConfig();
    const configHash = await hashPlanConfig(config);
    const facts = [
      ...["boot", "d1", "d2"].flatMap((instanceId) => [
        productFact(`sku.${instanceId}`, "storage.capacity_bytes", instanceId === "boot" ? 256_000_000_000 : 4_000_000_000_000, "byte"),
        productFact(`sku.${instanceId}`, "storage.recording_technology", instanceId === "boot" ? "tlc" : "cmr"),
        productFact(`sku.${instanceId}`, "storage.interface", "sas"),
      ]),
      productFact("sku.hba", "hba.mode", "it"),
    ];
    const observations = await Promise.all(["boot", "d1", "d2"].map((instanceId) => diskLocator(config, configHash, instanceId)));
    const selectionBefore = structuredClone(config.logicalLayouts[0]!);

    const projected = await projectProductionTrueNasLayout({
      config,
      configHash,
      selection: config.logicalLayouts[0]!,
      facts,
      observations,
    });
    expect(projected.status).toBe("ready");
    if (projected.status !== "ready") throw new Error(projected.reasons.join("; "));
    expect(projected.evaluation).toMatchObject({
      usableBytes: { min: 4_000_000_000_000, max: 4_000_000_000_000 },
      vdevResults: [{
        vdevId: "data",
        faultTolerance: { diskFailures: 1 },
        controllerPaths: [
          { diskInstanceId: "d1", controllerInstanceId: "hba-1", controllerPortId: "port-1", transport: "sas" },
          { diskInstanceId: "d2", controllerInstanceId: "hba-1", controllerPortId: "port-2", transport: "sas" },
        ],
      }],
      assumptions: ["RAID/RAIDZ is not backup."],
    });
    expect(projected.disks.map(({ locatorObservationId }) => locatorObservationId)).toEqual([
      "observation.locator.boot", "observation.locator.d1", "observation.locator.d2",
    ]);
    expect(config.logicalLayouts[0]).toEqual(selectionBefore);

    const crossPlan = observations.map((observation) => observation.subjectRef.kind === "instance"
      && observation.subjectRef.instanceId === "d2" ? { ...observation, planId: "other-plan" } : observation);
    const withoutExactLocator = await projectProductionTrueNasLayout({
      config, configHash, selection: config.logicalLayouts[0]!, facts, observations: crossPlan,
    });
    expect(withoutExactLocator.status).toBe("ready");
    if (withoutExactLocator.status !== "ready") throw new Error(withoutExactLocator.reasons.join("; "));
    expect(withoutExactLocator.disks.find(({ instanceId }) => instanceId === "d2")?.locatorObservationId).toBeNull();
    expect(createDestructiveActionPlan({
      actionId: "wipe-data-vdev",
      diskInstanceIds: ["d1", "d2"],
      disks: withoutExactLocator.disks,
      planId: config.id,
      planVersionId: "version-storage-production",
      configHash,
      planRevisionHash: hash("c"),
      procedureSafetyHash: hash("d"),
    })).toBeNull();
  });

  it("blocks missing official authority, ambiguous paths, stale locators, and mismatched config hashes", async () => {
    const config = productionConfig();
    const configHash = await hashPlanConfig(config);
    const facts = [
      ...["boot", "d1", "d2"].flatMap((instanceId) => [
        productFact(`sku.${instanceId}`, "storage.capacity_bytes", 4_000_000_000_000, "byte"),
        productFact(`sku.${instanceId}`, "storage.recording_technology", "cmr"),
        productFact(`sku.${instanceId}`, "storage.interface", "sas"),
      ]),
      productFact("sku.hba", "hba.mode", "it"),
    ];
    const withoutOfficialCapacity = facts.filter(({ factId }) => factId !== "fact.sku.d2.storage.capacity_bytes");
    withoutOfficialCapacity.push({
      ...productFact("sku.d2", "storage.capacity_bytes", 4_000_000_000_000, "byte"),
      factId: "fact.third-party.capacity",
      authority: "third_party",
    });
    config.connections.push({
      connectionId: "connection.d2.ambiguous",
      from: { instanceId: "d2", portId: "data-secondary" },
      to: { instanceId: "hba-1", portId: "port-secondary" },
      status: "planned",
    });
    const blocked = await projectProductionTrueNasLayout({
      config,
      configHash: await hashPlanConfig(config),
      selection: config.logicalLayouts[0]!,
      facts: withoutOfficialCapacity,
      observations: [],
    });
    expect(blocked).toMatchObject({ status: "blocked", missingInstanceIds: ["d2"] });
    if (blocked.status !== "blocked") throw new Error("expected blocked production storage projection");
    expect(blocked.reasons).toEqual(expect.arrayContaining([
      "d2: exact official storage.capacity_bytes fact is missing",
      "d2: one unique disk-to-controller path is missing",
    ]));

    const staleHash = await projectProductionTrueNasLayout({
      config,
      configHash,
      selection: config.logicalLayouts[0]!,
      facts,
      observations: [],
    });
    expect(staleHash).toMatchObject({
      status: "blocked",
      reasons: ["layout config hash does not match the locked plan config"],
    });
  });
});

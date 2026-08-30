import { describe, expect, it } from "vitest";
import type { CaseAdapterArtifactPayload } from "../src/adapters/registry";
import type { FactRecord } from "../src/facts/contracts";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { projectBackplaneCapacities } from "../src/wiring/backplane-capacity";

const adapterSnapshot = {
  caseManifests: [{
    identity: { skuId: "case.nas-nine", region: "global", revision: "A", identityFactIds: [] },
    contentHash: "a".repeat(64),
    mounts: [{ mountId: "mount.drive.backplane", kind: "drive", quantity: 9 }],
    ports: [{ portId: "port.backplane.power", connectorStandardId: "power.backplane.sata-or-pata", quantity: 4 }],
  }],
  runtimeModels: [{
    manifestHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    authorityStatus: "legacy_unverified",
    documents: { profile: { backplanePower: { inlets: 4, connectors: { sataPower: 2, molex: 2 } } } },
  }],
} as unknown as CaseAdapterArtifactPayload;

function fact(input: { factId: string; skuId: string; field: string; value: unknown }): FactRecord {
  return {
    schemaVersion: "fact-record-v1",
    factId: input.factId,
    subject: { kind: "product", skuId: input.skuId, revision: "A", region: "global" },
    field: input.field,
    value: input.value,
    scope: "revision",
    authority: "official",
    safetyClass: "compatibility_critical",
    status: "active",
    evidenceRefs: [],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-30T00:00:00.000Z",
    contentHash: "c".repeat(64),
  } as FactRecord;
}

function config() {
  const value = createEmptyBuildConfigV3("plan-capacity", "Capacity", "2026-08-30T00:00:00.000Z");
  value.components = [
    { instanceId: "case-1", kind: "case", role: "chassis", state: "planned", identity: { status: "resolved", skuId: "case.nas-nine", identityClaimIds: ["claim-case"] }, source: "user" },
    { instanceId: "psu-1", kind: "psu", role: "primary-power", state: "planned", identity: { status: "resolved", skuId: "psu.fixture", identityClaimIds: ["claim-psu"] }, source: "user" },
    { instanceId: "disk-1", kind: "storage_drive", role: "data", state: "planned", identity: { status: "resolved", skuId: "disk.sata", identityClaimIds: ["claim-disk-1"] }, source: "user" },
    { instanceId: "disk-2", kind: "storage_drive", role: "cache", state: "planned", identity: { status: "resolved", skuId: "disk.nvme", identityClaimIds: ["claim-disk-2"] }, source: "user" },
  ];
  value.placements = [{ placementId: "placement-disk-1", componentInstanceId: "disk-1", mountOwnerInstanceId: "case-1", mountId: "mount.drive.backplane" }];
  return value;
}

describe("backplane current-demand and future-capacity projection", () => {
  it("keeps the generic-adapter rollback payload readable without inventing a projection", () => {
    expect(projectBackplaneCapacities({
      config: config(),
      adapterSnapshot: { schemaVersion: "workspace-adapter-snapshot-v1", catalog: {}, sources: [] } as unknown as CaseAdapterArtifactPayload,
      facts: [],
    })).toEqual([]);
  });

  it("keeps the populated plan scope separate from a hypothetical full backplane", () => {
    const plan = config();
    const before = structuredClone(plan);
    const projection = projectBackplaneCapacities({
      config: plan,
      adapterSnapshot,
      facts: [
        fact({ factId: "fact-psu-sata", skuId: "psu.fixture", field: "package.cable_count", value: { cableId: "sata-lead", connectorFamily: "sata-power", quantity: 2 } }),
        fact({ factId: "fact-psu-molex", skuId: "psu.fixture", field: "package.cable_count", value: { cableId: "molex-lead", connectorFamily: "molex", quantity: 1 } }),
        fact({ factId: "fact-disk-nvme", skuId: "disk.nvme", field: "storage.interface", value: "nvme" }),
      ],
    });
    expect(projection).toHaveLength(1);
    expect(projection[0]).toMatchObject({
      currentDemand: {
        scope: "current_plan",
        occupiedBayCount: 1,
        totalBayCount: 9,
        pendingStorageInstanceIds: [],
        requiredPowerLeads: { sata: null, molex: null, total: 4 },
        confirmedPsuPowerLeads: { sata: 2, molex: 1, total: 3 },
        status: "insufficient",
      },
      fullBackplaneCapability: {
        scope: "full_backplane",
        occupiedBayCount: 9,
        totalBayCount: 9,
        requiredPowerLeads: { sata: null, molex: null, total: 4 },
        status: "insufficient",
      },
      sourceFactIds: ["fact-psu-molex", "fact-psu-sata"],
    });
    expect(plan).toEqual(before);
  });

  it("does not turn unplaced storage or missing PSU facts into current cables or future capacity", () => {
    const plan = config();
    plan.placements = [];
    const [projection] = projectBackplaneCapacities({ config: plan, adapterSnapshot, facts: [] });
    expect(projection?.currentDemand).toMatchObject({
      occupiedBayCount: 0,
      pendingStorageInstanceIds: ["disk-1", "disk-2"],
      requiredPowerLeads: null,
      status: "unknown",
    });
    expect(projection?.fullBackplaneCapability).toMatchObject({
      occupiedBayCount: 9,
      requiredPowerLeads: { sata: null, molex: null, total: 4 },
      confirmedPsuPowerLeads: { sata: null, molex: null, total: null },
      status: "unknown",
    });
  });
});

import { describe, expect, it } from "vitest";
import { createBundleItem } from "../src/assembly/resources";
import {
  allocateRequirementSupplies,
  deriveRequirementReadiness,
  projectPackageInstanceSupplies,
} from "../src/requirements/allocation";
import type { RequirementNode } from "../src/requirements/contracts";

const safetyRequirement: RequirementNode = {
  requirementId: "requirement.case-a.prepower-cable",
  kind: "cable",
  predicates: [{ facetId: "cable.connector_standard", operator: "includes", value: "atx24" }],
  quantity: 1,
  criticality: "safety",
  requiredBefore: "pre_power",
  producedBy: { ruleId: "fixture.prepower", ruleVersion: "1.0.0", instanceIds: ["case-a", "board-a"] },
  evidenceRefs: ["fact-atx"],
};
const MANIFEST_HASH = "c".repeat(64);

async function cable() {
  return createBundleItem({
    schemaVersion: "bundle-item-v1",
    bundleItemId: "bundle.atx24",
    ownerSkuId: "case.fixture",
    kind: "cable",
    specification: [
      { facetId: "resource.kind", value: "cable" },
      { facetId: "cable.connector_standard", value: ["atx24"] },
    ],
    quantity: 1,
    variantScopeFactIds: ["fact-case-revision"],
    evidenceFactIds: ["fact-official-package-list"],
  });
}

describe("ordered/included is not physically present", () => {
  it("does not green pre-power readiness from an official package claim", async () => {
    const bundle = await cable();
    const [included] = await projectPackageInstanceSupplies({ ownerInstanceId: "case-a", ownerSkuId: "case.fixture", manifestHash: MANIFEST_HASH, bundleItems: [bundle] });
    expect(included).toMatchObject({ availability: "planned", verificationStatus: "unverified" });
    const allocation = allocateRequirementSupplies([safetyRequirement], [included!]);
    expect(allocation.satisfactions[0]?.status).toBe("open");
    expect(deriveRequirementReadiness(allocation).powerReady).toBe(false);
  });

  it("does not green from ordered/unverified, but does from observed present inventory", async () => {
    const bundle = await cable();
    const [ordered] = await projectPackageInstanceSupplies({
      ownerInstanceId: "case-a", ownerSkuId: "case.fixture", manifestHash: MANIFEST_HASH, bundleItems: [bundle],
      availabilityAssertions: { [bundle.bundleItemId]: { availability: "ordered", verificationStatus: "unverified", observationRefs: [] } },
    });
    expect(deriveRequirementReadiness(allocateRequirementSupplies([safetyRequirement], [ordered!])).powerReady).toBe(false);

    const [present] = await projectPackageInstanceSupplies({
      ownerInstanceId: "case-a", ownerSkuId: "case.fixture", manifestHash: MANIFEST_HASH, bundleItems: [bundle],
      availabilityAssertions: {
        [bundle.bundleItemId]: {
          availability: "present_verified", verificationStatus: "verified", satisfiesBefore: "pre_power",
          observationRefs: ["observation:obs-cable-in-hand"],
        },
      },
    });
    expect(deriveRequirementReadiness(allocateRequirementSupplies([safetyRequirement], [present!])).powerReady).toBe(true);
  });

  it("does not let an unobserved included item satisfy a normal assembly gate", async () => {
    const bundle = await cable();
    const [included] = await projectPackageInstanceSupplies({
      ownerInstanceId: "case-a", ownerSkuId: "case.fixture", manifestHash: MANIFEST_HASH, bundleItems: [bundle],
    });
    const assemblyRequirement: RequirementNode = {
      ...safetyRequirement,
      requirementId: "requirement.case-a.normal-assembly-cable",
      criticality: "normal",
      requiredBefore: "assembly",
    };
    const allocation = allocateRequirementSupplies([assemblyRequirement], [included!]);
    expect(allocation.satisfactions[0]?.status).toBe("open");
    expect(deriveRequirementReadiness(allocation)).toMatchObject({ assemblyReady: false, powerReady: false });
  });
});

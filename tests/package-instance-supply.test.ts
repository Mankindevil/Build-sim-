import { describe, expect, it } from "vitest";
import genericSeedJson from "./fixtures/adapters/generic-atx-case.json";
import { createCaseAdapterManifest, type CaseAdapterSeed } from "../src/adapters";
import { createBundleItem } from "../src/assembly/resources";
import {
  allocateRequirementSupplies,
  projectPackageInstanceSupplies,
} from "../src/requirements/allocation";
import type { RequirementNode } from "../src/requirements/contracts";
import { projectAssemblyResourcePatternRequirements } from "../src/requirements/patterns";
import { validateRequirementAllocationGeneratedSupplyClosureRuntime } from "../src/requirements/assembly-safety-runtime.mjs";
import {
  requirementAllocationReferencesRuntime,
  requirementArtifactContentHashRuntime,
  validateRequirementAllocationPackageClosureRuntime,
  validateRequirementAllocationResultRuntime,
} from "../src/requirements/runtime.mjs";

const MANIFEST_HASH = "c".repeat(64);

async function screwBundle() {
  return createBundleItem({
    schemaVersion: "bundle-item-v1",
    bundleItemId: "bundle.case.board-screws",
    ownerSkuId: "case.fixture",
    kind: "fastener",
    specification: [
      { facetId: "resource.kind", value: "fastener" },
      { facetId: "fastener.thread", value: "6-32" },
    ],
    quantity: 4,
    variantScopeFactIds: ["fact-case-revision"],
    evidenceFactIds: ["fact-package-screws"],
  });
}

function screwRequirement(requirementId: string, instanceIds: string[]): RequirementNode {
  return {
    requirementId,
    kind: "fastener",
    predicates: [{ facetId: "fastener.thread", operator: "eq", value: "6-32" }],
    quantity: 4,
    criticality: "normal",
    requiredBefore: "assembly",
    producedBy: { ruleId: "fixture.board-mount", ruleVersion: "1.0.0", instanceIds },
    evidenceRefs: ["fact-mount"],
  };
}

describe("package supplies are instance scoped", () => {
  it("preserves ownerInstanceId + bundleItemId across identical case SKUs", async () => {
    const bundle = await screwBundle();
    const [caseA, caseB] = await Promise.all(["case-a", "case-b"].map((ownerInstanceId) => projectPackageInstanceSupplies({
      ownerInstanceId,
      ownerSkuId: "case.fixture",
      manifestHash: MANIFEST_HASH,
      bundleItems: [bundle],
    })));
    expect(caseA![0]).toMatchObject({ ownerInstanceId: "case-a", refId: bundle.bundleItemId, quantity: 4 });
    expect(caseB![0]).toMatchObject({ ownerInstanceId: "case-b", refId: bundle.bundleItemId, quantity: 4 });
  });

  it("allows a case-owned screw to satisfy a board-in-that-case requirement, not another case", async () => {
    const bundle = await screwBundle();
    const [caseASupply] = await projectPackageInstanceSupplies({
      ownerInstanceId: "case-a",
      ownerSkuId: "case.fixture",
      manifestHash: MANIFEST_HASH,
      bundleItems: [bundle],
      availabilityAssertions: {
        [bundle.bundleItemId]: {
          availability: "present_verified",
          verificationStatus: "verified",
          satisfiesBefore: "assembly",
          observationRefs: ["observation:obs-case-a-box"],
        },
      },
    });
    const local = allocateRequirementSupplies([screwRequirement("local-board", ["case-a", "board-a"])], [caseASupply!]);
    expect(local.satisfactions[0]?.status).toBe("satisfied");
    expect(requirementAllocationReferencesRuntime(local)?.packageSupplyRefs[0]).toMatchObject({
      ownerInstanceId: "case-a", ownerSkuId: "case.fixture", bundleItemId: bundle.bundleItemId,
      bundleItemHash: bundle.contentHash,
    });

    const foreign = allocateRequirementSupplies([screwRequirement("foreign-board", ["case-b", "board-b"])], [caseASupply!]);
    expect(foreign.satisfactions[0]?.status).toBe("open");
    expect(foreign.remainingSupplies[0]?.quantity).toBe(4);
  });

  it("requires a physical observation for present_verified package assertions", async () => {
    const bundle = await screwBundle();
    await expect(projectPackageInstanceSupplies({
      ownerInstanceId: "case-a",
      ownerSkuId: "case.fixture",
      manifestHash: MANIFEST_HASH,
      bundleItems: [bundle],
      availabilityAssertions: {
        [bundle.bundleItemId]: {
          availability: "present_verified",
          verificationStatus: "verified",
          observationRefs: [],
        },
      },
    })).rejects.toThrow(/assertion invalid/);
  });

  it("replays package supplies against the exact locked manifest and rejects checksum-correct forgeries", async () => {
    const seed = genericSeedJson as unknown as CaseAdapterSeed;
    const manifest = await createCaseAdapterManifest(seed.manifest);
    const projectedNeeds = await projectAssemblyResourcePatternRequirements({
      pattern: manifest.resourcePatterns[0]!,
      ownerInstanceId: "case-a",
      targetInstanceIds: ["board-a"],
      mountStandardId: "mount.motherboard.atx",
      neededByStepId: "placement-board-a",
      requirementIdPrefix: "requirement.pattern.case-a.board-a",
      region: manifest.identity.region,
      revision: manifest.identity.revision,
    });
    expect(projectedNeeds.every(({ producedBy }) => producedBy.instanceIds.includes("case-a")
      && producedBy.instanceIds.includes("board-a"))).toBe(true);
    const supplies = await projectPackageInstanceSupplies({
      ownerInstanceId: "case-a",
      ownerSkuId: manifest.identity.skuId,
      manifestHash: manifest.contentHash,
      region: manifest.identity.region,
      revision: manifest.identity.revision,
      bundleItems: manifest.bundleItems,
      availabilityAssertions: {
        "bundle.fixture.case.6-32-screws": {
          availability: "present_verified",
          verificationStatus: "verified",
          satisfiesBefore: "assembly",
          observationRefs: ["observation:obs-case-a-box"],
        },
      },
    });
    const screwSupply = supplies.find(({ refId }) => refId === "bundle.fixture.case.6-32-screws")!;
    const target = { ...screwRequirement("local-board", ["case-a", "board-a"]), quantity: 2 };
    const allocation = allocateRequirementSupplies([target], [screwSupply]);
    const bindings = [{ ownerInstanceId: "case-a", manifest }] as const;
    expect(validateRequirementAllocationPackageClosureRuntime(allocation, bindings)).toEqual([]);
    expect(requirementAllocationReferencesRuntime(allocation)?.packageSupplyRefs[0]).toMatchObject({
      ownerInstanceId: "case-a",
      manifestHash: manifest.contentHash,
      bundleItemId: screwSupply.refId,
    });

    const wrongBundleAuthority = structuredClone(allocation);
    const forgedSupply = wrongBundleAuthority.supplies[0];
    if (forgedSupply?.source !== "package_content") throw new Error("fixture package supply missing");
    forgedSupply.packageAuthorityRef.bundleItemHash = "d".repeat(64);
    wrongBundleAuthority.contentHash = requirementArtifactContentHashRuntime(
      wrongBundleAuthority,
      wrongBundleAuthority.schemaVersion,
    )!;
    expect(validateRequirementAllocationResultRuntime(wrongBundleAuthority)).toEqual([]);
    expect(validateRequirementAllocationPackageClosureRuntime(wrongBundleAuthority, bindings)
      .some((error) => error.includes("bundle authority mismatch"))).toBe(true);

    const missingOwner = structuredClone(allocation) as unknown as Record<string, unknown> & {
      supplies: Array<Record<string, unknown>>;
      satisfactions: Array<{ allocations: Array<Record<string, unknown>> }>;
      remainingSupplies: Array<Record<string, unknown>>;
      schemaVersion: string;
      contentHash: string;
    };
    delete missingOwner.supplies[0]!.ownerInstanceId;
    delete missingOwner.satisfactions[0]!.allocations[0]!.ownerInstanceId;
    delete missingOwner.remainingSupplies[0]!.ownerInstanceId;
    missingOwner.contentHash = requirementArtifactContentHashRuntime(missingOwner, missingOwner.schemaVersion)!;
    expect(validateRequirementAllocationResultRuntime(missingOwner)
      .some((error) => error.includes("requires ownerInstanceId"))).toBe(true);

    const defaultSupplies = await projectPackageInstanceSupplies({
      ownerInstanceId: "case-a",
      ownerSkuId: manifest.identity.skuId,
      manifestHash: manifest.contentHash,
      region: manifest.identity.region,
      revision: manifest.identity.revision,
      bundleItems: manifest.bundleItems,
    });
    const generated = allocateRequirementSupplies([], defaultSupplies);
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(generated, {
      packageBindings: bindings, assemblyEvaluations: [],
    })).toEqual([]);

    const assertedSupplies = await projectPackageInstanceSupplies({
      ownerInstanceId: "case-a",
      ownerSkuId: manifest.identity.skuId,
      manifestHash: manifest.contentHash,
      region: manifest.identity.region,
      revision: manifest.identity.revision,
      bundleItems: manifest.bundleItems,
      availabilityAssertions: {
        "bundle.fixture.case.6-32-screws": {
          availability: "present_verified",
          verificationStatus: "verified",
          satisfiesBefore: "assembly",
          observationRefs: ["observation:obs-reused-without-assembly-authority"],
        },
      },
    });
    const asserted = allocateRequirementSupplies([], assertedSupplies);
    expect(validateRequirementAllocationGeneratedSupplyClosureRuntime(asserted, {
      packageBindings: bindings, assemblyEvaluations: [],
    }).some((error) => error.includes("unbound availability assertion"))).toBe(true);
  });
});

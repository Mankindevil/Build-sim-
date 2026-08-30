import { describe, expect, it } from "vitest";
import {
  allocateBundleSupplies,
  createAssemblyResourcePattern,
  createBundleItem,
  deriveAssemblyResourceNeeds,
  projectBundleItemsForOwner,
  validateBundleItem,
  verifyBundleItem,
} from "../src/assembly/resources";

describe("instance-scoped package supplies", () => {
  it("projects only exact owner SKU/region/revision package contents", async () => {
    const item = await createBundleItem({
      schemaVersion: "bundle-item-v1",
      bundleItemId: "bundle.case.screw-m3",
      ownerSkuId: "case.alpha",
      kind: "fastener",
      specification: [
        { facetId: "resource.kind", value: "fastener" },
        { facetId: "fastener.thread", value: "m3" },
      ],
      quantity: 2,
      region: "CN",
      revision: "rev-a",
      variantScopeFactIds: ["fact-package-revision"],
      evidenceFactIds: ["fact-package-contents"],
    });

    expect(validateBundleItem(item)).toEqual([]);
    await expect(projectBundleItemsForOwner({
      ownerInstanceId: "case-instance-a",
      ownerSkuId: "case.alpha",
      region: "CN",
      revision: "rev-a",
      bundleItems: [item],
    })).resolves.toHaveLength(1);
    await expect(projectBundleItemsForOwner({
      ownerInstanceId: "case-instance-a",
      ownerSkuId: "case.alpha",
      region: "US",
      revision: "rev-a",
      bundleItems: [item],
    })).resolves.toEqual([]);
    await expect(projectBundleItemsForOwner({
      ownerInstanceId: "case-instance-a",
      ownerSkuId: "case.alpha",
      region: "CN",
      bundleItems: [item],
    })).resolves.toEqual([]);
  });

  it("allocates by ownerInstanceId + bundleItemId and never double consumes", async () => {
    const bundled = await createBundleItem({
      schemaVersion: "bundle-item-v1",
      bundleItemId: "bundle.case.screw-m3",
      ownerSkuId: "case.alpha",
      kind: "fastener",
      specification: [
        { facetId: "resource.kind", value: "fastener" },
        { facetId: "fastener.thread", value: "m3" },
      ],
      quantity: 1,
      region: "CN",
      revision: "rev-a",
      variantScopeFactIds: ["fact-package-revision"],
      evidenceFactIds: ["fact-package-contents"],
    });
    const [caseA] = await projectBundleItemsForOwner({ ownerInstanceId: "case-a", ownerSkuId: "case.alpha", region: "CN", revision: "rev-a", bundleItems: [bundled] });
    const [caseB] = await projectBundleItemsForOwner({ ownerInstanceId: "case-b", ownerSkuId: "case.alpha", region: "CN", revision: "rev-a", bundleItems: [bundled] });
    const needs = ["need-a", "need-b", "need-c"].map((needId) => ({
      schemaVersion: "assembly-resource-need-v1" as const,
      needId,
      neededByStepId: `step-${needId}`,
      kind: "fastener" as const,
      specification: [{ facetId: "fastener.thread" as const, operator: "eq" as const, value: "m3" }],
      quantity: 1,
      criticality: "normal" as const,
      requiredBefore: "assembly" as const,
      evidenceFactIds: ["fact-mount-pattern"],
    }));

    const result = await allocateBundleSupplies(needs, [caseA!, caseB!]);
    expect(result.allocations).toHaveLength(2);
    expect(new Set(result.allocations.map((allocation) => `${allocation.ownerInstanceId}\0${allocation.bundleItemId}`)).size).toBe(2);
    expect(result.satisfactions.map(({ status }) => status)).toEqual(["satisfied", "satisfied", "open"]);
    expect(result.satisfactions[2]?.residualQuantity).toBe(1);
  });

  it("derives governed fastener/tool/consumable needs from a mount pattern", async () => {
    const pattern = await createAssemblyResourcePattern({
      schemaVersion: "assembly-resource-pattern-v1",
      patternId: "pattern.mount.m2-drive",
      mountStandardIds: ["mount.m2.2280"],
      needs: [
        { needTemplateId: "fastener", kind: "fastener", specification: [{ facetId: "fastener.thread", operator: "eq", value: "m2" }], quantity: 1, criticality: "normal", requiredBefore: "assembly" },
        { needTemplateId: "driver", kind: "tool", specification: [{ facetId: "tool.drive", operator: "eq", value: "phillips-0" }], quantity: 1, criticality: "normal", requiredBefore: "assembly" },
        { needTemplateId: "thermal-pad", kind: "consumable", specification: [{ facetId: "consumable.type", operator: "eq", value: "thermal-pad" }], quantity: 1, criticality: "normal", requiredBefore: "assembly" },
      ],
      evidenceFactIds: ["fact-m2-mount"],
    });
    const needs = await deriveAssemblyResourceNeeds(pattern, {
      mountStandardId: "mount.m2.2280",
      neededByStepId: "step-install-m2",
      requirementIdPrefix: "build-a",
    });
    expect(new Set(needs.map(({ kind }) => kind))).toEqual(new Set(["fastener", "tool", "consumable"]));
    await expect(deriveAssemblyResourceNeeds(pattern, { mountStandardId: "mount.pcie", neededByStepId: "step", requirementIdPrefix: "build-a" })).resolves.toEqual([]);
    await expect(deriveAssemblyResourceNeeds({ ...pattern, contentHash: "0".repeat(64) }, { mountStandardId: "mount.m2.2280", neededByStepId: "step", requirementIdPrefix: "build-a" })).rejects.toThrow(/content hash/);
  });

  it("is strict, total, NFC-bound, and content-addressed", async () => {
    const item = await createBundleItem({
      schemaVersion: "bundle-item-v1", bundleItemId: "bundle.café", ownerSkuId: "case.alpha", kind: "tool",
      specification: [{ facetId: "resource.kind", value: "tool" }], quantity: 1,
      variantScopeFactIds: ["fact-revision"], evidenceFactIds: ["fact-package"],
    });
    expect(item.bundleItemId).toBe("bundle.café");
    expect(validateBundleItem({ ...item, bundleItemId: "bundle.cafe\u0301" })).toContain("bundle item contains non-NFC text");
    expect(validateBundleItem({ ...item, callerTrusted: true })).toContain("bundle item contains unknown fields");
    expect(validateBundleItem({ ...item, kind: "fastener" })).toContain("bundle item resource.kind must exactly match kind");
    await expect(verifyBundleItem({ ...item, contentHash: "0".repeat(64) })).resolves.toBe(false);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => validateBundleItem(revoked.proxy)).not.toThrow();
    expect(validateBundleItem(revoked.proxy).length).toBeGreaterThan(0);
  });
});

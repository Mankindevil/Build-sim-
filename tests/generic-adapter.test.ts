import { describe, expect, it } from "vitest";
import n6SeedJson from "../data/cases/jonsbo-n6/adapter.json";
import genericSeedJson from "./fixtures/adapters/generic-atx-case.json";
import {
  CaseAdapterRegistry,
  materializeCaseAdapterFixtureSeed,
  verifyCaseAdapterArtifact,
  type CaseAdapterSeed,
} from "../src/adapters";
import { allocateBundleSupplies, projectBundleItemsForOwner } from "../src/assembly/resources";

const n6Seed = n6SeedJson as unknown as CaseAdapterSeed;
const genericSeed = genericSeedJson as unknown as CaseAdapterSeed;

describe("generic case adapter registry", () => {
  it("resolves only exact SKU + region + revision without case-specific core branches", async () => {
    const n6 = await materializeCaseAdapterFixtureSeed(n6Seed);
    const generic = await materializeCaseAdapterFixtureSeed(genericSeed);
    const registry = await CaseAdapterRegistry.create([n6.manifest, generic.manifest]);

    expect(registry.list().map((manifest) => manifest.identity.skuId)).toEqual([
      "case.jonsbo-n6",
      "fixture.case.atx-builder-v1",
    ]);
    expect(registry.resolve(n6.manifest.identity)?.contentHash).toBe(n6.manifest.contentHash);
    expect(registry.resolve({ ...n6.manifest.identity, revision: "wrong" })).toBeNull();
    expect(registry.resolve({ ...n6.manifest.identity, region: "US" })).toBeNull();
    expect(registry.resolve({ ...n6.manifest.identity, skuId: "case.unknown" })).toBeNull();
    await expect(registry.register(structuredClone(n6.manifest))).rejects.toThrow(/already registered/i);
    await expect(CaseAdapterRegistry.create([{ ...structuredClone(generic.manifest), contentHash: "0".repeat(64) }]))
      .rejects.toThrow(/content hash mismatch/i);
  });

  it("creates a content-addressed adapterSnapshot artifact usable by ArtifactLockfile", async () => {
    const n6 = await materializeCaseAdapterFixtureSeed(n6Seed);
    const generic = await materializeCaseAdapterFixtureSeed(genericSeed);
    const registry = await CaseAdapterRegistry.create([n6.manifest, generic.manifest]);
    const artifact = await registry.createArtifact();

    expect(artifact.ref).toMatchObject({
      role: "adapterSnapshot",
      domain: "artifact.adapter-snapshot",
      schemaVersion: "1.0.0",
      requiredForReplay: true,
    });
    expect(artifact.ref.contentHash).toBe(artifact.snapshotHash);
    await expect(verifyCaseAdapterArtifact(artifact)).resolves.toBe(true);

    const updated = await materializeCaseAdapterFixtureSeed({
      ...structuredClone(genericSeed),
      manifest: { ...structuredClone(genericSeed.manifest), adapterVersion: "1.0.1" },
    });
    const changed = await (await CaseAdapterRegistry.create([n6.manifest, updated.manifest])).createArtifact();
    expect(changed.snapshotHash).not.toBe(artifact.snapshotHash);
  });

  it("keeps package quantities instance-scoped and never double allocates one bundled item", async () => {
    const generic = await materializeCaseAdapterFixtureSeed(genericSeed);
    const identity = generic.manifest.identity;
    const supplies = await projectBundleItemsForOwner({
      ownerInstanceId: "case-instance-a",
      ownerSkuId: identity.skuId,
      region: identity.region,
      revision: identity.revision,
      bundleItems: generic.projection.assembly.bundleItems,
    });
    const wrongRevision = await projectBundleItemsForOwner({
      ownerInstanceId: "case-instance-a",
      ownerSkuId: identity.skuId,
      region: identity.region,
      revision: "B",
      bundleItems: generic.projection.assembly.bundleItems,
    });
    expect(wrongRevision).toEqual([]);

    const fasteners = supplies.filter((supply) => supply.kind === "fastener");
    expect(fasteners).toHaveLength(1);
    const needs = ["a", "b", "c"].map((suffix) => ({
      schemaVersion: "assembly-resource-need-v1" as const,
      needId: `need-${suffix}`,
      neededByStepId: `step-${suffix}`,
      kind: "fastener" as const,
      specification: [{ facetId: "fastener.thread" as const, operator: "eq" as const, value: "6-32" }],
      quantity: 1,
      criticality: "normal" as const,
      requiredBefore: "assembly" as const,
      region: identity.region,
      revision: identity.revision,
      evidenceFactIds: ["fact.fixture.case.package.fasteners"],
    }));
    const allocation = await allocateBundleSupplies(needs, fasteners);
    expect(allocation.satisfactions.map((entry) => entry.status)).toEqual(["satisfied", "satisfied", "open"]);
    await expect(allocateBundleSupplies(needs, [fasteners[0]!, fasteners[0]!])).rejects.toThrow(/duplicate ownerInstanceId \+ bundleItemId/i);
  });

  it("does not migrate legacy component defaults into the N6 case adapter", async () => {
    const n6 = await materializeCaseAdapterFixtureSeed(n6Seed);
    const serialized = JSON.stringify(n6.manifest).toLowerCase();
    for (const forbidden of ["samsung", "exos", "lsi-9300", "ownednvme", "defaultskuid"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(n6.projection.assembly.bundleItems.some((item) => item.kind === "cable")).toBe(false);
    expect(n6.projection.geometry.serviceCorridors.every((node) => node.binding.status === "provisional")).toBe(true);
  });
});

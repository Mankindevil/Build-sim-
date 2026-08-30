import { describe, expect, it } from "vitest";
import {
  CapabilityProviderRegistry,
  capabilityFactSnapshotRef,
  createCapabilityRecord,
  createStaticCapabilityProvider,
} from "../src/capabilities";
import { createFactSnapshot } from "../src/facts/snapshots";
import type { FactSnapshot } from "../src/facts/contracts";
import {
  buildRequirementCapabilityIndex,
  queryRequirementCapabilityIndex,
  validateRequirementCapabilityIndex,
  verifyRequirementCapabilityIndex,
} from "../src/capabilities/requirement-index";
import { loadBundledHardwareStandardLibrary, validateHardwareStandardLibrary, verifyHardwareStandardLibrary } from "../src/standards";

async function snapshot(factIds: string[]): Promise<FactSnapshot> {
  return createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: factIds.map((factId, index) => ({ factId, contentHash: (index % 16).toString(16).repeat(64) })),
    conflictRefs: [],
    createdAt: "2026-08-27T00:00:00.000Z",
  });
}

function factIdsFor(subjectSkuId: string): string[] {
  return [`fact-${subjectSkuId}-socket`, `fact-${subjectSkuId}-memory`, `fact-${subjectSkuId}-slots`];
}

async function record(subjectSkuId: string, socket: string, memory: string, slots: number, factSnapshot: FactSnapshot) {
  return createCapabilityRecord({
    schemaVersion: "capability-record-v1",
    subjectSkuId,
    componentKindId: "motherboard",
    factSnapshotRef: capabilityFactSnapshotRef(factSnapshot),
    facets: [
      { facetId: "motherboard.cpu_socket", value: socket, sourceFactIds: [`fact-${subjectSkuId}-socket`], safetyClass: "boot" },
      { facetId: "motherboard.memory_type", value: memory, sourceFactIds: [`fact-${subjectSkuId}-memory`], safetyClass: "boot" },
      { facetId: "motherboard.memory_slot_count", value: slots, unitId: "count", sourceFactIds: [`fact-${subjectSkuId}-slots`], safetyClass: "boot" },
    ],
    providerRefs: ["provider.fixture@1.0.0"],
  });
}

describe("requirement to capability index", () => {
  it("loads a content-addressed standard library covering the initial hardware families", async () => {
    const library = await loadBundledHardwareStandardLibrary();
    expect(validateHardwareStandardLibrary(library)).toEqual([]);
    await expect(verifyHardwareStandardLibrary(library)).resolves.toBe(true);
    expect(new Set(library.standards.map(({ family }) => family))).toEqual(new Set([
      "cpu_socket", "dimm", "pcie", "m2", "sata", "slimsas", "usb", "cooling_header", "power_connector",
    ]));
    for (const id of ["power.atx-24pin", "power.eps-8pin", "power.pcie-8pin", "power.12v-2x6", "cooling.fan-pwm-4pin", "cooling.pump-pwm-4pin"]) {
      expect(library.standards.some((standard) => standard.standardId === id), id).toBe(true);
    }
  });

  it("registers replayable providers and rejects duplicate/undeclared output", async () => {
    const factSnapshot = await snapshot(factIdsFor("board.alpha"));
    const alpha = await record("board.alpha", "lga1700", "ddr5", 4, factSnapshot);
    const provider = createStaticCapabilityProvider({
      providerId: "provider.fixture", providerVersion: "1.0.0", componentKindIds: ["motherboard"],
      facetIds: ["motherboard.cpu_socket", "motherboard.memory_type", "motherboard.memory_slot_count"],
      records: [alpha],
    });
    const registry = new CapabilityProviderRegistry([provider]);
    await expect(registry.resolve({ factSnapshot, componentKindIds: ["motherboard"] })).resolves.toEqual([alpha]);
    expect(() => registry.register(provider)).toThrow(/already registered/);

    const undeclared = createStaticCapabilityProvider({
      providerId: "provider.invalid", providerVersion: "1.0.0", componentKindIds: ["motherboard"],
      facetIds: ["motherboard.cpu_socket"], records: [alpha],
    });
    const invalidRegistry = new CapabilityProviderRegistry([undeclared]);
    await expect(invalidRegistry.resolve({ factSnapshot, componentKindIds: ["motherboard"] })).rejects.toThrow(/undeclared facet/);

    const outsideClosure = await createCapabilityRecord({
      schemaVersion: "capability-record-v1", subjectSkuId: "board.outside", componentKindId: "motherboard",
      factSnapshotRef: capabilityFactSnapshotRef(factSnapshot),
      facets: [{ facetId: "motherboard.cpu_socket", value: "lga1700", sourceFactIds: ["fact-not-in-snapshot"], safetyClass: "boot" }],
      providerRefs: ["provider.outside@1.0.0"],
    });
    const outsideProvider = createStaticCapabilityProvider({
      providerId: "provider.outside", providerVersion: "1.0.0", componentKindIds: ["motherboard"],
      facetIds: ["motherboard.cpu_socket"], records: [outsideClosure],
    });
    await expect(new CapabilityProviderRegistry([outsideProvider]).resolve({ factSnapshot, componentKindIds: ["motherboard"] }))
      .rejects.toThrow(/outside the exact fact snapshot/);
  });

  it("queries only allowlisted facet predicates against the exact same fact snapshot", async () => {
    const factSnapshot = await snapshot(["board.alpha", "board.beta", "board.gamma"].flatMap(factIdsFor));
    const factSnapshotRef = capabilityFactSnapshotRef(factSnapshot);
    const index = await buildRequirementCapabilityIndex([
      await record("board.alpha", "lga1700", "ddr5", 4, factSnapshot),
      await record("board.beta", "am5", "ddr5", 2, factSnapshot),
      await record("board.gamma", "lga1700", "ddr4", 4, factSnapshot),
    ], factSnapshot);
    expect(validateRequirementCapabilityIndex(index)).toEqual([]);
    await expect(queryRequirementCapabilityIndex(index, {
      factSnapshotRef,
      componentKindId: "motherboard",
      predicates: [
        { facetId: "motherboard.cpu_socket", operator: "eq", value: "lga1700" },
        { facetId: "motherboard.memory_type", operator: "eq", value: "ddr5" },
        { facetId: "motherboard.memory_slot_count", operator: "gte", value: 4, unitId: "count" },
      ],
    })).resolves.toEqual([expect.objectContaining({ subjectSkuId: "board.alpha" })]);
    const otherHash = "d".repeat(64);
    await expect(queryRequirementCapabilityIndex(index, {
      factSnapshotRef: { snapshotId: `fact-snapshot-sha256-${otherHash}`, contentHash: otherHash },
      componentKindId: "motherboard", predicates: [],
    })).rejects.toThrow(/fact snapshot mismatch/);
    await expect(queryRequirementCapabilityIndex(index, {
      factSnapshotRef, componentKindId: "motherboard",
      predicates: [{ facetId: "identity.manufacturer", operator: "eq", value: "Brand" }],
    })).rejects.toThrow(/not candidate-index allowlisted/);
    await expect(queryRequirementCapabilityIndex(index, { factSnapshotRef, componentKindId: "motherboard", predicates: [], search: "board.alpha" } as never)).rejects.toThrow(/unknown fields/);
  });

  it("fails closed for mixed snapshots, unknown fields and modified content", async () => {
    const factSnapshot = await snapshot(factIdsFor("board.alpha"));
    const factSnapshotRef = capabilityFactSnapshotRef(factSnapshot);
    const alpha = await record("board.alpha", "lga1700", "ddr5", 4, factSnapshot);
    const otherSnapshot = await snapshot(["fact-mixed"]);
    const mixed = await createCapabilityRecord({
      schemaVersion: "capability-record-v1", subjectSkuId: "board.mixed", componentKindId: "motherboard",
      factSnapshotRef: capabilityFactSnapshotRef(otherSnapshot),
      facets: [{ facetId: "motherboard.cpu_socket", value: "am5", sourceFactIds: ["fact-mixed"], safetyClass: "boot" }],
      providerRefs: ["provider.fixture@1.0.0"],
    });
    await expect(buildRequirementCapabilityIndex([mixed], factSnapshot)).rejects.toThrow(/fact snapshot/);
    const index = await buildRequirementCapabilityIndex([alpha], factSnapshot);
    expect(validateRequirementCapabilityIndex({ ...index, magic: true })).toContain("requirement capability index contains unknown fields");
    await expect(verifyRequirementCapabilityIndex({ ...index, contentHash: "0".repeat(64) })).resolves.toBe(false);
    await expect(queryRequirementCapabilityIndex({ ...index, contentHash: "0".repeat(64) }, { factSnapshotRef, componentKindId: "motherboard", predicates: [] })).rejects.toThrow(/content hash/);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => validateRequirementCapabilityIndex(revoked.proxy)).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import baseSeedJson from "./fixtures/adapters/generic-atx-case.json";
import matrixJson from "./fixtures/adapters/case-layout-matrix.json";
import n6SeedJson from "../data/cases/jonsbo-n6/adapter.json";
import { CaseAdapterRegistry } from "../src/adapters/registry";
import {
  materializeCaseAdapterFixtureSeed,
  type MaterializedCaseAdapterSeed,
} from "../src/adapters/data-driven-case";
import type {
  CaseAdapterSeed,
  CaseManifestBinding,
  CaseMount,
} from "../src/adapters/contracts";

interface MatrixCase {
  fixtureId: string;
  vendorId: string;
  skuId: string;
  adapterId: string;
  revision: string;
  layout: string;
  motherboardStandardId: string;
  envelopeMm: [number, number, number];
  driveBayCount: number;
  backplane: boolean;
}

const matrix = matrixJson as { schemaVersion: string; cases: MatrixCase[] };

function verified(sourceFactId: string): CaseManifestBinding {
  return { status: "verified", sourceFactIds: [sourceFactId], derivationIds: [], uncertaintyMm: 0 };
}

function provisional(sourceFactId: string, derivationId: string, uncertaintyMm: number): CaseManifestBinding {
  return { status: "provisional", sourceFactIds: [sourceFactId], derivationIds: [derivationId], uncertaintyMm };
}

function seedFor(entry: MatrixCase): CaseAdapterSeed {
  const seed = structuredClone(baseSeedJson) as unknown as CaseAdapterSeed;
  const [width, height, depth] = entry.envelopeMm;
  const identity = {
    skuId: entry.skuId,
    region: "global",
    revision: entry.revision,
    identityFactIds: ["fact.fixture.case.identity.revision"],
  };
  seed.manifest.adapterId = entry.adapterId;
  seed.manifest.adapterVersion = "1.0.0";
  seed.manifest.identity = identity;
  seed.manifest.sourceRefs = [`fixture://${entry.vendorId}/${entry.layout}/${entry.revision}`];
  seed.manifest.geometry = {
    envelope: {
      nodeId: "case.envelope", centerMm: [0, 0, 0], sizeMm: entry.envelopeMm,
      binding: { status: "verified", sourceFactIds: ["fact.fixture.case.width", "fact.fixture.case.height", "fact.fixture.case.depth"], derivationIds: [], uncertaintyMm: 0 },
    },
    interiorSpaces: [{
      nodeId: `space.${entry.layout}`, centerMm: [0, 0, 0], sizeMm: [width - 20, height - 20, depth - 20],
      binding: provisional("fact.fixture.case.depth", `derive.${entry.fixtureId}.interior`, 2),
    }],
    forbiddenZones: [{
      nodeId: `forbidden.${entry.layout}.front`, centerMm: [0, 0, -depth / 2 + 5], sizeMm: [width - 20, height - 20, 10],
      binding: provisional("fact.fixture.case.gpu-max", `derive.${entry.fixtureId}.front-zone`, 3),
    }],
    serviceCorridors: [{
      nodeId: `corridor.${entry.layout}.rear`, centerMm: [width / 2 - 5, 0, 0], sizeMm: [10, height - 20, depth - 20],
      binding: provisional("fact.fixture.case.cable-families", `derive.${entry.fixtureId}.rear-route`, 3),
    }],
  };
  const mounts: CaseMount[] = [
    {
      mountId: `mount.board.${entry.layout}`, kind: "motherboard", standardIds: [entry.motherboardStandardId], quantity: 1,
      location: "main", binding: verified("fact.fixture.case.mounts"),
    },
    {
      mountId: `mount.psu.${entry.layout}`, kind: "psu", standardIds: ["mount.psu.atx"], quantity: 1,
      location: "rear", binding: verified("fact.fixture.case.mounts"),
    },
    {
      mountId: `mount.drive.${entry.layout}`, kind: "drive", standardIds: ["mount.drive.3.5", "mount.drive.2.5"], quantity: entry.driveBayCount,
      location: "front", binding: verified("fact.fixture.case.mounts"),
    },
    {
      mountId: `mount.fan.${entry.layout}`, kind: "fan", standardIds: ["mount.fan.120"], quantity: 2,
      location: "front", binding: verified("fact.fixture.case.fan-mounts"),
    },
  ];
  if (entry.backplane) mounts.push({
    mountId: `mount.backplane.${entry.layout}`, kind: "backplane", standardIds: ["mount.backplane.sata"], quantity: 1,
    location: "front", binding: verified("fact.fixture.case.mounts"),
  });
  seed.manifest.mounts = mounts;
  seed.manifest.ports = [{
    portId: `port.${entry.layout}.front-usb`, connectorStandardId: "usb.internal-3.2-gen1-19pin", direction: "bidirectional", quantity: 1,
    anchorMm: [width / 2 - 5, height / 2 - 5, -depth / 2 + 5],
    binding: provisional("fact.fixture.case.front-port", `derive.${entry.fixtureId}.front-port`, 4),
  }];
  seed.manifest.routingZones = [{
    zoneId: `route.${entry.layout}.rear`, kind: "channel", centerMm: [width / 2 - 5, 0, 0], sizeMm: [10, height - 20, depth - 20], connectsToZoneIds: [],
    binding: provisional("fact.fixture.case.cable-families", `derive.${entry.fixtureId}.route`, 3),
  }];
  seed.manifest.assemblyConstraints = [{
    constraintId: `constraint.${entry.layout}.board-before-cables`, beforeActionId: "install.board", afterActionId: "route.front-io",
    binding: verified("fact.fixture.case.tool-required"),
  }];
  seed.manifest.bundleItems = seed.manifest.bundleItems.map((item) => ({
    ...item, ownerSkuId: entry.skuId, region: "global", revision: entry.revision,
  }));
  seed.manifest.resourcePatterns = seed.manifest.resourcePatterns.map((pattern) => ({
    ...pattern, mountStandardIds: [entry.motherboardStandardId],
  }));
  seed.evidenceSources = seed.evidenceSources.map((source) => ({
    ...source,
    evidenceSourceId: `${entry.fixtureId}.official-manual`,
    subject: { ...source.subject, skuId: entry.skuId, familyId: `${entry.skuId}.family`, modelId: entry.fixtureId, variantId: `${entry.fixtureId}-${entry.revision}`, revision: entry.revision, region: "global" },
  }));
  seed.factInputs = seed.factInputs.map((fact) => {
    let value = fact.value;
    if (fact.field === "identity.revision") value = entry.revision;
    if (fact.field === "physical.width") value = width;
    if (fact.field === "physical.height") value = height;
    if (fact.field === "physical.depth") value = depth;
    if (fact.field === "mount.point_ids") value = mounts.map((mount) => mount.mountId);
    if (fact.field === "case.motherboard_form_factors") value = [entry.motherboardStandardId.replace("mount.motherboard.", "")];
    return {
      ...fact,
      subject: { kind: "product", skuId: entry.skuId, revision: entry.revision, region: "global" },
      value,
    };
  });
  return seed;
}

describe("U5 ordinary case adapter fixture matrix", () => {
  it("materializes ATX, mATX, Mini-ITX and NAS-backplane layouts from two vendors", async () => {
    expect(matrix.schemaVersion).toBe("case-adapter-fixture-matrix-v1");
    const materialized = await Promise.all(matrix.cases.map((entry) => materializeCaseAdapterFixtureSeed(seedFor(entry))));
    const n6 = await materializeCaseAdapterFixtureSeed(n6SeedJson as unknown as CaseAdapterSeed);
    const registry = await CaseAdapterRegistry.create([n6.manifest, ...materialized.map((entry) => entry.manifest)]);

    expect(new Set(matrix.cases.map((entry) => entry.vendorId)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(matrix.cases.map((entry) => entry.layout)).size).toBeGreaterThanOrEqual(3);
    expect(matrix.cases.map((entry) => entry.motherboardStandardId)).toEqual(expect.arrayContaining([
      "mount.motherboard.atx", "mount.motherboard.micro-atx", "mount.motherboard.mini-itx",
    ]));
    expect(matrix.cases.some((entry) => entry.backplane)).toBe(true);
    expect(registry.list()).toHaveLength(matrix.cases.length + 1);

    for (const [index, entry] of matrix.cases.entries()) {
      const resolved = registry.resolve({ skuId: entry.skuId, region: "global", revision: entry.revision });
      expect(resolved?.contentHash).toBe(materialized[index]!.manifest.contentHash);
      expect(materialized[index]!.projection.geometry.envelope.sizeMm).toEqual(entry.envelopeMm);
      expect(materialized[index]!.projection.mounts.some((mount) => mount.kind === "backplane")).toBe(entry.backplane);
    }
  });

  it("adds another ordinary case without changing registry or projection code", async () => {
    const first = await materializeCaseAdapterFixtureSeed(seedFor(matrix.cases[0]!));
    const second = await materializeCaseAdapterFixtureSeed(seedFor(matrix.cases[1]!));
    const before = await CaseAdapterRegistry.create([first.manifest]);
    const after = await CaseAdapterRegistry.create([first.manifest, second.manifest]);
    expect(before.resolve(second.manifest.identity)).toBeNull();
    expect(after.resolve(second.manifest.identity)?.contentHash).toBe(second.manifest.contentHash);
    expect(after.resolve(first.manifest.identity)?.contentHash).toBe(first.manifest.contentHash);
  });
});

import baseSeedJson from "../fixtures/adapters/generic-atx-case.json";
import type { CaseAdapterSeed, CaseManifestBinding, CaseMount } from "../../src/adapters/contracts";

export interface MatrixCase {
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

function verified(sourceFactId: string): CaseManifestBinding {
  return { status: "verified", sourceFactIds: [sourceFactId], derivationIds: [], uncertaintyMm: 0 };
}

function provisional(sourceFactId: string, derivationId: string, uncertaintyMm: number): CaseManifestBinding {
  return { status: "provisional", sourceFactIds: [sourceFactId], derivationIds: [derivationId], uncertaintyMm };
}

/** One deterministic seed compiler shared by manifest and runtime matrix tests. */
export function seedForMatrixCase(entry: MatrixCase): CaseAdapterSeed {
  const seed = structuredClone(baseSeedJson) as unknown as CaseAdapterSeed;
  const [width, height, depth] = entry.envelopeMm;
  seed.manifest.adapterId = entry.adapterId;
  seed.manifest.adapterVersion = "1.0.0";
  seed.manifest.identity = {
    skuId: entry.skuId,
    region: "global",
    revision: entry.revision,
    identityFactIds: ["fact.fixture.case.identity.revision"],
  };
  seed.manifest.sourceRefs = [`fixture://${entry.vendorId}/${entry.layout}/${entry.revision}`];
  seed.manifest.geometry = {
    envelope: {
      nodeId: "case.envelope",
      centerMm: [0, 0, 0],
      sizeMm: entry.envelopeMm,
      binding: {
        status: "verified",
        sourceFactIds: ["fact.fixture.case.width", "fact.fixture.case.height", "fact.fixture.case.depth"],
        derivationIds: [],
        uncertaintyMm: 0,
      },
    },
    interiorSpaces: [{
      nodeId: `space.${entry.layout}`,
      centerMm: [0, 0, 0],
      sizeMm: [width - 20, height - 20, depth - 20],
      binding: provisional("fact.fixture.case.depth", `derive.${entry.fixtureId}.interior`, 2),
    }],
    forbiddenZones: [{
      nodeId: `forbidden.${entry.layout}.front`,
      centerMm: [0, 0, -depth / 2 + 5],
      sizeMm: [width - 20, height - 20, 10],
      binding: provisional("fact.fixture.case.gpu-max", `derive.${entry.fixtureId}.front-zone`, 3),
    }],
    serviceCorridors: [{
      nodeId: `corridor.${entry.layout}.rear`,
      centerMm: [width / 2 - 5, 0, 0],
      sizeMm: [10, height - 20, depth - 20],
      binding: provisional("fact.fixture.case.cable-families", `derive.${entry.fixtureId}.rear-route`, 3),
    }],
  };
  const mounts: CaseMount[] = [
    { mountId: `mount.board.${entry.layout}`, kind: "motherboard", standardIds: [entry.motherboardStandardId], quantity: 1, location: "main", binding: verified("fact.fixture.case.mounts") },
    { mountId: `mount.psu.${entry.layout}`, kind: "psu", standardIds: ["mount.psu.atx"], quantity: 1, location: "rear", binding: verified("fact.fixture.case.mounts") },
    { mountId: `mount.drive.${entry.layout}`, kind: "drive", standardIds: ["mount.drive.3.5", "mount.drive.2.5"], quantity: entry.driveBayCount, location: "front", binding: verified("fact.fixture.case.mounts") },
    { mountId: `mount.fan.${entry.layout}`, kind: "fan", standardIds: ["mount.fan.120"], quantity: 2, location: "front", binding: verified("fact.fixture.case.fan-mounts") },
  ];
  if (entry.backplane) mounts.push({
    mountId: `mount.backplane.${entry.layout}`,
    kind: "backplane",
    standardIds: ["mount.backplane.sata"],
    quantity: 1,
    location: "front",
    binding: verified("fact.fixture.case.mounts"),
  });
  seed.manifest.mounts = mounts;
  seed.manifest.ports = [
    {
      portId: `port.${entry.layout}.front-usb`,
      connectorStandardId: "usb.internal-3.2-gen1-19pin",
      direction: "output",
      quantity: 1,
      anchorMm: [width / 2 - 5, height / 2 - 15, -depth / 2 + 15],
      binding: provisional("fact.fixture.case.front-port", `derive.${entry.fixtureId}.front-port`, 4),
    },
    {
      portId: `port.${entry.layout}.board-usb`,
      connectorStandardId: "usb.internal-3.2-gen1-19pin",
      direction: "input",
      quantity: 1,
      anchorMm: [width / 2 - 5, -height / 2 + 15, depth / 2 - 15],
      binding: provisional("fact.fixture.case.front-port", `derive.${entry.fixtureId}.board-port`, 4),
    },
  ];
  seed.manifest.routingZones = [{
    zoneId: `route.${entry.layout}.rear`,
    kind: "channel",
    centerMm: [width / 2 - 5, 0, 0],
    sizeMm: [10, height - 20, depth - 20],
    connectsToZoneIds: [],
    binding: provisional("fact.fixture.case.cable-families", `derive.${entry.fixtureId}.route`, 3),
  }];
  seed.manifest.assemblyConstraints = [{
    constraintId: `constraint.${entry.layout}.board-before-cables`,
    beforeActionId: "install.board",
    afterActionId: "route.front-io",
    binding: verified("fact.fixture.case.tool-required"),
  }];
  seed.manifest.bundleItems = seed.manifest.bundleItems.map((item) => ({ ...item, ownerSkuId: entry.skuId, region: "global", revision: entry.revision }));
  seed.manifest.resourcePatterns = seed.manifest.resourcePatterns.map((pattern) => ({ ...pattern, mountStandardIds: [entry.motherboardStandardId] }));
  seed.evidenceSources = seed.evidenceSources.map((source) => ({
    ...source,
    evidenceSourceId: `${entry.fixtureId}.official-manual`,
    subject: {
      ...source.subject,
      skuId: entry.skuId,
      familyId: `${entry.skuId}.family`,
      modelId: entry.fixtureId,
      variantId: `${entry.fixtureId}-${entry.revision}`,
      revision: entry.revision,
      region: "global",
    },
  }));
  seed.factInputs = seed.factInputs.map((fact) => {
    let value = fact.value;
    if (fact.field === "identity.revision") value = entry.revision;
    if (fact.field === "physical.width") value = width;
    if (fact.field === "physical.height") value = height;
    if (fact.field === "physical.depth") value = depth;
    if (fact.field === "mount.point_ids") value = mounts.map((mount) => mount.mountId);
    if (fact.field === "case.motherboard_form_factors") value = [entry.motherboardStandardId.replace("mount.motherboard.", "")];
    return { ...fact, subject: { kind: "product", skuId: entry.skuId, revision: entry.revision, region: "global" }, value };
  });
  return seed;
}

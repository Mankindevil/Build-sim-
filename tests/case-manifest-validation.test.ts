import { describe, expect, it } from "vitest";
import n6SeedJson from "../data/cases/jonsbo-n6/adapter.json";
import genericSeedJson from "./fixtures/adapters/generic-atx-case.json";
import {
  createCaseAdapterManifest,
  materializeCaseAdapterFixtureSeed,
  projectCaseAdapterAtRoot,
  validateCaseAdapterManifestInput,
  verifyCaseAdapterManifest,
  type CaseAdapterSeed,
  type CaseAdapterManifestInput,
} from "../src/adapters";
import { createFactRecord } from "../src/facts/hash";
import { createFactSnapshot } from "../src/facts/snapshots";

const n6Seed = n6SeedJson as unknown as CaseAdapterSeed;
const genericSeed = genericSeedJson as unknown as CaseAdapterSeed;

function authorityFor(factClosure: Awaited<ReturnType<typeof materializeCaseAdapterFixtureSeed>>["factClosure"]) {
  return {
    authorityKind: "fact-repository-root-bound-v1" as const,
    resolveExactCaseAdapterFactClosureAtRoot: async () => structuredClone(factClosure),
  };
}

describe("data-driven case manifest authority", () => {
  it("materializes N6 and a non-N6 case from governed exact fact snapshots", async () => {
    for (const seed of [n6Seed, genericSeed]) {
      const materialized = await materializeCaseAdapterFixtureSeed(seed);
      expect(validateCaseAdapterManifestInput(seed.manifest)).toEqual([]);
      await expect(verifyCaseAdapterManifest(materialized.manifest)).resolves.toBe(true);
      expect(materialized.factClosure.snapshot.factRefs).toHaveLength(seed.factInputs.length);
      expect(materialized.projection.capabilityRecord.factSnapshotRef).toEqual({
        snapshotId: materialized.factClosure.snapshot.snapshotId,
        contentHash: materialized.factClosure.snapshot.contentHash,
      });
      expect(materialized.projection.capabilityRecord.facets.every((facet) => facet.sourceFactIds.length > 0)).toBe(true);
    }
  });

  it("requires every non-exact anchor to remain provisional with derivation and uncertainty", async () => {
    const input = structuredClone(n6Seed.manifest) as CaseAdapterManifestInput;
    const provisional = input.geometry.serviceCorridors[0]!;
    expect(provisional.binding.status).toBe("provisional");
    expect(provisional.binding.derivationIds.length).toBeGreaterThan(0);
    expect(provisional.binding.uncertaintyMm).toBeGreaterThan(0);

    provisional.binding = { ...provisional.binding, status: "verified", derivationIds: [], uncertaintyMm: 8 };
    expect(validateCaseAdapterManifestInput(input)).toContainEqual(expect.stringMatching(/verified.*uncertainty/i));
    await expect(createCaseAdapterManifest(input)).rejects.toThrow(/verified.*uncertainty/i);

    const missingDerivation = structuredClone(n6Seed.manifest) as CaseAdapterManifestInput;
    missingDerivation.geometry.serviceCorridors[0]!.binding.derivationIds = [];
    expect(validateCaseAdapterManifestInput(missingDerivation)).toContainEqual(expect.stringMatching(/provisional.*derivation/i));
  });

  it("fails closed on unknown fields, malformed geometry, and dangling source facts", async () => {
    const unknown = { ...structuredClone(n6Seed.manifest), callerTrusted: true };
    expect(validateCaseAdapterManifestInput(unknown)).toContainEqual(expect.stringMatching(/unknown|missing/i));

    const malformed = structuredClone(n6Seed.manifest) as CaseAdapterManifestInput;
    malformed.geometry.envelope.sizeMm[0] = 0;
    expect(validateCaseAdapterManifestInput(malformed)).toContainEqual(expect.stringMatching(/envelope.*size/i));

    const materialized = await materializeCaseAdapterFixtureSeed(n6Seed);
    const dangling = structuredClone(materialized.manifest);
    dangling.capabilityBindings[0]!.sourceFactIds = ["fact.not-in-snapshot"];
    const rehashed = await createCaseAdapterManifest(dangling);
    await expect(projectCaseAdapterAtRoot(rehashed, "/fixture-root", authorityFor(materialized.factClosure))).rejects.toThrow(/outside.*fact snapshot/i);
  });

  it("rejects out-of-envelope spatial nodes and cyclic assembly constraints", () => {
    const outsideInterior = structuredClone(genericSeed.manifest) as CaseAdapterManifestInput;
    outsideInterior.geometry.interiorSpaces[0]!.centerMm[0] = 10_000;
    expect(validateCaseAdapterManifestInput(outsideInterior)).toContainEqual(expect.stringMatching(/interiorSpaces\.0 exceeds case envelope/i));

    const outsidePort = structuredClone(genericSeed.manifest) as CaseAdapterManifestInput;
    outsidePort.ports[0]!.anchorMm[2] = -10_000;
    expect(validateCaseAdapterManifestInput(outsidePort)).toContainEqual(expect.stringMatching(/ports\.0 anchor exceeds case envelope/i));

    const outsideRoute = structuredClone(genericSeed.manifest) as CaseAdapterManifestInput;
    outsideRoute.routingZones[0]!.sizeMm[0] = 10_000;
    expect(validateCaseAdapterManifestInput(outsideRoute)).toContainEqual(expect.stringMatching(/routingZones\.0 exceeds case envelope/i));

    const cycle = structuredClone(genericSeed.manifest) as CaseAdapterManifestInput;
    const first = cycle.assemblyConstraints[0]!;
    cycle.assemblyConstraints.push({
      ...structuredClone(first),
      constraintId: "constraint.cycle",
      beforeActionId: first.afterActionId,
      afterActionId: first.beforeActionId,
    });
    expect(validateCaseAdapterManifestInput(cycle)).toContain("assembly constraints contain a dependency cycle");
  });

  it("rejects cross-SKU, cross-region, and cross-revision fact closures", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const attacks = [
      { skuId: "fixture.case.sibling" },
      { region: "US" },
      { revision: "B" },
    ];
    for (const attack of attacks) {
      const factClosure = structuredClone(materialized.factClosure);
      factClosure.facts[0]!.subject = { ...factClosure.facts[0]!.subject, ...attack } as never;
      await expect(projectCaseAdapterAtRoot(materialized.manifest, "/fixture-root", authorityFor(factClosure))).rejects.toThrow(/fact closure|exact adapter identity|content hash/i);
    }
  });

  it("rejects a freshly rehashed official fact whose claim is absent or does not attest its value", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    const original = materialized.factClosure.facts.find((fact) => fact.factId === "fact.fixture.case.width")!;
    const { contentHash: _oldHash, ...input } = original;
    const forged = await createFactRecord({
      ...input,
      value: 999,
      evidenceRefs: [`claim-sha256-${"0".repeat(64)}`],
    });
    const facts = materialized.factClosure.facts.map((fact) => fact.factId === forged.factId ? forged : fact);
    const snapshot = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash })),
      conflictRefs: [],
      createdAt: materialized.factClosure.snapshot.createdAt,
    });
    await expect(projectCaseAdapterAtRoot(materialized.manifest, "/fixture-root", authorityFor({
      snapshot,
      facts,
      conflicts: [],
      evidenceClaims: materialized.factClosure.evidenceClaims,
    }))).rejects.toThrow(/unverified evidence claim|exact fact.*value/i);
  });

  it("derives fact authority from verified claims instead of trusting the seed fact field", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(n6Seed);
    expect(n6Seed.factInputs.find((fact) => fact.factId === "fact.case.jonsbo-n6.identity.revision")?.authority).toBe("official");
    expect(materialized.factClosure.facts.find((fact) => fact.factId === "fact.case.jonsbo-n6.identity.revision")?.authority).toBe("third_party");
  });

  it("fails closed when a raw closure is passed where production requires root-bound authority", async () => {
    const materialized = await materializeCaseAdapterFixtureSeed(genericSeed);
    await expect(projectCaseAdapterAtRoot(
      materialized.manifest,
      "/runtime-root",
      materialized.factClosure as never,
    )).rejects.toThrow(/root-bound FactRepository authority/i);
  });
});

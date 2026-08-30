import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import adapterSeed from "../data/cases/jonsbo-n6/adapter.json";
import profile from "../data/cases/jonsbo-n6/profile.json";
import geometry from "../data/cases/jonsbo-n6/geometry.json";
import routing from "../data/cases/jonsbo-n6/routing.json";
import assembly from "../data/cases/jonsbo-n6/assembly.json";
import calibration from "../data/cases/jonsbo-n6/calibration.json";
import {
  caseRuntimeModelContentHash,
  compileLockedCaseAdapterRuntime,
  createCaseRuntimeModel,
  materializeCaseAdapterFixtureSeed,
  validateCaseRuntimeModel,
  verifyCaseRuntimeModel,
  type CaseAdapterManifest,
  type CaseAdapterSeed,
  type CaseRuntimeModel,
} from "../src/adapters";
import {
  caseRuntimeModelContentHashRuntime,
  runtimeModelSnapshotReferencesRuntime,
  validateCaseRuntimeModelRuntime,
  verifyCaseRuntimeModelRuntime,
} from "../src/adapters/runtime-model-runtime.mjs";

type N6Documents = {
  profile: typeof profile;
  geometry: typeof geometry;
  routing: typeof routing;
  assembly: typeof assembly;
  calibration: typeof calibration;
};
type MutableN6Model = Omit<CaseRuntimeModel, "documents"> & { documents: N6Documents };

async function n6Model(): Promise<{ manifest: CaseAdapterManifest; model: CaseRuntimeModel }> {
  const { manifest } = await materializeCaseAdapterFixtureSeed(adapterSeed as unknown as CaseAdapterSeed);
  const model = await createCaseRuntimeModel(manifest, {
    schemaVersion: "case-runtime-model-v1",
    runtimeId: "runtime.case.jonsbo-n6",
    runtimeVersion: "1.0.0",
    interpreterId: "declarative-case-v1",
    authorityStatus: "legacy_unverified",
    authorityRefs: { factIds: [], derivationIds: [], evidenceContentHashes: [] },
    identity: { skuId: manifest.identity.skuId, region: manifest.identity.region, revision: manifest.identity.revision },
    manifestHash: manifest.contentHash,
    documents: {
      profile: structuredClone(profile), geometry: structuredClone(geometry), routing: structuredClone(routing),
      assembly: structuredClone(assembly), calibration: structuredClone(calibration),
    },
    sourceRefs: [
      "data/cases/jonsbo-n6/profile.json", "data/cases/jonsbo-n6/geometry.json",
      "data/cases/jonsbo-n6/routing.json", "data/cases/jonsbo-n6/assembly.json",
      "data/cases/jonsbo-n6/calibration.json",
    ],
  });
  return { manifest, model };
}

async function checksumCorrectForgery(
  source: CaseRuntimeModel,
  mutate: (model: MutableN6Model) => void,
): Promise<CaseRuntimeModel> {
  const forged = structuredClone(source) as unknown as MutableN6Model;
  mutate(forged);
  const contentHash = caseRuntimeModelContentHashRuntime(forged);
  if (contentHash === null) throw new TypeError("mutation unexpectedly stopped being canonical JSON");
  forged.contentHash = contentHash;
  return forged;
}

describe("case runtime model total validation", () => {
  it("uses one TS/MJS verifier and hash contract for the valid data-only N6 model", async () => {
    const { manifest, model } = await n6Model();
    expect(validateCaseRuntimeModel(model, manifest)).toEqual([]);
    expect(validateCaseRuntimeModelRuntime(model, manifest)).toEqual([]);
    expect(verifyCaseRuntimeModelRuntime(model, manifest)).toBe(true);
    await expect(verifyCaseRuntimeModel(manifest, model)).resolves.toBe(true);
    await expect(caseRuntimeModelContentHash(model)).resolves.toBe(caseRuntimeModelContentHashRuntime(model));
    expect(runtimeModelSnapshotReferencesRuntime(model, manifest)).toEqual({
      manifestHash: manifest.contentHash,
      runtimeModelHash: model.contentHash,
      sourceRefs: model.sourceRefs,
      factIds: [],
      derivationIds: [],
      evidenceContentHashes: [],
    });
    await expect(compileLockedCaseAdapterRuntime(manifest, model)).resolves.toMatchObject({
      authorityStatus: "legacy_unverified",
      domains: { geometry: { status: "ready" }, wiring: { status: "ready" }, routing: { status: "ready" } },
    });
  });

  it("rejects checksum-correct nested/document/cross-reference forgeries with TS/MJS parity", async () => {
    const { manifest, model } = await n6Model();
    const cases: Array<{ name: string; mutate(value: MutableN6Model): void }> = [
      {
        name: "profile unknown key",
        mutate: (value) => { Object.assign(value.documents.profile.runtime.fanMounts[0]!, { ungovernedFlag: true }); },
      },
      {
        name: "profile manifest mount cross-reference",
        mutate: (value) => { Object.assign(value.documents.profile.runtime.mountPartIds, { "mount.not-in-manifest": "board" }); },
      },
      {
        name: "backplane inlet order/count mismatch",
        mutate: (value) => {
          value.documents.profile.lowerChamber.backplane.inletRowOrder = ["sata", "sata", "sata", "molex"];
        },
      },
      {
        name: "geometry AABB outside envelope",
        mutate: (value) => { value.documents.geometry.board.c[0] = 10_000; },
      },
      {
        name: "routing required semantic port removed",
        mutate: (value) => {
          value.documents.routing.ports = value.documents.routing.ports.filter((port) => port.id !== "port.board.atx24");
        },
      },
      {
        name: "routing edge dangling",
        mutate: (value) => { value.documents.routing.edges[0]!.to = "wp.not-declared"; },
      },
      {
        name: "assembly dependency cycle",
        mutate: (value) => {
          value.documents.assembly.declared.push(
            { id: "forged.cycle.a", before: "step.a", after: "step.b", evidence: "inferred", source: "forgery fixture" },
            { id: "forged.cycle.b", before: "step.b", after: "step.a", evidence: "inferred", source: "forgery fixture" },
          );
        },
      },
      {
        name: "calibration nested unit",
        mutate: (value) => { value.documents.calibration.wallPowerW.unit = "V"; },
      },
      {
        name: "governed authority without closure",
        mutate: (value) => { value.authorityStatus = "governed_fact_derivation_bound"; },
      },
      {
        name: "unrelated governed fact smuggling",
        mutate: (value) => {
          value.authorityStatus = "governed_fact_derivation_bound";
          value.authorityRefs.factIds = ["fact.unrelated.but-valid"];
          value.authorityRefs.derivationIds = ["derivation.unrelated.but-valid"];
          value.authorityRefs.evidenceContentHashes = ["a".repeat(64)];
        },
      },
      {
        name: "legacy authority carrying governed references",
        mutate: (value) => { value.authorityRefs.factIds.push("fact.forged.runtime"); },
      },
    ];

    for (const entry of cases) {
      const forged = await checksumCorrectForgery(model, entry.mutate);
      expect(forged.contentHash, entry.name).toBe(caseRuntimeModelContentHashRuntime(forged));
      const jsErrors = validateCaseRuntimeModelRuntime(forged, manifest);
      expect(jsErrors.length, entry.name).toBeGreaterThan(0);
      expect(validateCaseRuntimeModel(forged, manifest), entry.name).toEqual(jsErrors);
      expect(verifyCaseRuntimeModelRuntime(forged, manifest), entry.name).toBe(false);
      await expect(verifyCaseRuntimeModel(manifest, forged), entry.name).resolves.toBe(false);
      await expect(compileLockedCaseAdapterRuntime(manifest, forged), entry.name).rejects.toThrow(/integrity invalid/i);
    }
  });

  it("keeps the flag-on static module graph free of per-case TypeScript implementation", () => {
    const workspace = resolve(import.meta.dirname, "..");
    const entry = resolve(workspace, "tests/setup-case-runtime.ts");
    const visited = new Set<string>();
    const pending = [entry];
    const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
    const resolveModule = (from: string, specifier: string): string | null => {
      if (!specifier.startsWith(".")) return null;
      const base = resolve(dirname(from), specifier);
      const candidates = extname(base) ? [base] : [`${base}.ts`, `${base}.mts`, `${base}.mjs`, resolve(base, "index.ts")];
      return candidates.find((candidate) => existsSync(candidate)) ?? null;
    };
    while (pending.length) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const dependency = resolveModule(file, match[1]!);
        if (dependency && !visited.has(dependency)) pending.push(dependency);
      }
    }
    const relative = [...visited].map((file) => file.slice(workspace.length + 1));
    expect(relative.some((file) => file.startsWith("src/adapters/jonsbo-n6/"))).toBe(false);
    expect(readFileSync(resolve(workspace, "src/adapters/runtime-composition.ts"), "utf8")).not.toMatch(/runtime-registration|legacy-runtime-bootstrap/);
    expect(readFileSync(entry, "utf8")).not.toMatch(/src\/adapters\/jonsbo-n6/);
  });
});

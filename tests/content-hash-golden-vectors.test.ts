import { describe, expect, it } from "vitest";
import { validateAdapterSnapshot } from "../src/adapters/contracts";
import { governedUnitRule } from "../src/contracts/registries";
import { validateLegacyFactSnapshot } from "../src/facts/contracts";
import goldenFixture from "./fixtures/baseline/u0-content-hash-golden-vectors.json";
import {
  HASH_SPEC,
  HASH_CANONICALIZATION_POLICIES,
  HASH_DOMAIN_REGISTRY,
  canonicalize,
  createContentAddressedRef,
  hashContent,
  legacySha256Hex,
  sha256Hex,
  validateArtifactPayload,
  verifyContentAddressedRef,
  type ContentAddressedRef,
  type HashDomainContract,
} from "../src/hash";
import * as browserHash from "../src/hash/browser";
import * as nodeHash from "../src/hash/node";
import { validateUserObservationSnapshot } from "../src/observations/contracts";
import { validateRequirementSpec } from "../src/requirements/contracts";
import { validateSimulationModelArtifact } from "../src/simulation/contracts";
import { validateBuildConfigV3 } from "../src/topology/contracts";

/**
 * This suite imports only the Web Crypto based public implementation. It is the
 * same suite/browser-compatible entry point intended for a browser Vitest lane.
 */
describe("hash-spec-v1 golden vectors", () => {
  it("pins the frozen JCS plus Build Sim domain-prefix contract", () => {
    expect(HASH_SPEC).toEqual({
      version: "hash-spec-v1",
      algorithm: "sha256",
      canonicalization: "rfc8785-jcs-with-buildsim-domain-prefix",
      unicode: "utf8-nfc",
      numberPolicy: "finite-json-number",
      excludes: ["the-hash-field-itself"],
    });
    expect(Object.isFrozen(HASH_CANONICALIZATION_POLICIES)).toBe(true);
    expect(Object.isFrozen(HASH_CANONICALIZATION_POLICIES["config-v3-v1"].setPaths)).toBe(true);
    expect(Object.isFrozen(HASH_DOMAIN_REGISTRY)).toBe(true);
    expect(Object.isFrozen(HASH_DOMAIN_REGISTRY["build-config@3.0.0"])).toBe(true);
    expect(HASH_DOMAIN_REGISTRY["spatial-topology@1.0.0"]).toEqual({
      domain: "spatial-topology",
      schemaVersion: "1.0.0",
      canonicalizationPolicyId: "canonical-json-v1",
    });
    expect(browserHash.hashContent).toBe(nodeHash.hashContent);
    expect(HASH_DOMAIN_REGISTRY["fact-snapshot@1.0.0"].canonicalizationPolicyId).toBe("fact-snapshot-v1");
    expect(HASH_DOMAIN_REGISTRY["user-observation-snapshot@1.0.0"].canonicalizationPolicyId).toBe("observation-snapshot-v1");
    expect(HASH_DOMAIN_REGISTRY["adapter-snapshot@1.0.0"].canonicalizationPolicyId).toBe("adapter-snapshot-v1");
    expect(HASH_DOMAIN_REGISTRY["simulation-model@1.0.0"].canonicalizationPolicyId).toBe("simulation-model-v1");
    expect(HASH_DOMAIN_REGISTRY["artifact@1.0.0"].canonicalizationPolicyId).toBe("artifact-payload-v1");
    expect(HASH_CANONICALIZATION_POLICIES["fact-snapshot-v1"]).toEqual({
      setPaths: ["/facts", "/conflictSets", "/facts/*/evidenceRefs"],
      excludedPaths: ["/factSnapshotHash"],
    });
    expect(HASH_CANONICALIZATION_POLICIES["observation-snapshot-v1"]).toEqual({
      setPaths: ["/observations", "/observations/*/attachmentRefs"],
      excludedPaths: ["/userObservationSnapshotHash"],
    });
    expect(HASH_CANONICALIZATION_POLICIES["adapter-snapshot-content-v1"]).toEqual({
      setPaths: ["/adapters", "/adapters/*/componentKindIds", "/adapters/*/emittedFacetIds"],
      excludedPaths: ["/contentHash"],
    });
  });

  it("exposes the same Web Crypto SHA-256 primitive in Node and browser entry points", async () => {
    await expect(sha256Hex("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(browserHash.sha256Hex).toBe(nodeHash.sha256Hex);
  });

  it("keeps the pre-U0 V2 hash behind an explicit compatibility adapter", async () => {
    const legacyValue = { b: 2, omitted: undefined, a: 1 };
    await expect(legacySha256Hex(legacyValue)).resolves.toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    await expect(hashContent({ a: 1, b: 2 }, { domain: "engine", schemaVersion: "1.0.0" }))
      .resolves.not.toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  });

  it("normalizes Unicode to UTF-8 NFC and orders normalized keys", async () => {
    const decomposed = { z: 1, label: "Cafe\u0301" };
    const composed = { label: "Café", z: 1 };
    expect(canonicalize(decomposed)).toBe('{"label":"Café","z":1}');
    await expect(hashContent(decomposed, { domain: "golden-text", schemaVersion: "1.0.0" }))
      .resolves.toBe("9b1616e6d469d63e827215dc39142e0027d2f9ae87405e94eadfaf9fa2a62293");
    await expect(hashContent(composed, { domain: "golden-text", schemaVersion: "1.0.0" }))
      .resolves.toBe("9b1616e6d469d63e827215dc39142e0027d2f9ae87405e94eadfaf9fa2a62293");
    expect(canonicalize({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
    expect(() => canonicalize({ "e\u0301": 1, é: 2 })).toThrow(/collide after NFC/);
    expect(canonicalize({ emoji: "😀" })).toBe('{"emoji":"😀"}');
    expect(() => canonicalize({ value: "\ud800" })).toThrow(/Unicode scalar values/);
    expect(() => canonicalize({ "\udc00": 1 })).toThrow(/Unicode scalar values/);
  });

  it("uses finite ECMAScript JSON numbers and rejects non-finite values", async () => {
    const value = { threshold: 1e21, small: 1e-7, minusZero: -0, decimal: 333333333.33333329 };
    expect(canonicalize(value)).toBe('{"decimal":333333333.3333333,"minusZero":0,"small":1e-7,"threshold":1e+21}');
    await expect(hashContent(value, { domain: "golden-number", schemaVersion: "1.0.0" }))
      .resolves.toBe("a9910b6fe387aad2f033f4f78eeac03fa7d121d1049e40d52dff02235dab8505");
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/finite JSON number/);
    expect(() => canonicalize({ value: Number.POSITIVE_INFINITY })).toThrow(/finite JSON number/);
    const sparse = new Array(2) as unknown[];
    sparse[1] = "present";
    expect(() => canonicalize(sparse)).toThrow(/arrays must be dense/);
    const namedArray = ["present"] as string[] & { label?: string };
    namedArray.label = "not-json";
    expect(() => canonicalize(namedArray)).toThrow(/no named properties/);
    expect(() => canonicalize({ [Symbol("hidden")]: true })).toThrow(/symbol keys/);
  });

  it("sorts only explicitly declared set paths", async () => {
    const policy = HASH_CANONICALIZATION_POLICIES["golden-id-set-v1"];
    expect(canonicalize({ ids: ["z", "a", "é"] }, policy)).toBe('{"ids":["a","z","é"]}');
    expect(canonicalize({ ids: ["z", "a"] })).toBe('{"ids":["z","a"]}');
    await expect(hashContent({ ids: ["é", "z", "a"] }, { domain: "golden-set", schemaVersion: "1.0.0", canonicalizationPolicyId: "golden-id-set-v1" }))
      .resolves.toBe("a2178ef40b6ddfd50367746d7f1438bf014e0aef3b8135325f834d89d94f90f6");
    expect(() => canonicalize({ ids: ["a", "a"] }, policy)).toThrow(/Duplicate member/);
  });

  it("normalizes units only through an explicit governed path rule", async () => {
    const policy = { unitRules: [governedUnitRule("/clearance", "mm")] };
    const centimetres = { clearance: { value: 1.5, unitId: "cm" } };
    const millimetres = { clearance: { value: 15, unitId: "mm" } };
    expect(canonicalize(centimetres, policy)).toBe('{"clearance":{"unitId":"mm","value":15}}');
    await expect(hashContent(centimetres, { domain: "golden-unit", schemaVersion: "1.0.0", canonicalizationPolicyId: "golden-clearance-mm-v1" }))
      .resolves.toBe("f9cbacd86ba380a8525f5382a4ef4f8e15f8d18f21b3776f5f234c50163fddf4");
    await expect(hashContent(centimetres, { domain: "golden-unit", schemaVersion: "1.0.0" }))
      .resolves.toBe(await hashContent(millimetres, { domain: "golden-unit", schemaVersion: "1.0.0" }));
  });

  it("excludes only declared self-hash fields and separates domain/schema preimages", async () => {
    const policy = { excludedPaths: ["/contentHash"] } as const;
    const value = { name: "artifact", contentHash: "stale" };
    await expect(hashContent(value, { domain: "golden-self", schemaVersion: "1.0.0", canonicalizationPolicyId: "content-hash-self-v1" }))
      .resolves.toBe("ba59b7115d8579572a852e8ce62d192f029d5584b58fc0604416c7feca2d8d04");
    await expect(hashContent({ ...value, contentHash: "changed" }, { domain: "golden-self", schemaVersion: "1.0.0" }))
      .resolves.toBe(await hashContent(value, { domain: "golden-self", schemaVersion: "1.0.0" }));
    await expect(hashContent(value, { domain: "other-domain", schemaVersion: "1.0.0" }))
      .resolves.not.toBe(await hashContent(value, { domain: "golden-self", schemaVersion: "1.0.0" }));
    await expect(hashContent(value, { domain: "golden-self", schemaVersion: "2.0.0" }))
      .resolves.not.toBe(await hashContent(value, { domain: "golden-self", schemaVersion: "1.0.0" }));
    expect(canonicalize(value, policy)).toBe('{"name":"artifact"}');
  });

  it("validates and pins representative config/requirement/fact/observation/adapter/model/artifact hashes", async () => {
    expect(goldenFixture.schemaVersion).toBe("u0-content-hash-golden-v1");
    expect(goldenFixture.vectors.map(({ id }) => id)).toEqual([
      "config", "requirement", "fact", "observation", "adapter", "model", "artifact",
    ]);
    for (const vector of goldenFixture.vectors) {
      expect(vector.contract.schemaVersion, `${vector.id} domain/object schema alignment`)
        .toBe((vector.value as Record<string, unknown>).schemaVersion);
    }
    const vectors = Object.fromEntries(goldenFixture.vectors.map((vector) => [vector.id, vector])) as Record<string, (typeof goldenFixture.vectors)[number]>;
    expect(validateBuildConfigV3(vectors.config?.value), "config contract").toEqual([]);
    expect(validateRequirementSpec(vectors.requirement?.value), "requirement contract").toEqual([]);
    // This frozen U0 vector intentionally preserves the v1 FactSnapshot bytes;
    // current production snapshots use v2 and are covered by their own corpus.
    expect(validateLegacyFactSnapshot(vectors.fact?.value), "legacy fact snapshot contract").toEqual([]);
    expect(validateUserObservationSnapshot(vectors.observation?.value), "user observation snapshot contract").toEqual([]);
    expect(validateAdapterSnapshot(vectors.adapter?.value), "adapter snapshot contract").toEqual([]);
    expect(validateSimulationModelArtifact(vectors.model?.value), "simulation model artifact contract").toEqual([]);
    expect(validateArtifactPayload(vectors.artifact?.value), "artifact payload contract").toEqual([]);

    for (const vector of goldenFixture.vectors) {
      const contract = vector.contract as HashDomainContract;
      await expect(nodeHash.hashContent(vector.value, contract), `Node ${vector.id}`).resolves.toBe(vector.expectedSha256);
      await expect(browserHash.hashContent(vector.value, contract), `browser entry ${vector.id}`).resolves.toBe(vector.expectedSha256);
    }
    for (const id of ["fact", "observation", "adapter", "model", "artifact"]) {
      const vector = vectors[id]!;
      expect((vector.value as Record<string, unknown>).contentHash, `${id} self hash`).toBe(vector.expectedSha256);
      await expect(hashContent(
        { ...vector.value, contentHash: "f".repeat(64) },
        vector.contract as HashDomainContract,
      ), `${id} excludes its self hash`).resolves.toBe(vector.expectedSha256);
    }
    const adapterVector = vectors.adapter!;
    const reorderedAdapter = structuredClone(adapterVector.value) as typeof adapterVector.value & {
      adapters: Array<{ componentKindIds: string[]; emittedFacetIds: string[] }>;
    };
    reorderedAdapter.adapters[0]!.componentKindIds.reverse();
    reorderedAdapter.adapters[0]!.emittedFacetIds.reverse();
    await expect(hashContent(reorderedAdapter, adapterVector.contract as HashDomainContract), "adapter manifest ID collections are sets")
      .resolves.toBe(adapterVector.expectedSha256);
  });

  it("keeps adapter, model and generic artifact validators strict and total", () => {
    const adapter = goldenFixture.vectors.find(({ id }) => id === "adapter")!.value;
    const model = goldenFixture.vectors.find(({ id }) => id === "model")!.value;
    const artifact = goldenFixture.vectors.find(({ id }) => id === "artifact")!.value;
    expect(validateAdapterSnapshot({ ...adapter, adapters: [] }))
      .toContain("adapter snapshot requires at least one registered manifest");
    expect(validateAdapterSnapshot({ ...adapter, adapters: [{ adapterId: "adapter.unregistered" }] }))
      .toContain("adapter snapshot adapters.0: hardware adapter manifest adapterId is not registered");
    expect(validateSimulationModelArtifact({ ...model, runtimeFunction: "hidden" }))
      .toContain("simulation model artifact contains unknown fields");
    expect(validateSimulationModelArtifact({ ...model, coefficients: { unstable: Number.NaN } }))
      .toContain("simulation model artifact coefficients invalid");
    expect(validateArtifactPayload({ ...artifact, payload: { executable: undefined } }))
      .toContain("artifact payload must contain plain finite JSON data");
    const cyclicPayload: Record<string, unknown> = {};
    cyclicPayload.self = cyclicPayload;
    expect(() => validateArtifactPayload({ ...artifact, payload: cyclicPayload })).not.toThrow();
    expect(validateArtifactPayload({ ...artifact, payload: cyclicPayload }))
      .toContain("artifact payload must contain plain finite JSON data");
    expect(() => validateSimulationModelArtifact(null)).not.toThrow();
    expect(() => validateAdapterSnapshot(null)).not.toThrow();
    expect(() => validateArtifactPayload(null)).not.toThrow();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => validateSimulationModelArtifact(revoked.proxy)).not.toThrow();
    expect(() => validateAdapterSnapshot(revoked.proxy)).not.toThrow();
    expect(() => validateArtifactPayload(revoked.proxy)).not.toThrow();
  });

  it("creates and verifies immutable content-addressed references", async () => {
    const value = { artifact: "engine", version: 1 };
    const ref = await createContentAddressedRef(value, { domain: "engine", schemaVersion: "1.0.0" });
    expect(ref).toMatchObject({ hashSpecVersion: "hash-spec-v1", algorithm: "sha256", ref: `sha256:${ref.contentHash}`, domain: "engine", schemaVersion: "1.0.0", canonicalizationPolicyId: "canonical-json-v1" });
    expect(Object.isFrozen(ref)).toBe(true);
    await expect(verifyContentAddressedRef(value, ref)).resolves.toBe(true);
    await expect(verifyContentAddressedRef({ ...value, version: 2 }, ref)).resolves.toBe(false);
  });

  it("rejects caller-supplied, unknown, mismatched, and tampered policies", async () => {
    await expect(hashContent(
      { value: 1 },
      { domain: "engine", schemaVersion: "1.0.0", policy: { excludedPaths: ["/value"] } } as unknown as HashDomainContract,
    )).rejects.toThrow(/policies must come from the frozen registry/);
    await expect(hashContent(
      { value: 1 },
      { domain: "not-registered", schemaVersion: "1.0.0" },
    )).rejects.toThrow(/Unknown hash domain\/schema registration/);
    await expect(hashContent(
      { ids: ["a", "b"] },
      { domain: "golden-set", schemaVersion: "1.0.0", canonicalizationPolicyId: "canonical-json-v1" },
    )).rejects.toThrow(/is not registered/);

    const configVector = goldenFixture.vectors.find(({ id }) => id === "config")!;
    const ref = await createContentAddressedRef(configVector.value, configVector.contract as HashDomainContract);
    await expect(verifyContentAddressedRef(configVector.value, {
      ...ref,
      canonicalizationPolicyId: "canonical-json-v1",
    } as ContentAddressedRef)).resolves.toBe(false);
    await expect(verifyContentAddressedRef(configVector.value, {
      ...ref,
      canonicalizationPolicyId: "missing-policy-v9",
    } as unknown as ContentAddressedRef)).resolves.toBe(false);
  });
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceClaimRepository } from "../src/evidence/claim-repository";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { FactRepository } from "../src/facts/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import {
  migrateFactsV1,
  planFactsV1Migration,
  rollbackFactsV1,
} from "../scripts/migrations/migrate-facts-v1.mjs";
import { scanOfficialFacts } from "../scripts/facts/scan-official.mjs";

const roots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `build-sim-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U3 governed fact migration", () => {
  it("keeps dry-run strictly read-only and classifies every legacy attr without copying raw values", async () => {
    const runtimeRoot = path.join(await temporaryRoot("fact-migration-plan"), "runtime-does-not-exist");
    const result = await migrateFactsV1({ dryRun: true, runtimeRoot });
    expect(result).toMatchObject({ status: "planned", plan: { schemaVersion: "catalog-facts-v1-plan" } });
    await expect(stat(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.plan.formal).toEqual(expect.arrayContaining([
      expect.objectContaining({ skuId: "case.jonsbo-n6", fieldId: "physical.width", page: 2 }),
      expect.objectContaining({ skuId: "board.asus-w680m-ace-se", fieldId: "motherboard.memory_slot_count", page: 8 }),
    ]));
    expect(result.plan.legacyUnverified).toEqual(expect.arrayContaining([
      expect.objectContaining({ skuId: "board.asus-w680m-ace-se", attrName: "chipset", classification: "legacy_unverified" }),
      expect.objectContaining({ attrName: "planningEfficiency", classification: "planning_or_inferred" }),
    ]));
    expect(JSON.stringify(result.plan.legacyUnverified)).not.toContain("No Cybenetics");
    expect(result.plan.legacyUnverified.every((entry: Record<string, unknown>) => "valueHash" in entry && !("value" in entry))).toBe(true);
  });

  it("imports the real N6/ASUS bytes, bounded claims and matching facts into one active generation", async () => {
    const runtimeRoot = await temporaryRoot("fact-migration-apply");
    const now = () => "2026-08-28T12:00:00.000Z";
    const plan = await planFactsV1Migration();
    const applied = await migrateFactsV1({ dryRun: false, expectedSourceHash: plan.sourceHash, runtimeRoot, now });
    expect(applied.manifest).toMatchObject({ status: "applied", sourceHash: plan.sourceHash });
    expect(applied.manifest.claims).toHaveLength(plan.formal.length);
    expect(applied.manifest.facts).toHaveLength(plan.formal.length);

    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
    const evidence = new FileEvidenceRepository({ coordinator, now });
    const claims = new EvidenceClaimRepository({ coordinator, evidence });
    const facts = new FactRepository({ coordinator, evidenceClaims: claims });
    const [storedClaims, storedFacts, scan] = await Promise.all([
      claims.listClaims(), facts.listCurrentFacts(), scanOfficialFacts({ runtimeRoot, coordinator }),
    ]);
    expect(storedClaims).toHaveLength(plan.formal.length);
    expect(storedFacts).toHaveLength(plan.formal.length);
    expect(scan).toEqual({ schemaVersion: "official-fact-scan-v1", status: "pass", errors: [] });
    expect(storedClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: expect.objectContaining({ skuId: "case.jonsbo-n6" }),
        fieldId: "physical.width",
        source: expect.objectContaining({
          documentSha256: "15f026946a18b5e4fc0ebf585f8b60ed8e3044f41efe699326adfa0ee3d480cd",
          locator: expect.objectContaining({ page: 2, field: "n6.case.externalEnvelope" }),
        }),
      }),
      expect.objectContaining({
        subject: expect.objectContaining({ skuId: "board.asus-w680m-ace-se" }),
        fieldId: "motherboard.form_factor",
        source: expect.objectContaining({
          documentSha256: "dbb482ef25ababeae9d4d1063e176a78c0544f18dacffd16dc830a1a2f203d2e",
          locator: expect.objectContaining({ page: 11, field: "w680m.board.formFactor" }),
        }),
      }),
    ]));
    expect(storedFacts.every((fact: { authority: string; evidenceRefs: string[] }) => fact.authority === "official" && fact.evidenceRefs.length === 1)).toBe(true);

    const replay = await migrateFactsV1({ dryRun: false, expectedSourceHash: plan.sourceHash, runtimeRoot, now });
    expect(replay.manifest).toEqual(applied.manifest);
  });

  it("requires the exact dry-run source and fails the scanner for a checksum-valid claim with no locator", async () => {
    const runtimeRoot = await temporaryRoot("fact-migration-tamper");
    const plan = await planFactsV1Migration();
    await expect(migrateFactsV1({ dryRun: false, expectedSourceHash: "0".repeat(64), runtimeRoot })).rejects.toThrow(/exact dry-run source hash/);
    await migrateFactsV1({ dryRun: false, expectedSourceHash: plan.sourceHash, runtimeRoot, now: () => "2026-08-28T12:00:00.000Z" });

    const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
    const state = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(state);
    const migration = JSON.parse(await readFile(path.join(activeRoot, "migrations", "catalog-facts-v1", "manifest.json"), "utf8"));
    const claimId = migration.claims[0].claimId as string;
    const hash = claimId.slice("claim-sha256-".length);
    const claimFile = path.join(activeRoot, "evidence", "claims", hash.slice(0, 2), `${claimId}.json`);
    const envelope = JSON.parse(await readFile(claimFile, "utf8"));
    envelope.payload.source.locator = {};
    const { sha256Json } = await import("../src/runtime/fs.mjs");
    envelope.checksum = sha256Json(envelope.payload);
    await writeFile(claimFile, JSON.stringify(envelope));
    await expect(scanOfficialFacts({ runtimeRoot, coordinator })).resolves.toMatchObject({
      status: "fail",
      errors: [expect.objectContaining({ code: "official_claim_or_locator_invalid" })],
    });
  });

  it("keeps immutable facts on rollback and requires the fact graph to be disabled", async () => {
    const runtimeRoot = await temporaryRoot("fact-migration-rollback");
    const plan = await planFactsV1Migration();
    await migrateFactsV1({ dryRun: false, expectedSourceHash: plan.sourceHash, runtimeRoot, now: () => "2026-08-28T12:00:00.000Z" });
    await expect(rollbackFactsV1({ runtimeRoot, factGraphEnabled: true })).rejects.toThrow(/disable the fact graph/);
    const rolledBack = await rollbackFactsV1({ runtimeRoot, factGraphEnabled: false, now: () => "2026-08-28T13:00:00.000Z" });
    expect(rolledBack).toMatchObject({ status: "rolled_back", previousManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
    const claims = new EvidenceClaimRepository({ coordinator, evidence: new FileEvidenceRepository({ coordinator }) });
    await expect(new FactRepository({ coordinator, evidenceClaims: claims }).listCurrentFacts()).resolves.toHaveLength(plan.formal.length);
  });
});

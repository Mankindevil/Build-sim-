import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup } from "../src/backup/runtime.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import {
  EvidenceClaimRepository,
  LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
} from "../src/evidence/claim-repository";
import { createEvidenceClaim } from "../src/evidence/claims";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-evidence-claims-"));
  roots.push(root);
  return root;
}

function metadata(basis = "official-document-explicit") {
  return {
    mediaType: "application/pdf", kind: "manufacturer-manual", title: "Example PSU Manual",
    productIdentities: [{
      brand: "Example", model: "PSU X", category: "psu", skuId: "psu.example", basis,
      familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN",
    }],
    capture: {
      acquisitionMethod: "official-fetch", requestedUrl: "https://example.com/psu", finalUrl: "https://example.com/psu.pdf",
      canonicalUrl: "https://example.com/psu.pdf", retrievedAt: "2026-08-28T00:00:00.000Z", status: 200, redirects: [], officialBrand: "Example",
    },
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("U3 EvidenceClaimRepository", () => {
  it("pins claims to verified immutable documents, captures, exact SKU identity, and locators", async () => {
    const root = await temporaryRoot();
    const coordinator = new RuntimeCoordinator({ root });
    const evidence = new FileEvidenceRepository({ coordinator });
    const imported = await evidence.importBuffer(Buffer.from("official pinout manual"), metadata());
    const claim = await createEvidenceClaim({
      schemaVersion: "evidence-claim-v1", subject: { skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "CN" },
      scope: "revision", fieldId: "psu.pinout", value: { connector: "vendor-12-pin", pins: 12 }, authority: "official",
      source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 12, section: "Pinout" } },
      retrievedAt: "2026-08-28T00:01:00.000Z", status: "active",
    });
    const claims = new EvidenceClaimRepository({ coordinator, evidence });
    await expect(claims.putClaim(claim)).rejects.toMatchObject({ code: "invalid_input" });
    const lease = await coordinator.acquireMaintenanceLease("legacy-official-claim-fixture");
    await expect(claims.putLegacyOfficialClaim({
      claim,
      legacyImportCapability: LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
      maintenanceLeaseToken: lease.token,
    })).resolves.toEqual(claim);
    await expect(new EvidenceClaimRepository({ coordinator, evidence }).getClaim(claim.claimId)).resolves.toEqual(claim);
    const refs = (await coordinator.withConsistentSnapshot(
      ({ activeRoot }: { activeRoot: string }) => claims.snapshotReferences(activeRoot),
    )).result;
    expect(refs.nodes).toEqual([`evidence-claim:${claim.claimId}`]);
    expect(refs.edges).toEqual(expect.arrayContaining([
      { fromRef: `evidence-claim:${claim.claimId}`, toRef: `evidence-document:${imported.document.id}`, necessity: "required_for_replay" },
      { fromRef: `evidence-claim:${claim.claimId}`, toRef: `evidence-capture:${imported.capture.id}`, necessity: "required_for_replay" },
    ]));
    await expect(createProductionReferenceGraph({ coordinator, now: () => "2026-08-28T00:02:00.000Z" })).rejects.toThrow(
      /official evidence claim lacks reviewed candidate promotion or governed migration authority/,
    );
    await expect(createBackup({
      coordinator,
      outputFile: path.join(root, "legacy-official.backup"),
      password: "a sufficiently long backup password",
    })).rejects.toThrow(/official evidence claim lacks reviewed candidate promotion or governed migration authority/);
    await expect(runDoctor({ coordinator })).resolves.toEqual(expect.objectContaining({
      report: expect.objectContaining({
        checks: expect.arrayContaining([
          expect.objectContaining({ checkId: "integrity.reference_closure", status: "fail" }),
        ]),
      }),
    }));
  });

  it("rejects claims whose source bytes/capture or official identity is not authoritative", async () => {
    const root = await temporaryRoot();
    const coordinator = new RuntimeCoordinator({ root });
    const evidence = new FileEvidenceRepository({ coordinator });
    const imported = await evidence.importBuffer(Buffer.from("user labelled bytes"), metadata("governed-sku-user-asserted"));
    const claim = await createEvidenceClaim({
      schemaVersion: "evidence-claim-v1", subject: { skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A" }, scope: "revision",
      fieldId: "psu.pinout", value: { connector: "unknown" }, authority: "official",
      source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { section: "Pinout" } },
      retrievedAt: "2026-08-28T00:01:00.000Z", status: "active",
    });
    const lease = await coordinator.acquireMaintenanceLease("legacy-official-claim-fixture");
    await expect(new EvidenceClaimRepository({ coordinator, evidence }).putLegacyOfficialClaim({
      claim,
      legacyImportCapability: LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
      maintenanceLeaseToken: lease.token,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects sibling revisions and regions that the capture never asserted", async () => {
    const root = await temporaryRoot();
    const coordinator = new RuntimeCoordinator({ root });
    const evidence = new FileEvidenceRepository({ coordinator });
    const imported = await evidence.importBuffer(Buffer.from("revision A CN manual"), metadata());
    const claims = new EvidenceClaimRepository({ coordinator, evidence });
    const lease = await coordinator.acquireMaintenanceLease("legacy-official-claim-fixture");
    for (const subject of [
      { skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "B", region: "CN" },
      { skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A", region: "US" },
    ]) {
      const claim = await createEvidenceClaim({
        schemaVersion: "evidence-claim-v1", subject, scope: "revision", fieldId: "psu.pinout", value: { connector: "unknown" }, authority: "official",
        source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 1 } },
        retrievedAt: "2026-08-28T00:01:00.000Z", status: "active",
      });
      await expect(claims.putLegacyOfficialClaim({
        claim,
        legacyImportCapability: LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
        maintenanceLeaseToken: lease.token,
      })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("uses the shared runtime generation and preserves claims across restart", async () => {
    const runtimeRoot = await temporaryRoot();
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot });
    const evidence = new FileEvidenceRepository({ coordinator });
    const imported = await evidence.importBuffer(Buffer.from("runtime manual"), metadata());
    const claim = await createEvidenceClaim({
      schemaVersion: "evidence-claim-v1", subject: { skuId: "psu.example", familyId: "psu-family", modelId: "psu-model", variantId: "psu-variant", revision: "A" }, scope: "revision",
      fieldId: "psu.pinout", value: { connector: "runtime" }, authority: "official",
      source: { documentId: imported.document.id, documentSha256: imported.document.sha256, captureId: imported.capture.id, locator: { page: 1 } },
      retrievedAt: "2026-08-28T00:01:00.000Z", status: "active",
    });
    const repository = new EvidenceClaimRepository({ coordinator, evidence });
    await expect(repository.putLegacyOfficialClaim({
      claim,
      legacyImportCapability: LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
      maintenanceLeaseToken: "caller-forged-token",
    })).rejects.toMatchObject({ code: "invalid_input" });
    const lease = await coordinator.acquireMaintenanceLease("legacy-official-claim-fixture");
    await repository.putLegacyOfficialClaim({
      claim,
      legacyImportCapability: LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
      maintenanceLeaseToken: lease.token,
    });
    const file = path.join(runtimeRoot, "generations", "1", "evidence", "claims", claim.contentHash.slice(0, 2), `${claim.claimId}.json`);
    await expect(readFile(file, "utf8")).resolves.toContain(claim.claimId);
    await expect(new EvidenceClaimRepository({ coordinator, evidence }).getClaim(claim.claimId)).resolves.toEqual(claim);
  });
});

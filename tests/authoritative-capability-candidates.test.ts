import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import {
  EvidenceClaimRepository,
  LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
} from "../src/evidence/claim-repository";
import { FactRepository } from "../src/facts/repository";
import { factFieldPolicy } from "../src/facts/field-registry";
import { createFactSnapshot } from "../src/facts/snapshots";
import { createFactRecord } from "../src/facts/hash";
import { createEvidenceClaim } from "../src/evidence/claims";
import { createCapabilityRecord, capabilityFactSnapshotRef } from "../src/capabilities/facets";
import {
  AuthoritativeCapabilityCandidateService,
  assertCapabilityCandidatesMatchEvaluationLock,
  verifyAuthoritativeCapabilityCandidateResult,
  type RootBoundCapabilityIndexAuthority,
} from "../src/solver/capability-candidates";
import { createProductionCapabilityCandidateService } from "../src/server/solver-production";
import type { SnapshotHashes } from "../src/hash";

const roots: string[] = [];
const digest = (character: string): string => character.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-capability-candidates-"));
  roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => "2026-08-28T00:00:00.000Z" });
  await coordinator.initialize();
  const candidates = [
    { skuId: "board.alpha", socket: "lga1700", factId: "fact-board-alpha-socket", token: "a" },
    { skuId: "board.beta", socket: "am5", factId: "fact-board-beta-socket", token: "b" },
  ];
  const claims = await Promise.all(candidates.map((item) => createEvidenceClaim({
    schemaVersion: "evidence-claim-v1",
    subject: { skuId: item.skuId, familyId: "board-family", modelId: "board-model", variantId: item.skuId },
    scope: "variant", fieldId: "motherboard.cpu_socket", value: item.socket, authority: "official",
    source: {
      documentId: `doc-sha256-${digest(item.token)}`, documentSha256: digest(item.token),
      captureId: `capture-sha256-${digest(item.token === "a" ? "c" : "d")}`, locator: { field: "motherboard.cpu_socket" },
    },
    retrievedAt: "2026-08-28T00:00:00.000Z", status: "active",
  })));
  const facts = await Promise.all(candidates.map((item, index) => createFactRecord({
    schemaVersion: "fact-record-v1", factId: item.factId,
    subject: { kind: "product", skuId: item.skuId, familyId: "board-family", modelId: "board-model", variantId: item.skuId },
    field: "motherboard.cpu_socket", value: item.socket, scope: "variant", authority: "official",
    safetyClass: "compatibility_critical", status: "active", evidenceRefs: [claims[index]!.claimId],
    derivedFromFactIds: [], confidence: 1, retrievedAt: "2026-08-28T00:00:00.000Z",
  })));
  const factSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash })),
    conflictRefs: [],
    createdAt: "2026-08-28T00:00:00.000Z",
  });
  const ref = capabilityFactSnapshotRef(factSnapshot);
  const records = await Promise.all([
    createCapabilityRecord({
      schemaVersion: "capability-record-v1", subjectSkuId: "board.alpha", componentKindId: "motherboard", factSnapshotRef: ref,
      facets: [{ facetId: "motherboard.cpu_socket", value: "lga1700", sourceFactIds: ["fact-board-alpha-socket"], safetyClass: "boot" }],
      providerRefs: ["provider.fixture@1.0.0"],
    }),
    createCapabilityRecord({
      schemaVersion: "capability-record-v1", subjectSkuId: "board.beta", componentKindId: "motherboard", factSnapshotRef: ref,
      facets: [{ facetId: "motherboard.cpu_socket", value: "am5", sourceFactIds: ["fact-board-beta-socket"], safetyClass: "boot" }],
      providerRefs: ["provider.fixture@1.0.0"],
    }),
  ]);
  const authority: RootBoundCapabilityIndexAuthority = {
    authorityKind: "root-bound-capability-index-authority-v1",
    async resolveAtRoot(activeRoot, planId) {
      expect(activeRoot).toContain("generations/1");
      return { planId, factSnapshot, capabilityRecords: records };
    },
    async getFactAtRoot(_activeRoot, factId) { return structuredClone(facts.find((fact) => fact.factId === factId) ?? null); },
    async getEvidenceClaimAtRoot(_activeRoot, claimId) { return structuredClone(claims.find((claim) => claim.claimId === claimId) ?? null); },
  };
  return { coordinator, factSnapshot, service: new AuthoritativeCapabilityCandidateService({ coordinator, authority }) };
}

function hashes(factSnapshotHash: string): SnapshotHashes {
  return {
    configHash: digest("1"), requirementSpecHash: digest("2"), factSnapshotHash,
    userObservationSnapshotHash: digest("3"), priceSnapshotHash: digest("4"), ruleSetHash: digest("5"),
    systemProfileHash: digest("6"), adapterSnapshotHash: digest("7"), engineHash: digest("8"),
    simulationModelHash: digest("9"), simulationInputHash: digest("a"),
  };
}

describe("authoritative requirement capability candidates", () => {
  it("queries only server-resolved records from one fact snapshot and binds the evaluation lock", async () => {
    const { service, factSnapshot } = await fixture();
    const result = await service.query({
      planId: "plan-a", componentKindId: "motherboard",
      predicates: [{ facetId: "motherboard.cpu_socket", operator: "eq", value: "lga1700" }],
      expectedFactSnapshotHash: factSnapshot.contentHash,
    });
    expect(result).toMatchObject({
      schemaVersion: "authoritative-capability-candidates-v1", planId: "plan-a", runtimeGeneration: 1, runtimeRevision: 0,
      candidates: [{ subjectSkuId: "board.alpha" }],
    });
    await expect(verifyAuthoritativeCapabilityCandidateResult(result)).resolves.toBe(true);
    expect(() => assertCapabilityCandidatesMatchEvaluationLock(result, hashes(factSnapshot.contentHash))).not.toThrow();
    expect(() => assertCapabilityCandidatesMatchEvaluationLock(result, hashes(digest("f")))).toThrow(/fact snapshot/);
  });

  it("rejects caller search fields, stale snapshot guards, cross-plan closure, and self-hashed tampering", async () => {
    const { coordinator, service } = await fixture();
    await expect(service.query({
      planId: "plan-a", componentKindId: "motherboard", predicates: [], search: "Brand board.alpha",
    } as never)).rejects.toThrow(/unknown fields/);
    await expect(service.query({
      planId: "plan-a", componentKindId: "motherboard", predicates: [], expectedFactSnapshotHash: digest("f"),
    })).rejects.toThrow(/snapshot conflict/);

    const crossPlan = new AuthoritativeCapabilityCandidateService({
      coordinator,
      authority: {
        authorityKind: "root-bound-capability-index-authority-v1",
        async resolveAtRoot() {
          const factSnapshot = await createFactSnapshot({ schemaVersion: "fact-snapshot-v2", factRefs: [], conflictRefs: [], createdAt: "2026-08-28T00:00:00.000Z" });
          return { planId: "plan-b", factSnapshot, capabilityRecords: [] };
        },
        async getFactAtRoot() { return null; },
        async getEvidenceClaimAtRoot() { return null; },
      },
    });
    await expect(crossPlan.query({ planId: "plan-a", componentKindId: "motherboard", predicates: [] })).rejects.toThrow(/ownership/);

    const result = await service.query({ planId: "plan-a", componentKindId: "motherboard", predicates: [] });
    await expect(verifyAuthoritativeCapabilityCandidateResult({ ...result, candidates: [] })).resolves.toBe(false);
  });

  it("resolves a positive production candidate from persisted claim, fact, and snapshot authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-production-capability-candidates-"));
    roots.push(root);
    const now = () => "2026-08-28T00:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now });
    await coordinator.initialize();
    const evidence = new FileEvidenceRepository({ coordinator, now });
    const imported = await evidence.importBuffer(Buffer.from("board alpha exact revision capability sheet", "utf8"), {
      mediaType: "application/pdf",
      kind: "manufacturer-manual",
      title: "Board Alpha capability sheet",
      productIdentities: [{
        brand: "Example",
        model: "Board Alpha",
        category: "motherboard",
        skuId: "board.alpha.production",
        basis: "official-document-explicit",
        familyId: "board-alpha-family",
        modelId: "board-alpha-model",
        variantId: "board-alpha-variant",
        revision: "A",
        region: "CN",
      }],
      capture: {
        acquisitionMethod: "official-fetch",
        requestedUrl: "https://example.invalid/board-alpha",
        finalUrl: "https://example.invalid/board-alpha.pdf",
        canonicalUrl: "https://example.invalid/board-alpha.pdf",
        retrievedAt: now(),
        status: 200,
        redirects: [],
        officialBrand: "Example",
      },
    });
    const subject = {
      skuId: "board.alpha.production",
      familyId: "board-alpha-family",
      modelId: "board-alpha-model",
      variantId: "board-alpha-variant",
      revision: "A",
      region: "CN",
    } as const;
    const claims = await Promise.all([
      createEvidenceClaim({
        schemaVersion: "evidence-claim-v1",
        subject,
        scope: "revision",
        fieldId: "identity.category",
        value: "motherboard",
        authority: "official",
        source: {
          documentId: imported.document.id,
          documentSha256: imported.document.sha256,
          captureId: imported.capture.id,
          locator: { section: "Product identity" },
        },
        retrievedAt: now(),
        status: "active",
      }),
      createEvidenceClaim({
        schemaVersion: "evidence-claim-v1",
        subject,
        scope: "revision",
        fieldId: "motherboard.cpu_socket",
        value: "lga1700",
        authority: "official",
        source: {
          documentId: imported.document.id,
          documentSha256: imported.document.sha256,
          captureId: imported.capture.id,
          locator: { section: "CPU support" },
        },
        retrievedAt: now(),
        status: "active",
      }),
    ]);
    const claimRepository = new EvidenceClaimRepository({ coordinator, evidence });
    const lease = await coordinator.acquireMaintenanceLease("production-candidate-authority-fixture");
    try {
      for (const claim of claims) {
        await claimRepository.putLegacyOfficialClaim({
          claim,
          legacyImportCapability: LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY,
          maintenanceLeaseToken: lease.token,
        });
      }
    } finally {
      await coordinator.releaseMaintenanceLease(lease.token);
    }
    const facts = await Promise.all(claims.map((claim, index) => createFactRecord({
      schemaVersion: "fact-record-v1",
      factId: index === 0 ? "fact-board-alpha-production-category" : "fact-board-alpha-production-socket",
      subject: { kind: "product", ...subject },
      field: claim.fieldId,
      value: claim.value,
      scope: "revision",
      authority: "official",
      safetyClass: factFieldPolicy(claim.fieldId)!.safetyClass,
      status: "active",
      evidenceRefs: [claim.claimId],
      derivedFromFactIds: [],
      confidence: 1,
      retrievedAt: now(),
    })));
    const factRepository = new FactRepository({ coordinator, evidenceClaims: claimRepository, now });
    for (const fact of facts) await factRepository.putFact({ fact });
    const snapshot = await factRepository.createSnapshot({ factIds: facts.map(({ factId }) => factId) });
    const service = createProductionCapabilityCandidateService({
      coordinator,
      facts: factRepository,
      claims: claimRepository,
    });
    const result = await service.query({
      planId: "plan-production-candidate",
      componentKindId: "motherboard",
      predicates: [{ facetId: "motherboard.cpu_socket", operator: "eq", value: "lga1700" }],
      expectedFactSnapshotHash: snapshot.contentHash,
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({ subjectSkuId: "board.alpha.production" }),
    ]);
    expect(result.capabilityRecords).toHaveLength(1);
    expect(result.candidateAuthorities).toEqual([
      expect.objectContaining({
        subjectSkuId: "board.alpha.production",
        sourceFactRefs: facts.map(({ factId, contentHash }) => ({ factId, contentHash })),
      }),
    ]);
    await expect(verifyAuthoritativeCapabilityCandidateResult(result)).resolves.toBe(true);
  });
});

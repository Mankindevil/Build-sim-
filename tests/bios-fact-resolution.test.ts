import { describe, expect, it } from "vitest";
import { canFactAloneSupportSafetyPass, validateFactRecord } from "../src/facts/contracts";
import { createFactRecord } from "../src/facts/hash";
import { resolveClaimIdentity } from "../src/facts/identity";
import { createEvidenceClaim } from "../src/evidence/claims";

const digest = (value: string): string => value.repeat(64);

async function cpuSupportFact() {
  return createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: "fact-board-rev-a-cpu-support",
    subject: {
      kind: "product", skuId: "board.example-rev-a-cn", familyId: "board-family", modelId: "board-model",
      variantId: "board-variant", revision: "A", region: "CN",
    },
    field: "firmware.cpu_support",
    value: { cpuSkuId: "cpu.am5.example", boardRevision: "A", region: "CN", sinceVersion: "1807" },
    scope: "revision",
    authority: "official",
    safetyClass: "compatibility_critical",
    status: "active",
    evidenceRefs: [`claim-sha256-${digest("a")}`],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: "2026-08-28T01:00:00.000Z",
  });
}

describe("U3 BIOS fact resolution", () => {
  it("requires formal release support identity and exact board revision/region", async () => {
    const fact = await cpuSupportFact();
    expect(validateFactRecord(fact)).toEqual([]);
    expect(validateFactRecord({ ...fact, value: { cpuSkuId: "cpu.am5.example", boardRevision: "B", sinceVersion: "1807" } }))
      .toContain("firmware cpu support value invalid");

    const exactIdentity = {
      identityResolutionId: "identity-exact", subjectText: "Example board rev A CN", status: "resolved" as const,
      scope: "revision" as const, resolvedSkuId: "board.example-rev-a-cn", candidateSkuIds: ["board.example-rev-a-cn"],
      identityClaimIds: ["claim"], unresolvedFieldIds: [], evaluatedAt: "2026-08-28T01:00:00.000Z",
      resolvedSubject: {
        kind: "product" as const, skuId: "board.example-rev-a-cn", familyId: "board-family", modelId: "board-model",
        variantId: "board-variant", revision: "A", region: "CN",
      },
    };
    expect(canFactAloneSupportSafetyPass(fact, {
      identityResolution: exactIdentity, activeConflictFactIds: new Set(), contentHashVerified: true, evidenceClaimsVerified: true,
    })).toBe(true);
    expect(canFactAloneSupportSafetyPass(fact, {
      identityResolution: { ...exactIdentity, resolvedSkuId: "board.example-rev-b-cn" },
      activeConflictFactIds: new Set(), contentHashVerified: true, evidenceClaimsVerified: true,
    })).toBe(false);
    expect(canFactAloneSupportSafetyPass(fact, {
      identityResolution: { ...exactIdentity, resolvedSubject: { ...exactIdentity.resolvedSubject, revision: "B" } },
      activeConflictFactIds: new Set(), contentHashVerified: true, evidenceClaimsVerified: true,
    })).toBe(false);
  });

  it("does not inherit a CPU-support claim from a sibling revision or region", async () => {
    const claim = await createEvidenceClaim({
      schemaVersion: "evidence-claim-v1",
      subject: { skuId: "board.example-rev-b-us", familyId: "board-family", modelId: "board-model", variantId: "board-variant", revision: "B", region: "US" },
      scope: "revision",
      fieldId: "firmware.cpu_support",
      value: { cpuSkuId: "cpu.am5.example", boardRevision: "B", region: "US", sinceVersion: "2001" },
      authority: "official",
      source: { documentId: `doc-sha256-${digest("b")}`, documentSha256: digest("b"), captureId: `capture-sha256-${digest("c")}`, locator: { page: 4, section: "CPU support" } },
      retrievedAt: "2026-08-28T01:00:00.000Z",
      status: "active",
    });
    const resolution = await resolveClaimIdentity({
      subjectText: "Example board rev A CN", scope: "revision", claims: [claim], expectedSkuId: "board.example-rev-a-cn",
      expectedRevision: "A", expectedRegion: "CN", evaluatedAt: "2026-08-28T01:01:00.000Z",
    });
    expect(resolution).toMatchObject({ status: "unresolved", candidateSkuIds: [] });
    expect(resolution.unresolvedFieldIds).toEqual(expect.arrayContaining(["revision", "region"]));
  });

  it("uses strict schemas for firmware, storage and package facts", () => {
    const base = {
      schemaVersion: "fact-record-v1", factId: "fact-formal", subject: { kind: "product", skuId: "disk.example", variantId: "disk-variant" },
      scope: "variant", authority: "official", safetyClass: "compatibility_critical", status: "active",
      evidenceRefs: [`claim-sha256-${digest("d")}`], derivedFromFactIds: [], confidence: 1,
      retrievedAt: "2026-08-28T01:00:00.000Z", contentHash: digest("e"),
    } as const;
    expect(validateFactRecord({ ...base, field: "storage.recording_technology", value: "unknown" })).toContain("storage recording technology invalid");
    expect(validateFactRecord({ ...base, field: "storage.recording_technology", value: "cmr" })).toEqual([]);
    expect(validateFactRecord({ ...base, field: "storage.logical_sector_size", value: 4096, unit: "byte" })).toEqual([]);
    expect(validateFactRecord({ ...base, field: "storage.logical_sector_size", value: 1000, unit: "byte" })).toContain("storage sector size invalid");
    expect(validateFactRecord({ ...base, field: "hba.mode", value: "it" })).toEqual([]);
    expect(validateFactRecord({ ...base, field: "hba.mode", value: "maybe" })).toContain("hba mode invalid");
    expect(validateFactRecord({ ...base, field: "package.fastener_count", value: { fastenerId: "m3", quantity: 4 } })).toEqual([]);
    expect(validateFactRecord({ ...base, field: "package.fastener_count", value: { fastenerId: "m3", quantity: -1 } })).toContain("package fastener count invalid");
  });
});

import { describe, expect, it } from "vitest";
import { validateEvidenceClaim, type EvidenceClaim } from "../src/evidence/contracts";
import { createEvidenceClaim, evidenceClaimContentHash, verifyEvidenceClaim } from "../src/evidence/claims";

const digest = (character: string): string => character.repeat(64);

function claim(): EvidenceClaim {
  const contentHash = digest("a");
  const documentHash = digest("b");
  return {
    schemaVersion: "evidence-claim-v1",
    claimId: `claim-sha256-${contentHash}`,
    subject: {
      skuId: "motherboard.example-rev-1",
      familyId: "motherboard.example",
      modelId: "example-board",
      variantId: "example-board-cn",
      revision: "1.0",
      region: "CN",
    },
    scope: "revision",
    fieldId: "motherboard.cpu_support",
    value: { cpuId: "cpu.example", sinceVersion: "1402" },
    authority: "official",
    source: {
      documentId: `doc-sha256-${documentHash}`,
      documentSha256: documentHash,
      captureId: `capture-sha256-${digest("c")}`,
      locator: { page: 12, section: "CPU support", field: "BIOS", snippet: "Supported since 1402" },
    },
    retrievedAt: "2026-08-28T00:00:00.000Z",
    validFrom: "2026-08-01T00:00:00.000Z",
    status: "active",
    contentHash,
  };
}

describe("U3 evidence claim contract", () => {
  it("binds an official claim to exact identity, immutable bytes, capture, and locator", () => {
    expect(validateEvidenceClaim(claim())).toEqual([]);
  });

  it("rejects missing or forged official evidence closure", () => {
    const original = claim();
    const noLocator = { ...original, source: { ...original.source, locator: {} } };
    expect(validateEvidenceClaim(noLocator)).toContain("claim locator must identify evidence content");

    const wrongHash = { ...original, source: { ...original.source, documentSha256: digest("d") } };
    expect(validateEvidenceClaim(wrongHash)).toContain("evidence claim document hash mismatch");

    const missingCapture = structuredClone(claim()) as unknown as Record<string, unknown>;
    delete (missingCapture.source as Record<string, unknown>).captureId;
    expect(validateEvidenceClaim(missingCapture)).toContain("evidence claim source invalid");
  });

  it("does not let family/model claims masquerade as revision evidence", () => {
    const original = claim();
    const { revision: _revision, ...siblingSubject } = original.subject;
    const sibling = { ...original, subject: siblingSubject };
    expect(validateEvidenceClaim(sibling)).toContain("revision claim requires exact model, variant and revision identity");

    const { modelId: _modelId, ...modelSubject } = original.subject;
    const model = { ...original, scope: "model", subject: modelSubject };
    expect(validateEvidenceClaim(model)).toContain("model claim requires model identity");
  });

  it("rejects invalid time, supersession, unknown fields, and non-canonical Unicode", () => {
    expect(validateEvidenceClaim({ ...claim(), retrievedAt: "not-a-time" })).toContain("evidence claim retrievedAt invalid");
    expect(validateEvidenceClaim({ ...claim(), validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2026-08-01T00:00:00.000Z" }))
      .toContain("evidence claim validity interval invalid");
    expect(validateEvidenceClaim({ ...claim(), supersedesClaimId: `claim-sha256-${digest("d")}` }))
      .toContain("evidence claim supersession closure invalid");
    expect(validateEvidenceClaim({ ...claim(), leaked: true })).toContain("evidence claim fields invalid");
    expect(validateEvidenceClaim({ ...claim(), fieldId: "cafe\u0301" })).toContain("evidence claim fieldId invalid");
    expect(validateEvidenceClaim({ ...claim(), value: "\ud800" })).toContain("evidence claim value is not finite canonical JSON");
  });

  it("requires both the old claim ID and hash for an approved replacement", () => {
    const replacement = {
      ...claim(),
      supersedesClaimId: `claim-sha256-${digest("d")}`,
      supersededClaimHash: digest("d"),
    } as EvidenceClaim;
    expect(validateEvidenceClaim(replacement)).toEqual([]);
    expect(validateEvidenceClaim({ ...replacement, status: "superseded" })).toContain("only an active evidence claim may supersede another claim");
  });

  it("uses a registered domain hash and detects semantic tampering", async () => {
    const { claimId: _claimId, contentHash: _contentHash, ...input } = claim();
    const created = await createEvidenceClaim(input);
    expect(created.contentHash).toBe(await evidenceClaimContentHash(input));
    expect(await verifyEvidenceClaim(created)).toBe(true);
    expect(await verifyEvidenceClaim({ ...created, value: { cpuId: "cpu.other", sinceVersion: "1402" } })).toBe(false);
  });
});

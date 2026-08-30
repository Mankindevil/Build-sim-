import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOfficialEvidence } from "../src/evidence/acquire.mjs";
import { discoverOfficialDocumentLinks, EvidenceDiscoveryError } from "../src/evidence/discovery.mjs";
import { EvidenceExcerptError } from "../src/evidence/excerpts.mjs";
import {
  EVIDENCE_LADDER_LEVELS,
  assessThirdPartySourceIndependence,
  createOfficialDocumentIdentityConfirmation,
  createThirdPartyEvidenceSource,
  evaluateOfficialDocumentPromotion,
  resolveEvidenceLadder,
  validateOfficialDocumentIdentityConfirmation,
  validateThirdPartyEvidenceSource,
  validateThirdPartyIndependenceAssessment,
} from "../src/evidence/ladder.mjs";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import {
  EVIDENCE_SEARCH_REASONS,
  classifyEvidenceSearchReason,
  createEvidenceSearchAttempt,
  createEvidenceSearchOutcome,
  isEvidenceSearchReason,
  validateEvidenceSearchOutcome,
} from "../src/evidence/search-outcome.mjs";
import type { EvidenceSearchAttemptResult } from "../src/evidence/search-outcome.mjs";

const roots: string[] = [];
const at = "2026-08-28T00:00:00.000Z";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const product = {
  kind: "product",
  skuId: "motherboard.asus-pro-ws-x870e-sage-se",
  familyId: "motherboard.asus-pro-ws-x870e",
  modelId: "PRO WS X870E-SAGE SE",
  variantId: "PRO WS X870E-SAGE SE",
  revision: "1.1",
  region: "global",
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function searchAttempt(result: EvidenceSearchAttemptResult, evidenceRefs: string[] = []) {
  return createEvidenceSearchAttempt({
    authority: "official",
    stage: result === "parse_failed" ? "parse" : result === "identity_unresolved" ? "identity" : "discovery",
    result,
    officialUrl: "https://www.asus.com/supportonly/pro-ws-x870e-sage-se/helpdesk_manual/",
    evidenceRefs,
    detail: `Audited terminal result: ${result}`,
    attemptedAt: at,
  });
}

describe("official search outcome contract", () => {
  it("keeps reason strict, total, and exactly equal to the seven U4 reasons", () => {
    expect(EVIDENCE_SEARCH_REASONS).toEqual([
      "official_not_published",
      "official_page_found_field_missing",
      "official_identity_unresolved",
      "official_access_blocked",
      "official_parse_failed",
      "official_sources_conflict",
      "official_search_exhausted",
    ]);
    expect(Object.isFrozen(EVIDENCE_SEARCH_REASONS)).toBe(true);
    for (const reason of EVIDENCE_SEARCH_REASONS) expect(isEvidenceSearchReason(reason)).toBe(true);
    for (const hostile of [undefined, null, "", "official_unknown", 1, {}, ["official_search_exhausted"]]) {
      expect(isEvidenceSearchReason(hostile)).toBe(false);
    }
  });

  it.each([
    ["not_published", "official_not_published", [], true],
    ["field_missing", "official_page_found_field_missing", ["claim-page"], false],
    ["identity_unresolved", "official_identity_unresolved", ["capture-series"], false],
    ["access_blocked", "official_access_blocked", [], false],
    ["parse_failed", "official_parse_failed", ["doc-pdf"], false],
    ["sources_conflict", "official_sources_conflict", ["claim-a", "claim-b"], false],
    ["exhausted", "official_search_exhausted", [], true],
  ])("derives %s into an auditable %s outcome", (result, expected, evidenceRefs, exhaustive) => {
    const attempt = searchAttempt(result as EvidenceSearchAttemptResult, evidenceRefs);
    expect(classifyEvidenceSearchReason([attempt])).toBe(expected);
    const outcome = createEvidenceSearchOutcome({
      subject: product,
      field: "firmware.cpu_support",
      attempts: [attempt],
      exhaustive,
      thirdPartyEvidenceRefs: ["third-party-fallback-claim"],
      detail: `Official search ended with ${expected}`,
      manualAction: "Inspect the archived attempt, then provide a missing revision or alternate source.",
      searchedAt: at,
    });
    expect(outcome).toMatchObject({
      reason: expected,
      searchAttemptRefs: [attempt.attemptId],
      officialEvidenceRefs: evidenceRefs,
      thirdPartyEvidenceRefs: ["third-party-fallback-claim"],
      exhaustive,
    });
    expect(outcome.searchOutcomeId).toBe(`search-outcome-sha256-${outcome.contentHash}`);
    expect(validateEvidenceSearchOutcome(outcome)).toEqual([]);
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("fails closed for forged reasons, missing audit closure, hostile objects, and inconsistent terminal state", () => {
    const attempt = searchAttempt("access_blocked");
    const valid = createEvidenceSearchOutcome({
      subject: product,
      field: "firmware.cpu_support",
      attempts: [attempt],
      exhaustive: false,
      detail: "The official host returned an access barrier.",
      manualAction: "Retry later without bypassing the barrier.",
      searchedAt: at,
    });
    const forged = structuredClone(valid) as unknown as Record<string, unknown>;
    forged.reason = "official_magic_success";
    expect(validateEvidenceSearchOutcome(forged).join(" ")).toMatch(/reason/i);
    const missingAudit = structuredClone(valid) as unknown as Record<string, unknown>;
    missingAudit.searchAttemptRefs = [];
    expect(validateEvidenceSearchOutcome(missingAudit).join(" ")).toMatch(/attempt/i);
    expect(() => createEvidenceSearchOutcome({
      subject: product,
      field: "firmware.cpu_support",
      attempts: [attempt],
      reason: "official_not_published",
      exhaustive: true,
      detail: "forged terminal reason",
      manualAction: "none",
      searchedAt: at,
    })).toThrow(/reason/i);

    const cyclic: Record<string, unknown> = { ...valid };
    cyclic.subject = cyclic;
    expect(() => validateEvidenceSearchOutcome(cyclic)).not.toThrow();
    expect(validateEvidenceSearchOutcome(cyclic)).not.toEqual([]);
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "reason", { enumerable: true, get: () => { throw new Error("hostile getter"); } });
    expect(() => validateEvidenceSearchOutcome(accessor)).not.toThrow();
    expect(validateEvidenceSearchOutcome(accessor)).not.toEqual([]);
  });

  it("surfaces the same machine-readable reason on discovery, acquisition, and parse boundaries", async () => {
    const url = "https://www.jonsbo.com/en/products/N6Black.html";
    const empty = await discoverOfficialDocumentLinks(url, {
      fetcher: async () => ({
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        contentType: "text/html",
        body: "<main>No product document has been published here.</main>",
        redirects: [],
      }),
      followPageLimit: 0,
    });
    expect(empty).toMatchObject({
      candidates: [],
      officialFailure: {
        reason: "official_search_exhausted",
        detail: expect.any(String),
        manualAction: expect.any(String),
      },
    });

    const blocked = await discoverOfficialDocumentLinks(url, {
      fetcher: async () => ({
        requestedUrl: url,
        finalUrl: url,
        status: 403,
        contentType: "text/html",
        body: "Access denied",
        redirects: [],
      }),
    }).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(EvidenceDiscoveryError);
    expect(blocked).toMatchObject({ reason: "official_access_blocked" });
    expect(new EvidenceExcerptError("evidence_pdf_parse_failed", "fixture parser failure", 422)).toMatchObject({
      reason: "official_parse_failed",
    });
  });
});

function officialConfirmation(documentSha256: string) {
  return createOfficialDocumentIdentityConfirmation({
    authority: "official",
    documentSha256,
    pageKind: "manual",
    scope: "revision",
    identity: {
      brand: "ASUS",
      skuId: product.skuId,
      familyId: product.familyId,
      modelId: product.modelId,
      variantId: product.variantId,
      revision: product.revision,
      region: product.region,
    },
    locator: {
      page: 2,
      section: "Product identification",
      excerpt: "PRO WS X870E-SAGE SE motherboard — PCB Revision 1.1",
    },
    matchedTokens: { model: product.modelId, variant: product.variantId, revision: product.revision },
    extractor: { id: "bounded-pdf-text", version: "1.0.0" },
    confirmedAt: at,
  });
}

describe("official identity and revision promotion gate", () => {
  it("promotes only a trusted official document whose body proof matches the exact model, variant, revision, and bytes", () => {
    const documentSha256 = sha256("official manual bytes");
    const confirmation = officialConfirmation(documentSha256);
    const promotion = evaluateOfficialDocumentPromotion({
      registryTrust: "trusted",
      documentSha256,
      requiredScope: "revision",
      expectedIdentity: { brand: "ASUS", ...product },
      confirmation,
    });
    expect(validateOfficialDocumentIdentityConfirmation(confirmation)).toEqual([]);
    expect(promotion).toMatchObject({
      eligible: true,
      authority: "official",
      kindBasis: "content-verified",
      identity: {
        basis: "official-document-explicit",
        skuId: product.skuId,
        modelId: product.modelId,
        variantId: product.variantId,
        revision: product.revision,
      },
    });
    expect(EVIDENCE_LADDER_LEVELS[0]).toMatchObject({ level: 1, authority: "official", identityScope: "revision" });
  });

  it.each([
    ["series", "official_identity_unresolved"],
    ["captcha", "official_access_blocked"],
    ["error", "official_parse_failed"],
  ])("never upgrades a %s page", (pageKind, reason) => {
    const documentSha256 = sha256(`official ${pageKind} bytes`);
    const confirmation = { ...officialConfirmation(documentSha256), pageKind };
    const promotion = evaluateOfficialDocumentPromotion({
      registryTrust: "trusted",
      documentSha256,
      requiredScope: "revision",
      expectedIdentity: { brand: "ASUS", ...product },
      confirmation: confirmation as never,
    });
    expect(promotion).toMatchObject({ eligible: false, reason });
    expect(promotion).not.toHaveProperty("identity.basis", "official-document-explicit");
  });

  it("rejects a spoofed explicit basis before fetching and promotes a separately hash-bound confirmation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-evidence-ladder-"));
    roots.push(root);
    const repository = new FileEvidenceRepository({ root });
    const url = "https://www.asus.com/support/manual-u4.pdf";
    const bytes = Buffer.from("official manual bytes");
    let fetchCount = 0;
    const fetcher = vi.fn(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? {
            requestedUrl: url,
            finalUrl: url,
            status: 200,
            contentType: "application/pdf",
            body: "",
            rawBody: bytes,
            contentHash: sha256(bytes),
            redirects: [],
          }
        : {
            requestedUrl: url,
            finalUrl: url,
            status: 304,
            contentType: "",
            body: "",
            rawBody: Buffer.alloc(0),
            redirects: [],
          };
    });
    const identity = {
      brand: "ASUS",
      skuId: product.skuId,
      familyId: product.familyId,
      modelId: product.modelId,
      variantId: product.variantId,
      revision: product.revision,
      region: product.region,
    };
    await expect(acquireOfficialEvidence(url, {
      repository,
      fetcher,
      productIdentities: [{ ...identity, basis: "official-document-explicit" }],
    })).rejects.toMatchObject({ code: "manual_identity_confirmation_required", reason: "official_identity_unresolved" });
    expect(fetcher).not.toHaveBeenCalled();

    const acquired = await acquireOfficialEvidence(url, {
      repository,
      fetcher,
      cacheTtlMs: 0,
      productIdentities: [{ ...identity, basis: "governed-sku-user-asserted" }],
      identityConfirmation: officialConfirmation(sha256(bytes)),
      requiredIdentityScope: "revision",
      clock: () => new Date(at),
    });
    expect(acquired.capture).toMatchObject({
      kindBasis: "content-verified",
      productIdentities: [{ ...identity, basis: "official-document-explicit" }],
    });

    const replayedPromotion = await acquireOfficialEvidence(url, {
      repository,
      fetcher,
      cacheTtlMs: 24 * 60 * 60 * 1_000,
      productIdentities: [{ ...identity, basis: "governed-sku-user-asserted" }],
      identityConfirmation: officialConfirmation(sha256(bytes)),
      requiredIdentityScope: "revision",
      clock: () => new Date("2026-08-28T00:30:00.000Z"),
    });
    expect(replayedPromotion).toMatchObject({
      cacheStatus: "fresh",
      reusedCapture: true,
      identityPromotion: { eligible: true, confirmationId: acquired.identityPromotion.confirmationId },
    });
    expect(replayedPromotion.capture.id).toBe(acquired.capture.id);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const siblingIdentity = {
      ...identity,
      skuId: "motherboard.asus-pro-ws-x870e-sage-se-rev-2",
      variantId: "PRO WS X870E-SAGE SE REV 2",
      revision: "2.0",
    };
    const sibling = await acquireOfficialEvidence(url, {
      repository,
      fetcher,
      cacheTtlMs: 24 * 60 * 60 * 1_000,
      productIdentities: [{ ...siblingIdentity, basis: "governed-sku-user-asserted" }],
      clock: () => new Date("2026-08-28T01:00:00.000Z"),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sibling.capture.id).not.toBe(acquired.capture.id);
    expect(sibling.capture).toMatchObject({
      kindBasis: "user-asserted",
      productIdentities: [{ ...siblingIdentity, basis: "governed-sku-user-asserted" }],
    });
  });
});

function thirdPartySource(overrides: Record<string, unknown> = {}) {
  return createThirdPartyEvidenceSource({
    authority: "third_party",
    sourceType: "professional_measurement",
    canonicalUrl: "https://lab-a.example/reviews/x870e-sage-se-rev-1-1",
    publisherId: "lab-a",
    originalWorkId: "lab-a/x870e-sage-se/2026",
    independenceGroupId: "lab-a",
    editorialControl: "independent",
    fundingDisclosure: "independent",
    subject: {
      skuId: product.skuId,
      familyId: product.familyId,
      modelId: product.modelId,
      variantId: product.variantId,
      revision: product.revision,
    },
    objectRevision: product.revision,
    testMethod: {
      kind: "measurement",
      description: "Calibrated bench measurement on a retail sample.",
      sampleSize: 1,
    },
    sourceContentHash: sha256("lab-a archived page"),
    retrievedAt: at,
    ...overrides,
  });
}

function finding(source: { sourceId: string }, value = "clearance=42.0mm") {
  return {
    sourceId: source.sourceId,
    fieldId: "mechanical.clearance",
    normalizedValueHash: sha256(value),
    unit: "mm",
  };
}

describe("third-party authority and source independence", () => {
  it("keeps one professional measurement low-confidence third-party and upgrades only two independent consistent originals", () => {
    const first = thirdPartySource();
    const one = assessThirdPartySourceIndependence([first], { findings: [finding(first)], assessedAt: at });
    expect(one).toMatchObject({
      authority: "third_party",
      independentCount: 1,
      confidence: "low",
      ladderLevel: 4,
    });

    const second = thirdPartySource({
      sourceType: "professional_review",
      canonicalUrl: "https://lab-b.example/testing/x870e-sage-se-rev-1-1",
      publisherId: "lab-b",
      originalWorkId: "lab-b/x870e-sage-se/2026",
      independenceGroupId: "lab-b",
      testMethod: {
        kind: "documented_inspection",
        description: "Independent teardown inspection on a retail revision 1.1 sample.",
        sampleSize: 1,
      },
      sourceContentHash: sha256("lab-b archived page"),
    });
    const two = assessThirdPartySourceIndependence([first, second], {
      findings: [finding(first), finding(second)],
      assessedAt: at,
    });
    expect(two).toMatchObject({
      authority: "third_party",
      independentCount: 2,
      confidence: "corroborated",
      ladderLevel: 5,
    });
    expect(two.qualifyingSourceIds).toEqual(expect.arrayContaining([first.sourceId, second.sourceId]));
    expect(validateThirdPartyIndependenceAssessment(two)).toEqual([]);
    expect(resolveEvidenceLadder({ thirdPartyAssessment: two })).toMatchObject({ level: 5, authority: "third_party" });
  });

  it("detects reposts and shared editorial origins instead of double-counting them", () => {
    const original = thirdPartySource();
    const repost = thirdPartySource({
      sourceType: "repost",
      canonicalUrl: "https://syndicated.example/lab-a-x870e-review",
      publisherId: "syndicated-site",
      sourceContentHash: sha256("syndicated copy"),
    });
    const sharedOwner = thirdPartySource({
      canonicalUrl: "https://lab-a-sister.example/x870e-review",
      publisherId: "lab-a-sister",
      originalWorkId: "lab-a-sister/original",
      sourceContentHash: sha256("sister-site copy"),
    });
    const assessment = assessThirdPartySourceIndependence([original, repost, sharedOwner], {
      findings: [finding(original), finding(repost), finding(sharedOwner)],
      assessedAt: at,
    });
    expect(assessment).toMatchObject({ independentCount: 1, ladderLevel: 4, confidence: "low" });
    expect(assessment.duplicateSourceIds).toEqual(expect.arrayContaining([repost.sourceId, sharedOwner.sourceId]));
  });

  it("never accepts or renders a third-party record as official, even on a vendor-looking host", () => {
    const source = thirdPartySource();
    expect(validateThirdPartyEvidenceSource(source)).toEqual([]);
    const forged = structuredClone(source) as unknown as Record<string, unknown>;
    forged.authority = "official";
    expect(validateThirdPartyEvidenceSource(forged).join(" ")).toMatch(/authority/i);
    expect(() => createThirdPartyEvidenceSource({
      ...source,
      authority: "official",
      canonicalUrl: "https://www.asus.com/reposted-review",
    } as never)).toThrow(/third.party|authority/i);
    expect(resolveEvidenceLadder({
      thirdPartyAssessment: assessThirdPartySourceIndependence([source], { findings: [finding(source)], assessedAt: at }),
    })).toMatchObject({ authority: "third_party" });
  });

  it("preserves a conflict when independent originals disagree instead of accepting a caller consistency flag", () => {
    const first = thirdPartySource();
    const second = thirdPartySource({
      canonicalUrl: "https://lab-b.example/testing/x870e-sage-se-rev-1-1",
      publisherId: "lab-b",
      originalWorkId: "lab-b/x870e-sage-se/2026",
      independenceGroupId: "lab-b",
      sourceContentHash: sha256("lab-b conflicting page"),
    });
    const assessment = assessThirdPartySourceIndependence([first, second], {
      findings: [finding(first, "clearance=42.0mm"), finding(second, "clearance=39.0mm")],
      assessedAt: at,
    });
    expect(assessment).toMatchObject({
      authority: "third_party",
      independentCount: 2,
      consistent: false,
      conflicted: true,
      ladderLevel: null,
      confidence: "none",
    });
    expect(resolveEvidenceLadder({ thirdPartyAssessment: assessment })).toMatchObject({ level: null, authority: null });
  });
});

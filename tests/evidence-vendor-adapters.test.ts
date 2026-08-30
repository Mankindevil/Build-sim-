import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import {
  createEvidenceAdapterCandidate,
  createGovernedEvidenceAdapterSeams,
  extractOfficialClaimsWithVendorAdapter,
  listEvidenceVendorAdapterManifests,
  replayEvidenceAdapterCandidate,
  validateEvidenceAdapterCandidate,
  validateEvidenceExtractionAdapterManifest,
  vendorAdapterSearchQueries,
  verifyEvidenceAdapterCandidate,
  verifyEvidenceExtractionAdapterManifest,
  type BoundedEvidenceExcerptSet,
  type BuiltInThirdPartyAdapterAcquisition,
} from "../src/evidence/adapters/index";
import { extractEvidenceExcerpts } from "../src/evidence/excerpts.mjs";
import {
  createEvidencePipelineRequest,
  evidenceStageIdempotencyKey,
  jobIdForEvidenceStage,
  type EvidencePipelineRequest,
  type EvidenceStageResult,
} from "../src/evidence/jobs/contracts";
import { createProductionEvidenceJobRuntime } from "../src/evidence/jobs/production";
import { evaluateOfficialDocumentPromotion } from "../src/evidence/ladder.mjs";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { factFieldPolicy, validateFactFieldValue } from "../src/facts/field-registry";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const FIXTURE_AT = "2026-08-28T00:00:00.000Z";
const fixtureFile = path.resolve("tests/fixtures/evidence/vendor-adapters/matrix.json");
const roots: string[] = [];

interface StaticExpectedClaim {
  fieldId: string;
  value: unknown;
  unit?: string;
}

interface VendorFixture {
  fixtureId: string;
  pageKind: string;
  sourceUrl: string;
  subject: EvidencePipelineRequest["subject"];
  requestedFieldIds: string[];
  pages: string[];
  expected: StaticExpectedClaim[];
}

interface FixtureMatrix {
  schemaVersion: string;
  fixtures: VendorFixture[];
  negativePages: Array<{ kind: string; expectedReason: string; text: string }>;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function matrix(): Promise<FixtureMatrix> {
  return JSON.parse(await readFile(fixtureFile, "utf8")) as FixtureMatrix;
}

function canonicalExpected(value: StaticExpectedClaim): string {
  return JSON.stringify({ fieldId: value.fieldId, value: value.value, ...(value.unit === undefined ? {} : { unit: value.unit }) });
}

async function requestFor(fixture: VendorFixture): Promise<EvidencePipelineRequest> {
  return createEvidencePipelineRequest({
    subject: fixture.subject,
    requestedFieldIds: fixture.requestedFieldIds,
    entry: { kind: "official_url", url: fixture.sourceUrl },
    allowThirdPartyFallback: true,
    requestedAt: FIXTURE_AT,
  });
}

async function archivedExtractorInput(fixture: VendorFixture) {
  const root = await mkdtemp(path.join(tmpdir(), `buildsim-${fixture.fixtureId}-`));
  roots.push(root);
  const repository = new FileEvidenceRepository({ root, now: () => FIXTURE_AT });
  const bytes = Buffer.from(fixture.pages.join("\f"), "utf8");
  const archived = await repository.importBuffer(bytes, {
    mediaType: "text/plain; charset=utf-8",
    kind: "manufacturer-manual",
    title: `${fixture.fixtureId} offline official fixture`,
    productIdentities: [{ brand: fixture.subject.brand, basis: "governed-sku-user-asserted", model: fixture.subject.modelId }],
    capture: {
      requestedUrl: fixture.sourceUrl,
      finalUrl: fixture.sourceUrl,
      retrievedAt: FIXTURE_AT,
      status: 200,
      redirects: [],
      officialBrand: fixture.subject.brand,
      acquisitionMethod: "bundled-import",
    },
  });
  const request = await requestFor(fixture);
  const queries = await vendorAdapterSearchQueries(request.subject, request.requestedFieldIds);
  const windows: BoundedEvidenceExcerptSet["excerpts"][number][] = [];
  for (const query of queries) {
    const found = await extractEvidenceExcerpts(repository, archived.document.id, { query, limit: 2 });
    for (const excerpt of found.excerpts) {
      if (!windows.some((entry) => entry.page === excerpt.page && entry.text === excerpt.text)) windows.push(excerpt);
    }
  }
  const excerpts = windows.slice(0, 8);
  const boundedExcerpt: BoundedEvidenceExcerptSet = {
    schemaVersion: "1.0.0",
    documentId: archived.document.id,
    contentHash: archived.document.sha256,
    mediaType: "text/plain",
    sourceByteLength: bytes.byteLength,
    query: "governed vendor adapter query set",
    totalPages: fixture.pages.length,
    searchedPageCount: fixture.pages.length,
    extractionMode: "utf8-text",
    contentTrust: "untrusted-evidence-text",
    returned: excerpts.length,
    excerpts,
    truncated: windows.length > excerpts.length || excerpts.some((entry) => entry.truncated),
  };
  return {
    request,
    excerpt: boundedExcerpt,
    documentId: archived.document.id,
    documentSha256: archived.document.sha256,
    captureId: archived.capture.id,
    sourceUrl: fixture.sourceUrl,
    attemptedAt: FIXTURE_AT,
  };
}

function completedPrior(
  request: EvidencePipelineRequest,
  stage: "claim_extraction" | "third_party_fallback",
  output: Readonly<Record<string, unknown>>,
  resultRefs: readonly `sha256:${string}`[] = [],
): EvidenceStageResult {
  const jobId = jobIdForEvidenceStage(request.pipelineId, stage);
  return {
    schemaVersion: "evidence-stage-result-v1",
    pipelineId: request.pipelineId,
    stage,
    handlerVersion: "1",
    jobId,
    idempotencyKey: evidenceStageIdempotencyKey(request.pipelineId, stage),
    attemptStartedAt: FIXTURE_AT,
    completedAt: FIXTURE_AT,
    status: "completed",
    inputRefs: [],
    output,
    resultRefs,
  };
}

function builtInThirdPartyAcquisition(
  fixture: VendorFixture,
  publisherId: string,
  independenceGroupId = publisherId,
): BuiltInThirdPartyAdapterAcquisition {
  const finalUrl = `https://${publisherId}.example/asus-rev-1-fan-test`;
  const bytes = Buffer.from([
    "thermal.fan_curve",
    `Product Model: ${fixture.subject.modelId}`,
    `Product Variant: ${fixture.subject.variantId}`,
    `Product Revision: ${fixture.subject.revision}`,
    `Product Region: ${fixture.subject.region}`,
    `Original Work ID: ${publisherId}-asus-fan-test-2026`,
    `Object Revision: ${fixture.subject.revision}`,
    "Test Method Kind: measurement",
    "Test Method Description: Instrumented fan duty measurement on the exact retail revision.",
    "Test Sample Size: 1",
    "Test Equipment: calibrated-tachometer,temperature-probe",
    "Test Conditions: controlled-ambient",
    "Fan Curve: curveId=chassis-fan-1;input=temperature_c;output=duty_percent;points=30:20,50:50,70:100",
  ].join("\n"), "utf8");
  const sourceContentHash = createHash("sha256").update(bytes).digest("hex");
  const artifactHash = createHash("sha256").update(`artifact:${sourceContentHash}`, "utf8").digest("hex");
  return {
    source: {
      publisherId,
      name: `Independent lab ${publisherId}`,
      domains: [`${publisherId}.example`],
      sourceType: "professional_measurement",
      independenceGroupId,
      editorialControl: "independent",
      fundingDisclosure: "independent",
      enabled: true,
      approvedAt: FIXTURE_AT,
    },
    requestedUrl: finalUrl,
    finalUrl,
    redirects: [],
    mediaType: "text/plain",
    bytes,
    sourceContentHash,
    retrievedAt: FIXTURE_AT,
    artifactRef: `sha256:${artifactHash}`,
  };
}

describe("U4 governed vendor/category evidence adapters", () => {
  it("freezes a strict content-addressed manifest matrix covering every required U4 domain", async () => {
    const manifests = await listEvidenceVendorAdapterManifests();
    const producerIndependentCoverage = new Set([
      "motherboard.cpu_socket",
      "firmware.cpu_support",
      "compatibility.qvl_entry",
      "firmware.upgrade_method",
      "package.contents",
      "package.fastener_count",
      "package.tool_required",
      "io.port_topology",
      "power.cable_families",
      "package.cable_count",
      "thermal.fan_curve",
      "storage.logical_sector_size",
      "storage.physical_sector_size",
      "storage.recording_technology",
      "storage.endurance_tbw",
      "hba.mode",
      "system.requirement",
    ]);
    const emitted = new Set(manifests.flatMap((manifest) => manifest.supportedFieldIds));
    expect(manifests.map((manifest) => manifest.brandId)).toEqual(expect.arrayContaining([
      "asus", "intel", "samsung", "seasonic", "seagate", "corsair", "broadcom", "truenas",
    ]));
    expect([...producerIndependentCoverage].filter((fieldId) => !emitted.has(fieldId))).toEqual([]);
    for (const manifest of manifests) {
      expect(validateEvidenceExtractionAdapterManifest(manifest)).toEqual([]);
      await expect(verifyEvidenceExtractionAdapterManifest(manifest)).resolves.toBe(true);
      expect(manifest.manifestRef).toBe(`sha256:${manifest.contentHash}`);
      expect(Object.isFrozen(manifest)).toBe(true);
      for (const fieldId of manifest.supportedFieldIds) expect(factFieldPolicy(fieldId), fieldId).not.toBeNull();
    }
  });

  it("freezes exact schemas, scope, safety, and source policy for the five added governed fields", () => {
    const governed = [
      {
        fieldId: "compatibility.qvl_entry",
        value: { componentSkuId: "memory.exact", boardRevision: "1.1", region: "global", sinceVersion: "1402", status: "qualified" },
        policy: { allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"] },
      },
      {
        fieldId: "io.port_topology",
        value: { endpointId: "sata-1", connectorType: "sata-7pin", location: "internal", controllerId: "w680", pathId: "channel-1", quantity: 1 },
        policy: { allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"] },
      },
      {
        fieldId: "package.cable_count",
        value: { cableId: "pcie-5", connectorFamily: "pcie-5.0-16pin", quantity: 2 },
        policy: { allowedScopes: ["variant", "revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"] },
      },
      {
        fieldId: "thermal.fan_curve",
        value: { curveId: "fan-1", input: "temperature_c", output: "duty_percent", points: [{ input: 30, output: 20 }, { input: 70, output: 100 }] },
        policy: { allowedScopes: ["variant", "revision"], safetyClass: "normal", sourcePolicy: "official_third_party_or_user_observation", passAuthorities: ["official", "third_party"], userObservationPassAllowed: false },
      },
      {
        fieldId: "system.requirement",
        value: { systemProfileId: "system.truenas-scale", releaseId: "system-release.truenas-scale.25.04", requirementId: "memory.minimum", operator: "gte", valueType: "number", value: 8, unit: "gib" },
        policy: { allowedScopes: ["revision"], safetyClass: "compatibility_critical", sourcePolicy: "official_required", passAuthorities: ["official"] },
      },
    ] as const;
    for (const row of governed) {
      const policy = factFieldPolicy(row.fieldId)!;
      expect(policy, row.fieldId).toMatchObject(row.policy);
      expect(validateFactFieldValue(policy, row.value, undefined), row.fieldId).toEqual([]);
      expect(validateFactFieldValue(policy, { ...row.value, freeFormBackdoor: true }, undefined), row.fieldId).not.toEqual([]);
    }

    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const accessor = Object.create(null); Object.defineProperty(accessor, "value", { enumerable: true, get: () => { throw new Error("hostile getter"); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const fieldId of governed.map(({ fieldId }) => fieldId)) for (const hostile of [cyclic, accessor, revoked.proxy]) {
      const policy = factFieldPolicy(fieldId)!;
      expect(() => validateFactFieldValue(policy, hostile, undefined), fieldId).not.toThrow();
      expect(validateFactFieldValue(policy, hostile, undefined), fieldId).not.toEqual([]);
    }
  });

  it("runs ASUS, Intel, Samsung, Seasonic, Seagate, Corsair, Broadcom, and TrueNAS through offline archive-to-candidate E2E fixtures", async () => {
    const fixtures = (await matrix()).fixtures;
    expect(fixtures).toHaveLength(8);
    const network = vi.fn(async () => { throw new Error("offline E2E must not access the network"); });
    vi.stubGlobal("fetch", network);
    for (const fixture of fixtures) {
      const input = await archivedExtractorInput(fixture);
      const first = await extractOfficialClaimsWithVendorAdapter(input);
      const replay = await extractOfficialClaimsWithVendorAdapter(input);
      expect(first, fixture.fixtureId).toMatchObject({ status: "completed", missingFieldIds: [] });
      expect(replay, `${fixture.fixtureId} deterministic extraction`).toEqual(first);
      if (first.status !== "completed") throw new Error(`${fixture.fixtureId} did not complete`);
      expect(evaluateOfficialDocumentPromotion(first.officialPromotionInput), fixture.fixtureId)
        .toMatchObject({ eligible: true, authority: "official", identity: { revision: fixture.subject.revision } });
      expect(first.claimCandidates.every((claim) => claim.authority === "official"), fixture.fixtureId).toBe(true);
      const actual = first.claimCandidates.map(canonicalExpected).sort();
      const expected = fixture.expected.map(canonicalExpected).sort();
      expect(actual, fixture.fixtureId).toEqual(expected);
      for (const claim of first.claimCandidates) {
        const policy = factFieldPolicy(claim.fieldId);
        expect(policy, claim.fieldId).not.toBeNull();
        expect(validateFactFieldValue(policy!, claim.value, claim.unit), claim.fieldId).toEqual([]);
      }

      const candidateInput = {
        request: input.request,
        claims: first.claimCandidates,
        officialPromotionInput: first.officialPromotionInput,
      };
      const candidate = await createEvidenceAdapterCandidate(candidateInput);
      expect(candidate).toMatchObject({ candidateStatus: "ready_for_review", approvalRequired: true });
      expect(candidate.officialPromotionProof).toMatchObject({
        proofRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        promotionInput: { confirmation: { extractor: { id: first.adapterId, version: first.adapterVersion } } },
      });
      expect(candidate.claimSources).toHaveLength(first.claimCandidates.length);
      expect(candidate.claimSources.every(({ documentId, captureId }) => documentId.startsWith("doc-sha256-")
        && captureId.startsWith("capture-sha256-"))).toBe(true);
      expect(validateEvidenceAdapterCandidate(candidate), fixture.fixtureId).toEqual([]);
      await expect(verifyEvidenceAdapterCandidate(candidate), fixture.fixtureId).resolves.toBe(true);
      await expect(replayEvidenceAdapterCandidate(candidateInput, candidate), fixture.fixtureId)
        .resolves.toEqual(candidate);
      expect(candidate.capabilities.map(({ fieldId }) => fieldId).sort())
        .toEqual(fixture.expected.map(({ fieldId }) => fieldId).sort());
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("fails closed on exact identity/revision gaps, missing fields, content tampering, captcha/error/series pages, and non-official hosts", async () => {
    const data = await matrix();
    const fixture = data.fixtures[0]!;
    const valid = await archivedExtractorInput(fixture);

    for (const page of data.negativePages) {
      const documentSha256 = createHash("sha256").update(page.text).digest("hex");
      const result = await extractOfficialClaimsWithVendorAdapter({
        ...valid,
        documentId: `doc-sha256-${documentSha256}`,
        documentSha256,
        captureId: `capture-sha256-${"c".repeat(64)}`,
        excerpt: {
          ...valid.excerpt,
          documentId: `doc-sha256-${documentSha256}`,
          contentHash: documentSha256,
          sourceByteLength: Buffer.byteLength(page.text),
          returned: 1,
          excerpts: [{ page: 1, matchType: "terms", matchedTerms: [], text: page.text, truncated: false }],
          truncated: false,
        },
      });
      expect(result, page.kind).toMatchObject({ status: "needs_review", reason: page.expectedReason, claimCandidates: [] });
    }

    await expect(extractOfficialClaimsWithVendorAdapter({ ...valid, documentSha256: "d".repeat(64) }))
      .resolves.toMatchObject({ status: "needs_review", reason: "official_parse_failed", claimCandidates: [] });
    await expect(extractOfficialClaimsWithVendorAdapter({ ...valid, sourceUrl: "https://independent-review.example/asus" }))
      .resolves.toMatchObject({ status: "needs_review", reason: "official_identity_unresolved", claimCandidates: [] });
    const wrongRevision = structuredClone(valid);
    wrongRevision.request = { ...wrongRevision.request, subject: { ...wrongRevision.request.subject, revision: "2.0" } };
    await expect(extractOfficialClaimsWithVendorAdapter(wrongRevision))
      .resolves.toMatchObject({ status: "needs_review", reason: "official_identity_unresolved", claimCandidates: [] });
    const missing = { ...valid, request: { ...valid.request, requestedFieldIds: [...valid.request.requestedFieldIds, "package.contents"] } };
    await expect(extractOfficialClaimsWithVendorAdapter(missing))
      .resolves.toMatchObject({ status: "needs_review", missingFieldIds: ["package.contents"], claimCandidates: [] });

    const conflictingText = `${valid.excerpt.excerpts[0]!.text}\nCPU Socket: AM5`;
    const conflictingHash = createHash("sha256").update(conflictingText).digest("hex");
    await expect(extractOfficialClaimsWithVendorAdapter({
      ...valid,
      documentId: `doc-sha256-${conflictingHash}`,
      documentSha256: conflictingHash,
      captureId: `capture-sha256-${"e".repeat(64)}`,
      excerpt: {
        ...valid.excerpt,
        documentId: `doc-sha256-${conflictingHash}`,
        contentHash: conflictingHash,
        sourceByteLength: Buffer.byteLength(conflictingText),
        returned: 1,
        excerpts: [{ page: 1, matchType: "terms", matchedTerms: [], text: conflictingText, truncated: false }],
        truncated: false,
      },
    })).resolves.toMatchObject({
      status: "needs_review",
      reason: "official_sources_conflict",
      missingFieldIds: ["motherboard.cpu_socket"],
      claimCandidates: [],
    });
  });

  it("never relabels third-party claims official and blocks official-required fields from candidate capabilities", async () => {
    const fixture = (await matrix()).fixtures.find(({ fixtureId }) => fixtureId.startsWith("asus-"))!;
    const input = await archivedExtractorInput(fixture);
    const extracted = await extractOfficialClaimsWithVendorAdapter(input);
    if (extracted.status !== "completed") throw new Error("fixture extraction failed");
    const thirdPartyClaims = extracted.claimCandidates.map((claim) => ({ ...claim, authority: "third_party" as const }));
    const candidate = await createEvidenceAdapterCandidate({ request: input.request, claims: thirdPartyClaims });
    expect(candidate.authorities).toEqual(["third_party"]);
    expect(candidate.capabilities.some((capability) => capability.authority === "official")).toBe(false);
    expect(candidate.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: "motherboard.cpu_socket", reason: "official_authority_required" }),
      expect.objectContaining({ fieldId: "firmware.cpu_support", reason: "official_authority_required" }),
    ]));
    expect(candidate.candidateStatus).toBe("needs_review");
  });

  it("exports directly injectable official/third-party/adapterGenerator seams with low then corroborated third-party confidence", async () => {
    const fixture = (await matrix()).fixtures.find(({ fixtureId }) => fixtureId.startsWith("asus-"))!;
    const archived = await archivedExtractorInput(fixture);
    const seams = createGovernedEvidenceAdapterSeams();
    const official = await seams.officialClaimExtractor(archived);
    expect(official).toMatchObject({ status: "completed" });
    expect(official.claimCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ authority: "official" })]));
    if (official.status !== "completed") throw new Error("official seam failed");
    const candidate = await seams.adapterGenerator({
      request: archived.request,
      claims: official.claimCandidates,
      priorResults: [completedPrior(archived.request, "claim_extraction", { officialPromotionInput: official.officialPromotionInput })],
    });
    expect(candidate).toMatchObject({ candidateStatus: "ready_for_review", authorities: ["official"] });

    const thermalRequest = await createEvidencePipelineRequest({
      subject: fixture.subject,
      requestedFieldIds: ["thermal.fan_curve"],
      entry: { kind: "official_url", url: fixture.sourceUrl },
      allowThirdPartyFallback: true,
      requestedAt: FIXTURE_AT,
    });
    const acquisition = (publisherId: string, hash: string, capture: string) => ({
      finalUrl: `https://${publisherId}.example/asus-rev-1`,
      sourceContentHash: hash,
      captureId: `capture-sha256-${capture}`,
      retrievedAt: FIXTURE_AT,
      boundedExcerpt: {
        ...archived.excerpt,
        documentId: `doc-sha256-${hash}`,
        contentHash: hash,
      },
      source: {
        publisherId,
        sourceType: "professional_measurement" as const,
        independenceGroupId: publisherId,
        editorialControl: "independent" as const,
        fundingDisclosure: "independent" as const,
      },
      extractionContext: {
        originalWorkId: `${publisherId}-asus-thermal-2026`,
        objectRevision: fixture.subject.revision!,
        testMethod: {
          kind: "measurement" as const,
          description: "Instrumented fan duty measurement on the exact retail revision.",
          sampleSize: 1,
          equipment: ["calibrated tachometer", "temperature probe"],
        },
      },
    });
    const first = acquisition("lab-a", "1".repeat(64), "a".repeat(64));
    const low = await seams.thirdPartyClaimExtractor({ request: thermalRequest, acquisitions: [first], assessedAt: FIXTURE_AT });
    expect(low.claimCandidates.every((claim) => claim.authority === "third_party")).toBe(true);
    expect(low.independenceAssessment).toMatchObject({ confidence: "low", ladderLevel: 4, independentCount: 1 });
    expect(low).not.toHaveProperty("officialPromotionInput");

    const second = acquisition("lab-b", "2".repeat(64), "b".repeat(64));
    const corroborated = await seams.thirdPartyClaimExtractor({ request: thermalRequest, acquisitions: [first, second], assessedAt: FIXTURE_AT });
    expect(corroborated.independenceAssessment).toMatchObject({ confidence: "corroborated", ladderLevel: 5, independentCount: 2 });
    const thirdPartyCandidate = await seams.adapterGenerator({
      request: thermalRequest,
      claims: corroborated.claimCandidates,
      priorResults: [completedPrior(thermalRequest, "third_party_fallback", {
        thirdPartySources: corroborated.thirdPartySources,
        thirdPartyFindings: corroborated.thirdPartyFindings,
        assessedAt: corroborated.assessedAt,
      })],
    });
    expect(thirdPartyCandidate).toMatchObject({ candidateStatus: "ready_for_review", authorities: ["third_party"] });
    expect(thirdPartyCandidate.capabilities.every((capability) => capability.authority === "third_party")).toBe(true);
  });

  it("converts built-in approved archives into bounded exact-revision level 4/5 evidence without counting a syndicated group twice", async () => {
    const fixture = (await matrix()).fixtures.find(({ fixtureId }) => fixtureId.startsWith("asus-"))!;
    const request = await createEvidencePipelineRequest({
      subject: fixture.subject,
      requestedFieldIds: ["thermal.fan_curve"],
      entry: { kind: "official_url", url: fixture.sourceUrl },
      allowThirdPartyFallback: true,
      requestedAt: FIXTURE_AT,
    });
    const seams = createGovernedEvidenceAdapterSeams();
    const first = builtInThirdPartyAcquisition(fixture, "lab-a");
    const second = builtInThirdPartyAcquisition(fixture, "lab-b");
    const syndicated = builtInThirdPartyAcquisition(fixture, "lab-syndicated", "lab-a");

    const low = await seams.thirdPartyClaimExtractor({ request, acquisitions: [first], assessedAt: FIXTURE_AT });
    expect(low.independenceAssessment).toMatchObject({ ladderLevel: 4, confidence: "low", independentCount: 1 });
    expect(low.claimCandidates.every((claim) => claim.authority === "third_party")).toBe(true);
    const corroborated = await seams.thirdPartyClaimExtractor({ request, acquisitions: [first, second], assessedAt: FIXTURE_AT });
    expect(corroborated.independenceAssessment).toMatchObject({ ladderLevel: 5, confidence: "corroborated", independentCount: 2 });
    const duplicateGroup = await seams.thirdPartyClaimExtractor({ request, acquisitions: [first, syndicated], assessedAt: FIXTURE_AT });
    expect(duplicateGroup.independenceAssessment).toMatchObject({ ladderLevel: 4, confidence: "low", independentCount: 1 });
    expect(duplicateGroup.independenceAssessment.duplicateSourceIds).toHaveLength(1);

    const tamperedRevision = Buffer.from(first.bytes.toString().replace("Product Revision: 1.1", "Product Revision: 2.0"), "utf8");
    await expect(seams.thirdPartyClaimExtractor({
      request,
      acquisitions: [{
        ...first,
        bytes: tamperedRevision,
        sourceContentHash: createHash("sha256").update(tamperedRevision).digest("hex"),
      }],
      assessedAt: FIXTURE_AT,
    })).rejects.toThrow(/exact requested model\/variant\/revision/i);
  });

  it("composes the governed official extractor and adapter generator into the default production runtime", async () => {
    const fixture = (await matrix()).fixtures.find(({ fixtureId }) => fixtureId.startsWith("asus-"))!;
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-default-adapter-runtime-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => FIXTURE_AT });
    await coordinator.initialize("default-adapter-runtime-test");
    const evidenceRepository = new FileEvidenceRepository({ coordinator, runtimeRoot: root, now: () => FIXTURE_AT });
    const artifactRepository = new FileArtifactRepository({ coordinator, now: () => FIXTURE_AT });
    const sourceUrl = "https://www.asus.com/support/manual/asus-pro-ws-w680-ace-ipmi-manual.pdf";
    const body = Buffer.from([
      "motherboard.cpu_socket",
      `Product Model: ${fixture.subject.modelId}`,
      `Product Variant: ${fixture.subject.variantId}`,
      `Product Revision: ${fixture.subject.revision}`,
      `Product Region: ${fixture.subject.region}`,
      "CPU Socket: LGA1700",
    ].join("\n"), "utf8");
    const fetcher = vi.fn(async (_url: string, options: { includeBody?: boolean }) => ({
      status: 200,
      finalUrl: sourceUrl,
      redirects: [],
      body: body.toString("utf8"),
      contentType: options.includeBody === true ? "text/plain" : "application/pdf",
      contentHash: createHash("sha256").update(body).digest("hex"),
      retrievedAt: FIXTURE_AT,
      ...(options.includeBody === true ? { rawBody: body } : {}),
    }));
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      coordinator,
      evidenceRepository,
      artifactRepository,
      online: () => true,
      now: () => FIXTURE_AT,
      officialFetcher: fetcher,
      rateLimiter: Object.freeze({ acquire: async () => undefined }),
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue({
      subject: fixture.subject,
      requestedFieldIds: ["motherboard.cpu_socket"],
      entry: { kind: "official_url", url: sourceUrl },
      allowThirdPartyFallback: false,
      requestedAt: FIXTURE_AT,
    });
    await runtime.scheduler.drain(20);

    const status = await runtime.status(descriptor.pipelineId);
    expect(status.stages.find(({ stage }) => stage === "claim_extraction")?.result).toMatchObject({
      status: "completed",
      output: { claimCandidates: [expect.objectContaining({ fieldId: "motherboard.cpu_socket", authority: "official" })] },
    });
    const adapter = status.stages.find(({ stage }) => stage === "adapter_generation")?.result;
    expect(adapter).toMatchObject({
      status: "completed",
      output: {
        candidateStatus: "ready_for_review",
        approvalRequired: true,
        authorities: ["official"],
        extractionManifestRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        officialPromotionProof: {
          proofRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          promotionInput: { confirmation: { extractor: { id: "evidence.adapter.asus.motherboard", version: "1.0.0" } } },
        },
        claimSources: [expect.objectContaining({
          authority: "official",
          documentId: expect.stringMatching(/^doc-sha256-/),
          captureId: expect.stringMatching(/^capture-sha256-/),
        })],
      },
    });
    expect(await verifyEvidenceAdapterCandidate(adapter?.output)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves audited captcha, error, series, missing-field, and conflicting-official reasons through the production pipeline", async () => {
    const fixture = (await matrix()).fixtures.find(({ fixtureId }) => fixtureId.startsWith("asus-"))!;
    const sourceUrl = "https://www.asus.com/support/manual/asus-pro-ws-w680-ace-ipmi-manual.pdf";
    const identity = [
      "motherboard.cpu_socket",
      `Product Model: ${fixture.subject.modelId}`,
      `Product Variant: ${fixture.subject.variantId}`,
      `Product Revision: ${fixture.subject.revision}`,
      `Product Region: ${fixture.subject.region}`,
    ];
    const cases = [
      { name: "captcha", expected: "official_access_blocked", lines: [...identity, "Captcha: verify you are human"] },
      { name: "error", expected: "official_parse_failed", lines: [...identity, "Error 500: service unavailable"] },
      { name: "series", expected: "official_identity_unresolved", lines: [...identity, "Series overview: choose a model"] },
      { name: "missing", expected: "official_page_found_field_missing", lines: identity },
      { name: "conflict", expected: "official_sources_conflict", lines: [...identity, "CPU Socket: LGA1700", "CPU Socket: AM5"] },
    ] as const;

    for (const scenario of cases) {
      const root = await mkdtemp(path.join(tmpdir(), `buildsim-official-reason-${scenario.name}-`));
      roots.push(root);
      const coordinator = new RuntimeCoordinator({ root, now: () => FIXTURE_AT });
      await coordinator.initialize(`official-reason-${scenario.name}`);
      const evidenceRepository = new FileEvidenceRepository({ coordinator, runtimeRoot: root, now: () => FIXTURE_AT });
      const artifactRepository = new FileArtifactRepository({ coordinator, now: () => FIXTURE_AT });
      const body = Buffer.from(scenario.lines.join("\n"), "utf8");
      const runtime = createProductionEvidenceJobRuntime({
        runtimeRoot: root,
        coordinator,
        evidenceRepository,
        artifactRepository,
        online: () => true,
        now: () => FIXTURE_AT,
        officialFetcher: async () => ({
          status: 200,
          finalUrl: sourceUrl,
          redirects: [],
          body: body.toString("utf8"),
          contentType: "text/plain",
          contentHash: createHash("sha256").update(body).digest("hex"),
          retrievedAt: FIXTURE_AT,
          rawBody: body,
        }),
        rateLimiter: Object.freeze({ acquire: async () => undefined }),
      });
      await runtime.initialize();
      const descriptor = await runtime.enqueue({
        subject: fixture.subject,
        requestedFieldIds: ["motherboard.cpu_socket"],
        entry: { kind: "official_url", url: sourceUrl },
        allowThirdPartyFallback: false,
        requestedAt: FIXTURE_AT,
      });
      await runtime.scheduler.drain(20);
      const status = await runtime.status(descriptor.pipelineId);
      const extraction = status.stages.find(({ stage }) => stage === "claim_extraction")?.result;
      expect(extraction, scenario.name).toMatchObject({
        status: "needs_review",
        officialSearchReason: scenario.expected,
        output: {
          searchOutcome: { reason: scenario.expected },
          manualAction: expect.any(String),
          evidenceRefs: expect.arrayContaining([expect.stringMatching(/^sha256:[a-f0-9]{64}$/)]),
        },
      });
      if (scenario.expected === "official_sources_conflict") {
        expect((extraction?.output.evidenceRefs as string[]).length).toBeGreaterThanOrEqual(2);
      }
      expect(status.stages.find(({ stage }) => stage === "third_party_fallback")?.result)
        .toMatchObject({ status: "blocked", officialSearchReason: scenario.expected });
    }
  }, 15_000);

  it("runs the default production third-party seam through two approved independent archives and keeps the candidate non-official", async () => {
    const fixture = (await matrix()).fixtures.find(({ fixtureId }) => fixtureId.startsWith("asus-"))!;
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-default-third-party-runtime-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => FIXTURE_AT });
    await coordinator.initialize("default-third-party-adapter-runtime-test");
    const evidenceRepository = new FileEvidenceRepository({ coordinator, runtimeRoot: root, now: () => FIXTURE_AT });
    const artifactRepository = new FileArtifactRepository({ coordinator, now: () => FIXTURE_AT });
    const acquisitions = [builtInThirdPartyAcquisition(fixture, "lab-a"), builtInThirdPartyAcquisition(fixture, "lab-b")];
    const thirdPartyRegistry = {
      schemaVersion: "third-party-registry-v1",
      updatedAt: FIXTURE_AT,
      sources: acquisitions.map(({ source }) => source),
    };
    const officialFetcher = vi.fn(async (url: string) => ({
      status: 200,
      finalUrl: url,
      redirects: [],
      body: "<html><body>No exact product document is published here.</body></html>",
      contentType: "text/html",
      retrievedAt: FIXTURE_AT,
    }));
    const thirdPartyFetcher = vi.fn(async (url: string) => {
      const acquisition = acquisitions.find(({ finalUrl }) => finalUrl === url);
      if (!acquisition) throw new Error("unexpected third-party URL");
      return {
        status: 200,
        finalUrl: acquisition.finalUrl,
        redirects: [],
        rawBody: Buffer.from(acquisition.bytes),
        contentType: acquisition.mediaType,
        contentHash: acquisition.sourceContentHash,
        retrievedAt: FIXTURE_AT,
      };
    });
    const runtime = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      coordinator,
      evidenceRepository,
      artifactRepository,
      online: () => true,
      now: () => FIXTURE_AT,
      officialFetcher,
      thirdPartyRegistry,
      thirdPartyDiscovery: async () => acquisitions.map(({ finalUrl }) => ({ url: finalUrl })),
      thirdPartyFetcher,
      rateLimiter: Object.freeze({ acquire: async () => undefined }),
    });
    await runtime.initialize();
    const descriptor = await runtime.enqueue({
      subject: fixture.subject,
      requestedFieldIds: ["thermal.fan_curve"],
      entry: { kind: "search_query", query: "ASUS exact revision official fan curve" },
      allowThirdPartyFallback: true,
      requestedAt: FIXTURE_AT,
    });
    await runtime.scheduler.drain(20);

    const status = await runtime.status(descriptor.pipelineId);
    const fallback = status.stages.find(({ stage }) => stage === "third_party_fallback")?.result;
    expect(fallback).toMatchObject({
      status: "completed",
      output: {
        claimCandidates: [
          expect.objectContaining({ authority: "third_party", fieldId: "thermal.fan_curve" }),
          expect.objectContaining({ authority: "third_party", fieldId: "thermal.fan_curve" }),
        ],
        independenceAssessment: { ladderLevel: 5, confidence: "corroborated", independentCount: 2 },
      },
    });
    const adapter = status.stages.find(({ stage }) => stage === "adapter_generation")?.result;
    expect(adapter).toMatchObject({
      status: "completed",
      output: {
        candidateStatus: "ready_for_review",
        approvalRequired: true,
        authorities: ["third_party"],
        officialPromotionProof: null,
        thirdPartyProof: {
          assessment: { ladderLevel: 5, independentCount: 2 },
          proofRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        claimSources: [
          expect.objectContaining({ authority: "third_party", documentId: expect.stringMatching(/^doc-sha256-/), captureId: expect.stringMatching(/^capture-sha256-/) }),
          expect.objectContaining({ authority: "third_party", documentId: expect.stringMatching(/^doc-sha256-/), captureId: expect.stringMatching(/^capture-sha256-/) }),
        ],
      },
    });
    expect(await verifyEvidenceAdapterCandidate(adapter?.output)).toBe(true);
    expect(officialFetcher).toHaveBeenCalledTimes(1);
    expect(thirdPartyFetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps manifest/candidate validators strict, total, replay-bound, and hostile-input safe", async () => {
    const manifest = (await listEvidenceVendorAdapterManifests())[0]!;
    expect(validateEvidenceExtractionAdapterManifest({ ...manifest, backdoor: "free-field" }))
      .toContain("evidence adapter manifest contains unknown fields");
    await expect(verifyEvidenceExtractionAdapterManifest({ ...manifest, adapterVersion: "tampered" }))
      .resolves.toBe(false);
    const fixture = (await matrix()).fixtures[0]!;
    const input = await archivedExtractorInput(fixture);
    const extracted = await extractOfficialClaimsWithVendorAdapter(input);
    if (extracted.status !== "completed") throw new Error("fixture extraction failed");
    const candidate = await createEvidenceAdapterCandidate({
      request: input.request,
      claims: extracted.claimCandidates,
      officialPromotionInput: extracted.officialPromotionInput,
    });
    const tampered = { ...candidate, capabilities: candidate.capabilities.map((capability, index) => index ? capability : { ...capability, value: "guessed" }) };
    await expect(verifyEvidenceAdapterCandidate(tampered)).resolves.toBe(false);
    await expect(replayEvidenceAdapterCandidate({
      request: input.request,
      claims: extracted.claimCandidates,
      officialPromotionInput: extracted.officialPromotionInput,
    }, tampered as never))
      .rejects.toThrow(/replay/i);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "schemaVersion", { enumerable: true, get: () => { throw new Error("hostile getter"); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const hostile of [null, [], cyclic, accessor, revoked.proxy]) {
      expect(() => validateEvidenceExtractionAdapterManifest(hostile)).not.toThrow();
      expect(() => validateEvidenceAdapterCandidate(hostile)).not.toThrow();
      expect(validateEvidenceExtractionAdapterManifest(hostile)).not.toEqual([]);
      expect(validateEvidenceAdapterCandidate(hostile)).not.toEqual([]);
    }
  });
});

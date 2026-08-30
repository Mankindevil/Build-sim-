import { FileArtifactRepository } from "../../src/artifacts/repository.mjs";
import { EvidenceJobArtifactStore } from "../../src/evidence/jobs/artifact-store";
import { createEvidenceBindingProposalRuntime } from "../../src/evidence/binding-proposal-runtime.mjs";
import type {
  EvidencePipelineRequestInput,
  EvidenceStageEffectResult,
} from "../../src/evidence/jobs/contracts";
import type {
  EvidencePipelineServices,
  EvidenceStageEffectContext,
  EvidenceStageService,
} from "../../src/evidence/jobs/handlers";
import {
  createOfficialDocumentIdentityConfirmation,
  createThirdPartyEvidenceSource,
} from "../../src/evidence/ladder.mjs";
import { FileJobRepository } from "../../src/jobs/repository";

const A = "a".repeat(64);
const B = "b".repeat(64);

export const FIXED_NOW = "2026-08-28T00:00:00.000Z";

export function evidenceRequest(overrides: Partial<EvidencePipelineRequestInput> = {}): EvidencePipelineRequestInput {
  return {
    planId: "plan-universal-1",
    subject: {
      brand: "通用硬件厂商",
      category: "workstation motherboard",
      skuId: "sku-universal-board-1",
      familyId: "family-universal-board",
      modelId: "model-universal-board-1",
      variantId: "variant-universal-board-cn",
      revision: "rev-a",
      region: "CN",
    },
    requestedFieldIds: ["dimensions.width_mm", "interfaces.pcie_slots"],
    entry: { kind: "search_query", query: "通用硬件厂商 workstation motherboard official manual" },
    allowThirdPartyFallback: true,
    requestedAt: FIXED_NOW,
    ...overrides,
  };
}

export function claimCandidate(authority: "official" | "third_party") {
  return {
    schemaVersion: "evidence-claim-v1" as const,
    subject: {
      skuId: "sku-universal-board-1",
      familyId: "family-universal-board",
      modelId: "model-universal-board-1",
      variantId: "variant-universal-board-cn",
      revision: "rev-a",
      region: "CN",
    },
    scope: "revision" as const,
    fieldId: "dimensions.width_mm",
    value: 244,
    unit: "mm",
    authority,
    source: {
      documentId: `doc-sha256-${A}` as const,
      documentSha256: A,
      captureId: `capture-sha256-${B}` as const,
      locator: { page: 2, field: "Dimensions" },
    },
    retrievedAt: FIXED_NOW,
    status: "active" as const,
  };
}

export function officialPromotionInput() {
  const identity = {
    brand: "通用硬件厂商",
    skuId: "sku-universal-board-1",
    familyId: "family-universal-board",
    modelId: "model-universal-board-1",
    variantId: "variant-universal-board-cn",
    revision: "rev-a",
    region: "CN",
  };
  const confirmation = createOfficialDocumentIdentityConfirmation({
    authority: "official",
    documentSha256: A,
    pageKind: "manual",
    scope: "revision",
    identity,
    locator: {
      page: 2,
      section: "Product identity",
      excerpt: "model-universal-board-1 variant-universal-board-cn rev-a",
    },
    matchedTokens: {
      model: "model-universal-board-1",
      variant: "variant-universal-board-cn",
      revision: "rev-a",
    },
    extractor: { id: "fixture-extractor", version: "1" },
    confirmedAt: FIXED_NOW,
  });
  return {
    registryTrust: "trusted" as const,
    documentSha256: A,
    requiredScope: "revision" as const,
    expectedIdentity: { kind: "product" as const, ...identity },
    confirmation,
  };
}

export function thirdPartyClosure() {
  const source = createThirdPartyEvidenceSource({
    authority: "third_party",
    sourceType: "professional_measurement",
    canonicalUrl: "https://review.example/universal-board-measurement",
    publisherId: "review-lab-a",
    originalWorkId: "review-lab-a-universal-board-2026",
    independenceGroupId: "review-lab-a",
    editorialControl: "independent",
    fundingDisclosure: "independent",
    subject: {
      skuId: "sku-universal-board-1",
      familyId: "family-universal-board",
      modelId: "model-universal-board-1",
      variantId: "variant-universal-board-cn",
      revision: "rev-a",
      region: "CN",
    },
    objectRevision: "rev-a",
    testMethod: {
      kind: "measurement",
      description: "Caliper measurement of the exact retail revision.",
      sampleSize: 1,
      equipment: ["calibrated digital caliper"],
    },
    sourceContentHash: A,
    retrievedAt: FIXED_NOW,
  });
  return {
    thirdPartySources: [source],
    thirdPartyFindings: [{
      sourceId: source.sourceId,
      fieldId: "dimensions.width_mm",
      normalizedValueHash: "c".repeat(64),
      unit: "mm",
    }],
    assessedAt: FIXED_NOW,
  };
}

async function artifactEffect(context: EvidenceStageEffectContext, label: string): Promise<EvidenceStageEffectResult> {
  const artifact = await context.putArtifact({
    kind: `evidence-${label}`,
    bytes: Buffer.from(`${label}:${context.request.pipelineId}`, "utf8"),
    mediaType: "application/octet-stream",
    privacyClass: "public_source",
  });
  return { status: "completed", output: { [`${label}Ref`]: artifact.ref }, resultRefs: [artifact.ref] };
}

export function evidenceServices(overrides: Partial<EvidencePipelineServices> = {}): EvidencePipelineServices {
  const services: EvidencePipelineServices = {
    officialDiscovery: async () => ({ status: "completed", output: { officialUrl: "https://hardware.example/manual.pdf" } }),
    officialAcquire: (context) => artifactEffect(context, "official-capture"),
    archive: (context) => artifactEffect(context, "archive"),
    parseOrOcr: (context) => artifactEffect(context, "parse-ocr"),
    excerpt: (context) => artifactEffect(context, "excerpt"),
    extractClaims: async () => ({
      status: "completed",
      output: { claimCandidates: [claimCandidate("official")], officialPromotionInput: officialPromotionInput() },
    }),
    thirdPartyFallback: async () => ({
      status: "completed",
      output: { claimCandidates: [claimCandidate("third_party")], ...thirdPartyClosure() },
    }),
    assessFactImpact: async () => ({
      status: "completed",
      output: { affectedFieldIds: ["dimensions.width_mm"], action: "create_update_notice" },
    }),
    generateAdapterCandidate: async () => ({
      status: "completed",
      output: { candidateId: `evidence-adapter-candidate-sha256-${"d".repeat(64)}`, contentHash: "d".repeat(64) },
    }),
    proposeBinding: async (context) => {
      const claim = [...context.priorResults].reverse().find((result) => ["claim_extraction", "third_party_fallback"].includes(result.stage)
        && result.status === "completed" && Array.isArray(result.output.claimCandidateIds));
      const proposal = context.request.planId && claim ? createEvidenceBindingProposalRuntime({
        planId: context.request.planId,
        pipelineId: context.request.pipelineId,
        subject: context.request.subject,
        claimCandidateIds: claim.output.claimCandidateIds as string[],
        adapterCandidateId: `evidence-adapter-candidate-sha256-${"d".repeat(64)}`,
        adapterCandidateHash: "d".repeat(64),
        createdAt: context.attemptStartedAt,
      }) : null;
      if (!proposal) throw new TypeError("fixture binding proposal cannot be derived");
      return { status: "completed", output: proposal as unknown as Readonly<Record<string, unknown>> };
    },
  };
  return { ...services, ...overrides };
}

export async function evidenceRuntime(root: string, options: {
  now?: () => string;
  leaseToken?: () => string;
  leaseDurationMs?: number;
} = {}) {
  const jobs = new FileJobRepository({
    runtimeRoot: root,
    now: options.now ?? (() => FIXED_NOW),
    ...(options.leaseToken === undefined ? {} : { leaseToken: options.leaseToken }),
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
  });
  await jobs.initialize("evidence-jobs-test");
  const repository = new FileArtifactRepository({ coordinator: jobs.coordinator, now: options.now ?? (() => FIXED_NOW) });
  await repository.initialize();
  return { jobs, repository, artifacts: new EvidenceJobArtifactStore(repository) };
}

export function stageService(result: EvidenceStageEffectResult): EvidenceStageService {
  return async () => result;
}

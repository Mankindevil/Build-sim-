import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import type { BuildConfigDocument } from "../config/types";
import { validateRuntimeJobSideEffectFence } from "../jobs/runtime-validation.mjs";
import type { JobLease } from "../jobs";
import type { BuildPlan } from "../plans/contracts";
import { hashPlanConfig } from "../plans/canonical";
import { FilePlanRepository } from "../plans/file-repository";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, readJson, sha256Json } from "../runtime/fs.mjs";
import { EvidenceClaimRepository } from "./claim-repository";
import {
  evidenceIdentityMatchesClaimSubjectRuntime,
} from "./claim-runtime.mjs";
import { createEvidenceClaim } from "./claims";
import type { EvidenceClaim, EvidenceProductIdentity } from "./contracts";
import {
  officialClaimCandidateIdRuntime,
  validateOfficialClaimCandidateEnvelopeRuntime,
  validateOfficialClaimCandidateRuntime,
  type OfficialClaimCandidateRecord,
} from "./claim-candidate-runtime.mjs";
import {
  validateEvidenceStageResult,
  verifyEvidencePipelineRequest,
  type EvidencePipelineRequest,
  type EvidenceStageResult,
} from "./jobs/contracts";
import type { EvidenceJobArtifactFence } from "./jobs/artifact-store";
import {
  evaluateOfficialDocumentPromotion,
  type OfficialDocumentPromotionInput,
} from "./ladder.mjs";
import { createOfficialClaimPromotionRuntime } from "./official-promotion-runtime.mjs";
import {
  assertClaimPromotionApprovalAtRoot,
  type ClaimPromotionAuthorization,
} from "./claim-promotion-approval";
import { FileEvidenceRepository } from "./repository.mjs";

const JOB_ENVELOPE_SCHEMA = "job-store-envelope-v1";
const CANDIDATE_ID = /^claim-candidate-sha256-([a-f0-9]{64})$/;
const ARTIFACT_MEDIA_TYPE = "application/vnd.buildsim.evidence-job+json";

interface CandidateEnvelope {
  readonly schemaVersion: "official-claim-candidate-envelope-v1";
  readonly kind: "official-claim-candidate";
  readonly checksum: string;
  readonly payload: OfficialClaimCandidateRecord;
}

export interface OfficialClaimCandidatePlanAuthority {
  resolveAtRoot(
    activeRoot: string,
    planId: string,
    identity: {
      readonly subject: EvidenceClaim["subject"];
      readonly brand: string;
      readonly category: string;
    },
  ): Promise<{
    readonly plan: BuildPlan<BuildConfigDocument>;
    readonly configHash: string;
    readonly catalogIdentity: { readonly skuId: string; readonly brand: string; readonly category: string; readonly model: string };
  }>;
}

/** Root-bound active-plan authority shared by jobs and Agent approval tools. */
export function createFilePlanClaimCandidateAuthority(options: {
  readonly topologyV3Enabled?: boolean;
} = {}): OfficialClaimCandidatePlanAuthority {
  return Object.freeze({
    async resolveAtRoot(activeRoot: string, planId: string, identity: {
      readonly subject: EvidenceClaim["subject"];
      readonly brand: string;
      readonly category: string;
    }) {
      const { subject } = identity;
      const catalog = loadMergedCatalogSync({ activeRoot, generationAware: true });
      const plans = new FilePlanRepository<BuildConfigDocument>({
        root: confined(activeRoot, "plans"),
        topologyV3Enabled: options.topologyV3Enabled === true,
        getCatalog: () => catalog,
      });
      const plan = await plans.get(planId);
      if (plan.status !== "active") throw new OfficialClaimCandidateRepositoryError("cross_plan", "official claim candidate plan is not active");
      const config = plan.draft.config;
      const skuIds = config.schemaVersion === "3.0.0"
        ? config.components.flatMap((component) => component.identity.status === "resolved" ? [component.identity.skuId] : [])
        : [
          config.caseId, config.boardId, config.cpuId, config.selection.psuId, config.selection.secondaryPsuId,
          config.selection.coolerId, config.selection.gpuId, config.selection.memoryId, config.selection.diskSkuId,
          config.selection.hbaSkuId, ...config.bom.map((line) => line.skuId),
        ].filter((skuId): skuId is string => typeof skuId === "string" && skuId.length > 0);
      if (!skuIds.includes(subject.skuId)) {
        throw new OfficialClaimCandidateRepositoryError("cross_plan", "official claim candidate subject is not owned by the active plan config");
      }
      const sku = catalog.skus.find((candidate: { id: string }) => candidate.id === subject.skuId);
      const catalogFamilyId = sku?.familyId ?? sku?.id;
      const catalogModelId = sku?.modelId ?? sku?.model;
      if (!sku || sku.brand !== identity.brand || sku.category !== identity.category
        || catalogFamilyId !== subject.familyId || catalogModelId !== subject.modelId) {
        throw new OfficialClaimCandidateRepositoryError("cross_plan", "official claim candidate brand/category/model diverges from the active merged catalog");
      }
      const detailKeys = ["variantId", "revision", "region"] as const;
      for (const key of detailKeys) {
        if (subject[key] !== undefined && sku[key] !== undefined && subject[key] !== sku[key]) {
          throw new OfficialClaimCandidateRepositoryError("cross_plan", `official claim candidate ${key} diverges from the active merged catalog`);
        }
      }
      const detailNeedsPlanClaim = detailKeys.some((key) => subject[key] !== undefined && sku[key] === undefined);
      if (detailNeedsPlanClaim) {
        const component = config.schemaVersion === "3.0.0"
          ? config.components.find((candidate) => candidate.identity.status === "resolved" && candidate.identity.skuId === subject.skuId)
          : undefined;
        const identityClaimIds = component?.identity.status === "resolved" ? component.identity.identityClaimIds : [];
        const evidence = new FileEvidenceRepository({ root: confined(activeRoot, "evidence") });
        const claims = new EvidenceClaimRepository({ root: confined(activeRoot, "evidence"), evidence });
        const authorities = await Promise.all(identityClaimIds
          .filter((claimId) => /^claim-sha256-[a-f0-9]{64}$/.test(claimId))
          .map((claimId) => claims.getClaim(claimId).catch(() => null)));
        const exact = authorities.some((claim) => claim?.authority === "official" && claim.status === "active"
          && evidenceIdentityMatchesClaimSubjectRuntime(claim.subject, subject,
            subject.revision !== undefined ? "revision" : subject.variantId !== undefined ? "variant" : "model"));
        if (!exact) {
          throw new OfficialClaimCandidateRepositoryError("cross_plan", "official claim candidate variant/revision lacks an active plan identity-claim closure");
        }
      }
      return {
        plan,
        configHash: await hashPlanConfig(config),
        catalogIdentity: { skuId: sku.id, brand: sku.brand, category: sku.category, model: catalogModelId },
      };
    },
  });
}

export interface OfficialClaimCandidateSink {
  putFromStageResult(
    result: EvidenceStageResult,
    resultArtifactRef: string,
    fence: EvidenceJobArtifactFence,
  ): Promise<readonly OfficialClaimCandidateRecord[]>;
}

export interface OfficialClaimPromotionResult {
  readonly candidate: OfficialClaimCandidateRecord;
  readonly originalCaptureId: string;
  readonly promotedCaptureId: string;
  readonly claim: EvidenceClaim;
}

export class OfficialClaimCandidateRepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input" | "fenced" | "cross_plan",
    message: string,
  ) {
    super(message);
    this.name = "OfficialClaimCandidateRepositoryError";
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }
function parseArtifactJson(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength > 4 * 1024 * 1024) throw new OfficialClaimCandidateRepositoryError("corrupt_data", `${label} is too large`);
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new OfficialClaimCandidateRepositoryError("corrupt_data", `${label} is not valid JSON`); }
}

function exactIdentityFromPromotion(
  promotion: Extract<ReturnType<typeof evaluateOfficialDocumentPromotion>, { eligible: true }>,
  original: EvidenceProductIdentity,
  category: EvidenceProductIdentity["category"],
): EvidenceProductIdentity {
  return {
    brand: promotion.identity.brand,
    basis: "official-document-explicit",
    model: promotion.identity.modelId,
    ...(original.mpn === undefined ? {} : { mpn: original.mpn }),
    ...(category === undefined ? {} : { category }),
    skuId: promotion.identity.skuId,
    familyId: promotion.identity.familyId,
    modelId: promotion.identity.modelId,
    ...(promotion.identity.variantId === undefined ? {} : { variantId: promotion.identity.variantId }),
    ...(promotion.identity.revision === undefined ? {} : { revision: promotion.identity.revision }),
    ...(promotion.identity.region === undefined ? {} : { region: promotion.identity.region }),
  };
}

export class OfficialClaimCandidateRepository implements OfficialClaimCandidateSink {
  constructor(
    private readonly options: {
      readonly coordinator: RuntimeCoordinator;
      readonly runtimeRoot: string;
      readonly planAuthority: OfficialClaimCandidatePlanAuthority;
      readonly now?: () => string;
    },
  ) {
    if (path.resolve(options.runtimeRoot) !== options.coordinator.root) {
      throw new TypeError("official claim candidate runtimeRoot must match RuntimeCoordinator");
    }
  }

  private candidateFile(activeRoot: string, candidateId: string): string {
    const match = CANDIDATE_ID.exec(candidateId);
    if (!match) throw new OfficialClaimCandidateRepositoryError("invalid_input", "official claim candidate ID is invalid");
    return confined(activeRoot, "evidence", "claim-candidates", match[1]!.slice(0, 2), `${candidateId}.json`);
  }

  private async readAt(activeRoot: string, candidateId: string, optional = false): Promise<OfficialClaimCandidateRecord | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.candidateFile(activeRoot, candidateId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return null;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new OfficialClaimCandidateRepositoryError("not_found", "official claim candidate was not found");
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", "official claim candidate cannot be read");
    }
    const errors = validateOfficialClaimCandidateEnvelopeRuntime(parsed, candidateId);
    if (errors.length) throw new OfficialClaimCandidateRepositoryError("corrupt_data", `official claim candidate integrity is invalid: ${errors.join("; ")}`);
    return clone((parsed as CandidateEnvelope).payload);
  }

  private async artifactAt(activeRoot: string, ref: string, kind: string) {
    const artifactsRoot = confined(activeRoot, "artifacts");
    const artifact = await new FileArtifactRepository({ root: artifactsRoot }).getAt(artifactsRoot, ref, { initialize: false });
    if (!artifact || artifact.record.kind !== kind || artifact.record.mediaType !== ARTIFACT_MEDIA_TYPE) {
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", `${kind} artifact authority is missing`);
    }
    return artifact;
  }

  private async requestFromResult(activeRoot: string, result: EvidenceStageResult): Promise<EvidencePipelineRequest> {
    const requestRef = result.inputRefs[0];
    if (!requestRef) throw new OfficialClaimCandidateRepositoryError("corrupt_data", "claim result has no request authority");
    const artifact = await this.artifactAt(activeRoot, requestRef, "evidence-pipeline-request");
    const request = parseArtifactJson(artifact.bytes, "evidence pipeline request");
    if (!await verifyEvidencePipelineRequest(request)) {
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", "evidence pipeline request authority is invalid");
    }
    return request as EvidencePipelineRequest;
  }

  private async assertResultArtifact(activeRoot: string, result: EvidenceStageResult, resultArtifactRef: string): Promise<void> {
    const artifact = await this.artifactAt(activeRoot, resultArtifactRef, "evidence-stage-result");
    const persisted = parseArtifactJson(artifact.bytes, "evidence stage result");
    if (!validateEvidenceStageResult(persisted) || !same(persisted, result)) {
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", "evidence stage result authority is invalid or changed");
    }
  }

  private async assertSourceAtRoot(activeRoot: string, claim: EvidenceClaim) {
    const evidence = new FileEvidenceRepository({ root: confined(activeRoot, "evidence") });
    const document = await evidence.getDocument(claim.source.documentId);
    const capture = await evidence.getCapture(claim.source.captureId);
    if (!document || !capture || document.sha256 !== claim.source.documentSha256 || capture.documentId !== document.id) {
      throw new OfficialClaimCandidateRepositoryError("invalid_input", "claim candidate source document/capture closure is invalid");
    }
    const asserted = capture.productIdentities.find((identity: EvidenceProductIdentity) =>
      identity.basis === "governed-sku-user-asserted"
      && evidenceIdentityMatchesClaimSubjectRuntime(identity, claim.subject, claim.scope));
    if (!asserted) {
      throw new OfficialClaimCandidateRepositoryError("invalid_input", "claim candidate does not originate from the governed user-asserted acquisition capture");
    }
    return { evidence, document, capture, asserted };
  }

  private async assertCandidateArtifactClosure(activeRoot: string, candidate: OfficialClaimCandidateRecord): Promise<EvidencePipelineRequest> {
    await this.assertResultArtifact(activeRoot, await (async () => {
      const artifact = await this.artifactAt(activeRoot, candidate.resultArtifactRef, "evidence-stage-result");
      const parsed = parseArtifactJson(artifact.bytes, "evidence stage result");
      if (!validateEvidenceStageResult(parsed)) throw new OfficialClaimCandidateRepositoryError("corrupt_data", "candidate result artifact is invalid");
      return parsed;
    })(), candidate.resultArtifactRef);
    const resultArtifact = await this.artifactAt(activeRoot, candidate.resultArtifactRef, "evidence-stage-result");
    const result = parseArtifactJson(resultArtifact.bytes, "evidence stage result") as EvidenceStageResult;
    if (result.pipelineId !== candidate.pipelineId || result.jobId !== candidate.jobId || result.stage !== "claim_extraction"
      || result.status !== "completed" || result.completedAt !== candidate.createdAt) {
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", "candidate/result provenance closure is invalid");
    }
    const inputs = (result.output as { claimCandidates?: unknown }).claimCandidates;
    if (!Array.isArray(inputs) || candidate.candidateIndex >= inputs.length) {
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", "candidate index is outside the authoritative result");
    }
    const claim = await createEvidenceClaim(inputs[candidate.candidateIndex] as Parameters<typeof createEvidenceClaim>[0]);
    if (!same(claim, candidate.claim)
      || !same(result.output.officialPromotionInput, candidate.promotionInput)
      || !same(result.output.officialPromotion, candidate.promotion)) {
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", "candidate claim or promotion proof diverges from the authoritative result");
    }
    const ids = result.output.claimCandidateIds;
    if (!Array.isArray(ids) || ids[candidate.candidateIndex] !== candidate.candidateId) {
      throw new OfficialClaimCandidateRepositoryError("corrupt_data", "candidate ID is absent from the authoritative result");
    }
    return this.requestFromResult(activeRoot, result);
  }

  async putFromStageResult(
    result: EvidenceStageResult,
    resultArtifactRef: string,
    fence: EvidenceJobArtifactFence,
  ): Promise<readonly OfficialClaimCandidateRecord[]> {
    if (result.stage !== "claim_extraction" || result.status !== "completed") return [];
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withWrite(async ({ activeRoot, state }: { activeRoot: string; state: { runtimeGeneration: number } }) => {
      const jobEnvelope = await readJson(confined(activeRoot, "jobs", "records", `${fence.jobId}.json`));
      if (state.runtimeGeneration !== fence.runtimeGeneration || result.jobId !== fence.jobId
        || jobEnvelope?.schemaVersion !== JOB_ENVELOPE_SCHEMA || jobEnvelope.kind !== "background-job"
        || jobEnvelope.checksum !== sha256Json(jobEnvelope.payload)
        || validateRuntimeJobSideEffectFence(jobEnvelope.payload, {
          jobId: fence.jobId,
          expectedRevision: fence.expectedRevision,
          leaseToken: fence.leaseToken,
          runtimeGeneration: fence.runtimeGeneration,
        }, (this.options.now ?? (() => new Date().toISOString()))()).length) {
        throw new OfficialClaimCandidateRepositoryError("fenced", "official claim candidate belongs to a stale job lease or runtime generation");
      }
      await this.assertResultArtifact(activeRoot, result, resultArtifactRef);
      const request = await this.requestFromResult(activeRoot, result);
      if (!request.planId) throw new OfficialClaimCandidateRepositoryError("invalid_input", "official claim candidates require a plan-scoped pipeline request");
      const promotionInput = result.output.officialPromotionInput as OfficialDocumentPromotionInput;
      const promotion = evaluateOfficialDocumentPromotion(promotionInput);
      if (!promotion.eligible) throw new OfficialClaimCandidateRepositoryError("invalid_input", "official claim candidate promotion proof is not eligible");
      const inputs = result.output.claimCandidates;
      const ids = result.output.claimCandidateIds;
      if (!Array.isArray(inputs) || !Array.isArray(ids) || inputs.length !== ids.length) {
        throw new OfficialClaimCandidateRepositoryError("invalid_input", "official claim result candidate inventory is invalid");
      }
      const records: OfficialClaimCandidateRecord[] = [];
      for (const [candidateIndex, input] of inputs.entries()) {
        const claim = await createEvidenceClaim(input);
        const planAuthority = await this.options.planAuthority.resolveAtRoot(activeRoot, request.planId, {
          subject: claim.subject,
          brand: promotion.identity.brand,
          category: request.subject.category,
        });
        await this.assertSourceAtRoot(activeRoot, claim);
        const candidateId = officialClaimCandidateIdRuntime({
          planId: request.planId,
          pipelineId: request.pipelineId,
          candidateIndex,
          claimId: claim.claimId,
          confirmationId: promotion.confirmationId,
        });
        if (!candidateId || ids[candidateIndex] !== candidateId) {
          throw new OfficialClaimCandidateRepositoryError("invalid_input", "official claim result candidate ID binding is invalid");
        }
        const material = {
          schemaVersion: "official-claim-candidate-v1" as const,
          candidateId,
          planId: request.planId,
          planConfigHash: planAuthority.configHash,
          planDraftRevision: planAuthority.plan.draftRevision,
          catalogIdentity: clone(planAuthority.catalogIdentity),
          pipelineId: request.pipelineId,
          jobId: result.jobId,
          runtimeGeneration: fence.runtimeGeneration,
          resultArtifactRef,
          candidateIndex,
          claim,
          promotionInput: clone(promotionInput),
          promotion: clone(promotion),
          originalCaptureId: claim.source.captureId,
          createdAt: result.completedAt,
        };
        const record: OfficialClaimCandidateRecord = { ...material, contentHash: sha256Json(material) };
        const errors = validateOfficialClaimCandidateRuntime(record);
        if (errors.length) throw new OfficialClaimCandidateRepositoryError("invalid_input", errors.join("; "));
        const existing = await this.readAt(activeRoot, candidateId, true);
        if (existing) {
          if (!same(existing, record)) throw new OfficialClaimCandidateRepositoryError("conflict", "immutable official claim candidate ID collision");
          records.push(existing); continue;
        }
        const envelope: CandidateEnvelope = {
          schemaVersion: "official-claim-candidate-envelope-v1",
          kind: "official-claim-candidate",
          checksum: sha256Json(record),
          payload: record,
        };
        await atomicWriteJson(this.candidateFile(activeRoot, candidateId), envelope);
        records.push(clone(record));
      }
      return Object.freeze(records);
    })).result;
  }

  async get(candidateId: string): Promise<OfficialClaimCandidateRecord | null> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) =>
      this.readAt(activeRoot, candidateId, true))).result;
  }

  async promoteOfficial(
    candidateId: string,
    planId: string,
    authorization?: ClaimPromotionAuthorization,
  ): Promise<OfficialClaimPromotionResult> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const candidate = await this.readAt(activeRoot, candidateId);
      if (!candidate) throw new OfficialClaimCandidateRepositoryError("not_found", "official claim candidate was not found");
      if (candidate.planId !== planId) throw new OfficialClaimCandidateRepositoryError("cross_plan", "official claim candidate belongs to another plan");
      // runtimeGeneration is immutable production provenance, not a live
      // lease. A restored succeeded-stage candidate may be approved in the
      // new generation only after every plan/artifact/source closure below is
      // re-read from that generation. Stale workers remain fenced on put.
      const request = await this.assertCandidateArtifactClosure(activeRoot, candidate);
      if (request.planId !== planId || !same(request.subject, {
        brand: candidate.promotion.identity.brand,
        category: request.subject.category,
        skuId: candidate.claim.subject.skuId,
        familyId: candidate.claim.subject.familyId,
        ...(candidate.claim.subject.modelId === undefined ? {} : { modelId: candidate.claim.subject.modelId }),
        ...(candidate.claim.subject.variantId === undefined ? {} : { variantId: candidate.claim.subject.variantId }),
        ...(candidate.claim.subject.revision === undefined ? {} : { revision: candidate.claim.subject.revision }),
        ...(candidate.claim.subject.region === undefined ? {} : { region: candidate.claim.subject.region }),
      })) throw new OfficialClaimCandidateRepositoryError("cross_plan", "candidate request subject no longer closes to its plan authority");
      const planAuthority = await this.options.planAuthority.resolveAtRoot(activeRoot, planId, {
        subject: candidate.claim.subject,
        brand: candidate.promotion.identity.brand,
        category: request.subject.category,
      });
      if (!same(planAuthority.catalogIdentity, candidate.catalogIdentity)) {
        throw new OfficialClaimCandidateRepositoryError("cross_plan", "candidate active catalog identity changed before approval");
      }
      if (planAuthority.configHash !== candidate.planConfigHash
        || planAuthority.plan.draftRevision !== candidate.planDraftRevision) {
        throw new OfficialClaimCandidateRepositoryError("cross_plan", "candidate active plan draft changed before approval");
      }
      const approval = await assertClaimPromotionApprovalAtRoot({
        activeRoot,
        authorization,
        kind: "official",
        candidateId,
        planId,
        planConfigHash: candidate.planConfigHash,
        planDraftRevision: candidate.planDraftRevision,
      }).catch((error: unknown) => {
        throw new OfficialClaimCandidateRepositoryError(
          "invalid_input",
          error instanceof Error ? error.message : "official claim promotion approval is invalid",
        );
      });
      const source = await this.assertSourceAtRoot(activeRoot, candidate.claim);
      const content = await source.evidence.getDocumentContent(source.document.id);
      if (!content) throw new OfficialClaimCandidateRepositoryError("corrupt_data", "official candidate document bytes are unavailable");
      const promotedIdentity = exactIdentityFromPromotion(candidate.promotion, source.asserted,
        candidate.catalogIdentity.category as EvidenceProductIdentity["category"]);
      const identities = source.capture.productIdentities.map((identity: EvidenceProductIdentity) =>
        identity === source.asserted ? promotedIdentity : clone(identity));
      const imported = await source.evidence.importBuffer(content.bytes, {
        kind: source.capture.kind,
        mediaType: source.document.mediaType,
        title: source.capture.title,
        productIdentities: identities,
        createdAt: source.document.createdAt,
        capture: {
          acquisitionMethod: source.capture.acquisitionMethod,
          kindBasis: "content-verified",
          requestedUrl: source.capture.requestedUrl,
          finalUrl: source.capture.finalUrl,
          canonicalUrl: source.capture.canonicalUrl,
          retrievedAt: source.capture.retrievedAt,
          status: source.capture.status,
          redirects: source.capture.redirects,
          ...(source.capture.etag === undefined ? {} : { etag: source.capture.etag }),
          ...(source.capture.lastModified === undefined ? {} : { lastModified: source.capture.lastModified }),
          officialBrand: source.capture.officialBrand,
        },
      });
      if (imported.capture.id === source.capture.id) {
        throw new OfficialClaimCandidateRepositoryError("corrupt_data", "official promotion did not create an explicit immutable capture");
      }
      const claim = await createEvidenceClaim({
        ...clone(candidate.claim),
        source: { ...clone(candidate.claim.source), captureId: imported.capture.id },
      });
      const officialPromotion = createOfficialClaimPromotionRuntime({
        schemaVersion: "official-claim-promotion-v1",
        candidateId: candidate.candidateId,
        candidateHash: candidate.contentHash,
        planId,
        confirmationId: candidate.promotionInput.confirmation.confirmationId,
        confirmationHash: candidate.promotionInput.confirmation.contentHash,
        originalCaptureId: source.capture.id,
        promotedCaptureId: imported.capture.id,
        activeClaimId: claim.claimId,
        activeClaimHash: claim.contentHash,
        approval,
        promotedAt: approval.issuedAt,
      });
      if (!officialPromotion) throw new OfficialClaimCandidateRepositoryError("corrupt_data", "official claim promotion authority cannot be derived");
      const claims = new EvidenceClaimRepository({
        root: confined(activeRoot, "evidence"),
        evidence: source.evidence,
      });
      const persisted = await claims.putOfficialPromotedClaimAtRoot(
        activeRoot,
        claim,
        officialPromotion,
        authorization!,
      );
      return Object.freeze({
        candidate: clone(candidate),
        originalCaptureId: source.capture.id,
        promotedCaptureId: imported.capture.id,
        claim: clone(persisted),
      });
    })).result;
  }
}

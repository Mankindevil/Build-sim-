import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { validateRuntimeJobSideEffectFence } from "../jobs/runtime-validation.mjs";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, readJson, sha256Json } from "../runtime/fs.mjs";
import {
  createFilePlanClaimCandidateAuthority,
  type OfficialClaimCandidatePlanAuthority,
} from "./claim-candidate-repository";
import { EvidenceClaimRepository } from "./claim-repository";
import { evidenceIdentityMatchesClaimSubjectRuntime } from "./claim-runtime.mjs";
import { createEvidenceClaim } from "./claims";
import type { EvidenceClaim, EvidenceProductCategory, EvidenceProductIdentity } from "./contracts";
import type { EvidenceJobArtifactFence } from "./jobs/artifact-store";
import {
  validateEvidenceStageResult,
  verifyEvidencePipelineRequest,
  type EvidencePipelineRequest,
  type EvidenceStageResult,
} from "./jobs/contracts";
import {
  assessThirdPartySourceIndependence,
  validateThirdPartyEvidenceSource,
  type ThirdPartyEvidenceFinding,
  type ThirdPartyEvidenceSource,
  type ThirdPartyIndependenceAssessment,
} from "./ladder.mjs";
import { FileEvidenceRepository } from "./repository.mjs";
import {
  thirdPartyClaimCandidateIdRuntime,
  validateThirdPartyClaimCandidateEnvelopeRuntime,
  validateThirdPartyClaimCandidateRuntime,
  type ThirdPartyClaimCandidateRecord,
} from "./third-party-claim-candidate-runtime.mjs";
import {
  createThirdPartyClaimPromotionRuntime,
  type ThirdPartyClaimPromotionRecord,
} from "./third-party-promotion-runtime.mjs";
import {
  assertClaimPromotionApprovalAtRoot,
  type ClaimPromotionAuthorization,
} from "./claim-promotion-approval";

const JOB_ENVELOPE_SCHEMA = "job-store-envelope-v1";
const CANDIDATE_ID = /^third-party-claim-candidate-sha256-([a-f0-9]{64})$/;
const ARTIFACT_MEDIA_TYPE = "application/vnd.buildsim.evidence-job+json";

interface CandidateEnvelope {
  readonly schemaVersion: "third-party-claim-candidate-envelope-v1";
  readonly kind: "third-party-claim-candidate";
  readonly checksum: string;
  readonly payload: ThirdPartyClaimCandidateRecord;
}

export interface ThirdPartyClaimCandidateSink {
  putFromStageResult(
    result: EvidenceStageResult,
    resultArtifactRef: string,
    fence: EvidenceJobArtifactFence,
  ): Promise<readonly ThirdPartyClaimCandidateRecord[]>;
}

export interface ThirdPartyClaimActivationResult {
  readonly candidate: ThirdPartyClaimCandidateRecord;
  readonly originalCaptureId: string;
  readonly promotedCaptureId: string;
  readonly claim: EvidenceClaim;
  readonly promotion: ThirdPartyClaimPromotionRecord;
}

export class ThirdPartyClaimCandidateRepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input" | "fenced" | "cross_plan",
    message: string,
  ) {
    super(message);
    this.name = "ThirdPartyClaimCandidateRepositoryError";
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }
function parseArtifactJson(bytes: Uint8Array, label: string): unknown {
  if (bytes.byteLength > 4 * 1024 * 1024) throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", `${label} is too large`);
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", `${label} is not valid JSON`); }
}

function sourceForClaim(
  sources: readonly ThirdPartyEvidenceSource[],
  claim: EvidenceClaim,
): ThirdPartyEvidenceSource {
  const matches = sources.filter((source) => source.sourceContentHash === claim.source.documentSha256
    && evidenceIdentityMatchesClaimSubjectRuntime(source.subject, claim.subject, claim.scope));
  if (matches.length !== 1) {
    throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party claim must close to exactly one governed source");
  }
  return matches[0]!;
}

function explicitThirdPartyIdentity(
  original: EvidenceProductIdentity,
  candidate: ThirdPartyClaimCandidateRecord,
): EvidenceProductIdentity {
  const subject = candidate.claim.subject;
  return {
    brand: candidate.catalogIdentity.brand,
    basis: "third-party-document-explicit",
    model: candidate.catalogIdentity.model,
    ...(original.mpn === undefined ? {} : { mpn: original.mpn }),
    category: candidate.catalogIdentity.category as EvidenceProductCategory,
    skuId: subject.skuId,
    familyId: subject.familyId,
    ...(subject.modelId === undefined ? {} : { modelId: subject.modelId }),
    ...(subject.variantId === undefined ? {} : { variantId: subject.variantId }),
    ...(subject.revision === undefined ? {} : { revision: subject.revision }),
    ...(subject.region === undefined ? {} : { region: subject.region }),
  };
}

/**
 * Immutable, job-fenced authority for plan-scoped third-party claim candidates.
 * Approval creates a new explicit third-party capture; it can never manufacture
 * official authority or mutate the original acquisition capture.
 */
export class ThirdPartyClaimCandidateRepository implements ThirdPartyClaimCandidateSink {
  private readonly planAuthority: OfficialClaimCandidatePlanAuthority;

  constructor(private readonly options: {
    readonly coordinator: RuntimeCoordinator;
    readonly runtimeRoot: string;
    readonly planAuthority?: OfficialClaimCandidatePlanAuthority;
    readonly topologyV3Enabled?: boolean;
    readonly now?: () => string;
    /** Constructor-only deterministic crash seam used to prove recovery. */
    readonly faultInjector?: (point: "after_capture" | "after_promotion" | "after_claim") => void | Promise<void>;
  }) {
    if (path.resolve(options.runtimeRoot) !== options.coordinator.root) {
      throw new TypeError("third-party claim candidate runtimeRoot must match RuntimeCoordinator");
    }
    this.planAuthority = options.planAuthority ?? createFilePlanClaimCandidateAuthority({
      ...(options.topologyV3Enabled === undefined ? {} : { topologyV3Enabled: options.topologyV3Enabled }),
    });
  }

  private candidateFile(activeRoot: string, candidateId: string): string {
    const match = CANDIDATE_ID.exec(candidateId);
    if (!match) throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party claim candidate ID is invalid");
    return confined(activeRoot, "evidence", "third-party-claim-candidates", match[1]!.slice(0, 2), `${candidateId}.json`);
  }

  private async readAt(activeRoot: string, candidateId: string, optional = false): Promise<ThirdPartyClaimCandidateRecord | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.candidateFile(activeRoot, candidateId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return null;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ThirdPartyClaimCandidateRepositoryError("not_found", "third-party claim candidate was not found");
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party claim candidate cannot be read");
    }
    const errors = validateThirdPartyClaimCandidateEnvelopeRuntime(parsed, candidateId);
    if (errors.length) throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", `third-party claim candidate integrity is invalid: ${errors.join("; ")}`);
    return clone((parsed as CandidateEnvelope).payload);
  }

  private async artifactAt(activeRoot: string, ref: string, kind: string) {
    const artifactsRoot = confined(activeRoot, "artifacts");
    const artifact = await new FileArtifactRepository({ root: artifactsRoot }).getAt(artifactsRoot, ref, { initialize: false });
    if (!artifact || artifact.record.kind !== kind || artifact.record.mediaType !== ARTIFACT_MEDIA_TYPE) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", `${kind} artifact authority is missing`);
    }
    return artifact;
  }

  private async resultAt(activeRoot: string, ref: string): Promise<EvidenceStageResult> {
    const artifact = await this.artifactAt(activeRoot, ref, "evidence-stage-result");
    const result = parseArtifactJson(artifact.bytes, "evidence stage result");
    if (!validateEvidenceStageResult(result)) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party candidate result artifact is invalid");
    }
    return result;
  }

  private async requestFromResult(activeRoot: string, result: EvidenceStageResult): Promise<EvidencePipelineRequest> {
    const requestRef = result.inputRefs[0];
    if (!requestRef) throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party result has no request authority");
    const artifact = await this.artifactAt(activeRoot, requestRef, "evidence-pipeline-request");
    const request = parseArtifactJson(artifact.bytes, "evidence pipeline request");
    if (!await verifyEvidencePipelineRequest(request)) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "evidence pipeline request authority is invalid");
    }
    return request as EvidencePipelineRequest;
  }

  private proofFromResult(result: EvidenceStageResult): {
    readonly claims: readonly EvidenceClaim[];
    readonly sources: readonly ThirdPartyEvidenceSource[];
    readonly assessment: ThirdPartyIndependenceAssessment;
  } {
    const inputs = result.output.claimCandidates;
    const sources = result.output.thirdPartySources;
    const findings = result.output.thirdPartyFindings;
    const persistedAssessment = result.output.independenceAssessment;
    if (!Array.isArray(inputs) || !Array.isArray(sources) || !Array.isArray(findings)
      || sources.some((source) => validateThirdPartyEvidenceSource(source).length)) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party result proof inventory is invalid");
    }
    const assessment = assessThirdPartySourceIndependence(sources as readonly ThirdPartyEvidenceSource[], {
      findings: findings as readonly ThirdPartyEvidenceFinding[],
      assessedAt: String(result.output.assessedAt ?? result.completedAt),
    });
    if (!same(assessment, persistedAssessment) || assessment.conflicted || assessment.confidence === "none" || assessment.ladderLevel === null) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party independence assessment is invalid or changed");
    }
    return {
      claims: inputs as unknown as readonly EvidenceClaim[],
      sources: sources as readonly ThirdPartyEvidenceSource[],
      assessment,
    };
  }

  private async assertSourceAtRoot(activeRoot: string, claim: EvidenceClaim, source: ThirdPartyEvidenceSource) {
    const evidence = new FileEvidenceRepository({ root: confined(activeRoot, "evidence") });
    const document = await evidence.getDocument(claim.source.documentId);
    const capture = await evidence.getCapture(claim.source.captureId);
    if (!document || !capture || document.sha256 !== claim.source.documentSha256 || capture.documentId !== document.id
      || source.sourceContentHash !== document.sha256 || capture.acquisitionMethod !== "third-party-fetch"
      || capture.canonicalUrl !== source.canonicalUrl) {
      throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party candidate source document/capture closure is invalid");
    }
    const asserted = capture.productIdentities.find((identity: EvidenceProductIdentity) =>
      identity.basis === "governed-sku-user-asserted"
      && evidenceIdentityMatchesClaimSubjectRuntime(identity, claim.subject, claim.scope));
    if (!asserted) {
      throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party candidate lacks its original user-asserted capture identity");
    }
    return { evidence, document, capture, asserted };
  }

  private async assertCandidateClosure(activeRoot: string, candidate: ThirdPartyClaimCandidateRecord): Promise<EvidencePipelineRequest> {
    const result = await this.resultAt(activeRoot, candidate.resultArtifactRef);
    if (result.pipelineId !== candidate.pipelineId || result.jobId !== candidate.jobId || result.stage !== "third_party_fallback"
      || result.status !== "completed" || result.completedAt !== candidate.createdAt) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party candidate/result provenance closure is invalid");
    }
    const proof = this.proofFromResult(result);
    if (candidate.candidateIndex >= proof.claims.length) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party candidate index is outside the authoritative result");
    }
    const claim = await createEvidenceClaim(proof.claims[candidate.candidateIndex] as Parameters<typeof createEvidenceClaim>[0]);
    const source = sourceForClaim(proof.sources, claim);
    const ids = result.output.claimCandidateIds;
    if (!Array.isArray(ids) || ids[candidate.candidateIndex] !== candidate.candidateId
      || !same(claim, candidate.claim) || !same(source, candidate.source) || !same(proof.assessment, candidate.assessment)) {
      throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party candidate proof diverges from the authoritative result");
    }
    return this.requestFromResult(activeRoot, result);
  }

  async putFromStageResult(
    result: EvidenceStageResult,
    resultArtifactRef: string,
    fence: EvidenceJobArtifactFence,
  ): Promise<readonly ThirdPartyClaimCandidateRecord[]> {
    if (result.stage !== "third_party_fallback" || result.status !== "completed") return [];
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
        throw new ThirdPartyClaimCandidateRepositoryError("fenced", "third-party claim candidate belongs to a stale job lease or runtime generation");
      }
      const persisted = await this.resultAt(activeRoot, resultArtifactRef);
      if (!same(persisted, result)) throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party result artifact changed");
      const request = await this.requestFromResult(activeRoot, result);
      if (!request.planId) throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party claim candidates require a plan-scoped request");
      const proof = this.proofFromResult(result);
      const ids = result.output.claimCandidateIds;
      if (!Array.isArray(ids) || proof.claims.length !== ids.length) {
        throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party claim result candidate inventory is invalid");
      }
      const records: ThirdPartyClaimCandidateRecord[] = [];
      for (const [candidateIndex, input] of proof.claims.entries()) {
        const claim = await createEvidenceClaim(input as Parameters<typeof createEvidenceClaim>[0]);
        if (claim.authority !== "third_party" || claim.status !== "active") {
          throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party candidate claim authority is invalid");
        }
        const source = sourceForClaim(proof.sources, claim);
        const planAuthority = await this.planAuthority.resolveAtRoot(activeRoot, request.planId, {
          subject: claim.subject,
          brand: request.subject.brand,
          category: request.subject.category,
        });
        await this.assertSourceAtRoot(activeRoot, claim, source);
        const candidateId = thirdPartyClaimCandidateIdRuntime({
          planId: request.planId,
          pipelineId: request.pipelineId,
          candidateIndex,
          claimId: claim.claimId,
          sourceId: source.sourceId,
          assessmentId: proof.assessment.assessmentId,
        });
        if (!candidateId || ids[candidateIndex] !== candidateId) {
          throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", "third-party claim candidate ID binding is invalid");
        }
        const material = {
          schemaVersion: "third-party-claim-candidate-v1" as const,
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
          source: clone(source),
          assessment: clone(proof.assessment),
          originalCaptureId: claim.source.captureId,
          createdAt: result.completedAt,
        };
        const record: ThirdPartyClaimCandidateRecord = { ...material, contentHash: sha256Json(material) };
        const errors = validateThirdPartyClaimCandidateRuntime(record);
        if (errors.length) throw new ThirdPartyClaimCandidateRepositoryError("invalid_input", errors.join("; "));
        const existing = await this.readAt(activeRoot, candidateId, true);
        if (existing) {
          if (!same(existing, record)) throw new ThirdPartyClaimCandidateRepositoryError("conflict", "immutable third-party candidate ID collision");
          records.push(existing);
          continue;
        }
        const envelope: CandidateEnvelope = {
          schemaVersion: "third-party-claim-candidate-envelope-v1",
          kind: "third-party-claim-candidate",
          checksum: sha256Json(record),
          payload: record,
        };
        await atomicWriteJson(this.candidateFile(activeRoot, candidateId), envelope);
        records.push(clone(record));
      }
      return Object.freeze(records);
    })).result;
  }

  async get(candidateId: string): Promise<ThirdPartyClaimCandidateRecord | null> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) =>
      this.readAt(activeRoot, candidateId, true))).result;
  }

  async activateThirdParty(
    candidateId: string,
    planId: string,
    authorization?: ClaimPromotionAuthorization,
  ): Promise<ThirdPartyClaimActivationResult> {
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const candidate = await this.readAt(activeRoot, candidateId);
      if (!candidate) throw new ThirdPartyClaimCandidateRepositoryError("not_found", "third-party claim candidate was not found");
      if (candidate.planId !== planId) throw new ThirdPartyClaimCandidateRepositoryError("cross_plan", "third-party claim candidate belongs to another plan");
      const request = await this.assertCandidateClosure(activeRoot, candidate);
      const expectedRequestSubject = {
        brand: candidate.catalogIdentity.brand,
        category: candidate.catalogIdentity.category,
        skuId: candidate.claim.subject.skuId,
        familyId: candidate.claim.subject.familyId,
        ...(candidate.claim.subject.modelId === undefined ? {} : { modelId: candidate.claim.subject.modelId }),
        ...(candidate.claim.subject.variantId === undefined ? {} : { variantId: candidate.claim.subject.variantId }),
        ...(candidate.claim.subject.revision === undefined ? {} : { revision: candidate.claim.subject.revision }),
        ...(candidate.claim.subject.region === undefined ? {} : { region: candidate.claim.subject.region }),
      };
      if (request.planId !== planId || !same(request.subject, expectedRequestSubject)) {
        throw new ThirdPartyClaimCandidateRepositoryError("cross_plan", "third-party candidate request no longer closes to its plan authority");
      }
      const planAuthority = await this.planAuthority.resolveAtRoot(activeRoot, planId, {
        subject: candidate.claim.subject,
        brand: candidate.catalogIdentity.brand,
        category: candidate.catalogIdentity.category,
      });
      if (!same(planAuthority.catalogIdentity, candidate.catalogIdentity)) {
        throw new ThirdPartyClaimCandidateRepositoryError("cross_plan", "third-party candidate active catalog identity changed before approval");
      }
      if (planAuthority.configHash !== candidate.planConfigHash
        || planAuthority.plan.draftRevision !== candidate.planDraftRevision) {
        throw new ThirdPartyClaimCandidateRepositoryError("cross_plan", "third-party candidate active plan draft changed before approval");
      }
      const approval = await assertClaimPromotionApprovalAtRoot({
        activeRoot,
        authorization,
        kind: "third_party",
        candidateId,
        planId,
        planConfigHash: candidate.planConfigHash,
        planDraftRevision: candidate.planDraftRevision,
      }).catch((error: unknown) => {
        throw new ThirdPartyClaimCandidateRepositoryError(
          "invalid_input",
          error instanceof Error ? error.message : "third-party claim promotion approval is invalid",
        );
      });
      const source = await this.assertSourceAtRoot(activeRoot, candidate.claim, candidate.source);
      const content = await source.evidence.getDocumentContent(source.document.id);
      if (!content) throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party candidate document bytes are unavailable");
      const explicit = explicitThirdPartyIdentity(source.asserted, candidate);
      const identities = source.capture.productIdentities.map((identity: EvidenceProductIdentity) =>
        identity === source.asserted ? explicit : clone(identity));
      const imported = await source.evidence.importBuffer(content.bytes, {
        kind: source.capture.kind,
        mediaType: source.document.mediaType,
        title: source.capture.title,
        productIdentities: identities,
        createdAt: source.document.createdAt,
        capture: {
          acquisitionMethod: "third-party-fetch",
          kindBasis: "content-verified",
          requestedUrl: source.capture.requestedUrl,
          finalUrl: source.capture.finalUrl,
          canonicalUrl: source.capture.canonicalUrl,
          retrievedAt: source.capture.retrievedAt,
          status: source.capture.status,
          redirects: source.capture.redirects,
          ...(source.capture.etag === undefined ? {} : { etag: source.capture.etag }),
          ...(source.capture.lastModified === undefined ? {} : { lastModified: source.capture.lastModified }),
          officialBrand: candidate.catalogIdentity.brand,
        },
      });
      if (imported.capture.id === source.capture.id) {
        throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party approval did not create an explicit immutable capture");
      }
      const claim = await createEvidenceClaim({
        ...clone(candidate.claim),
        authority: "third_party",
        source: { ...clone(candidate.claim.source), captureId: imported.capture.id },
      });
      await this.options.faultInjector?.("after_capture");
      const promotion = createThirdPartyClaimPromotionRuntime({
        schemaVersion: "third-party-claim-promotion-v1",
        candidateId: candidate.candidateId,
        candidateHash: candidate.contentHash,
        planId,
        assessmentId: candidate.assessment.assessmentId,
        assessmentHash: candidate.assessment.contentHash,
        originalCaptureId: source.capture.id,
        promotedCaptureId: imported.capture.id,
        activeClaimId: claim.claimId,
        activeClaimHash: claim.contentHash,
        approval,
        promotedAt: approval.issuedAt,
      });
      if (!promotion) throw new ThirdPartyClaimCandidateRepositoryError("corrupt_data", "third-party claim promotion authority cannot be derived");
      // Promotion material is not a separately visible authority: it is
      // committed atomically inside the claim envelope below. Thus a crash at
      // this seam leaves only an orphan content-addressed capture, never an
      // active claim or a dangling promotion record.
      await this.options.faultInjector?.("after_promotion");
      const claims = new EvidenceClaimRepository({ root: confined(activeRoot, "evidence"), evidence: source.evidence });
      const persisted = await claims.putThirdPartyPromotedClaimAtRoot(
        activeRoot,
        claim,
        promotion,
        authorization!,
      );
      await this.options.faultInjector?.("after_claim");
      return Object.freeze({
        candidate: clone(candidate),
        originalCaptureId: source.capture.id,
        promotedCaptureId: imported.capture.id,
        claim: clone(persisted),
        promotion: clone(promotion),
      });
    })).result;
  }
}

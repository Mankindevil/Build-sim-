import { createHash } from "node:crypto";
import { stableAgentJson } from "../agent/evaluation-contract";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import type { EvidenceClaim } from "../evidence/contracts";
import type { EvidenceClaimRepository } from "../evidence/claim-repository";
import type { FileEvidenceRepository } from "../evidence/repository.mjs";
import {
  evidenceStageCommitHash,
  validateEvidenceStageAttempt,
  validateEvidenceStageResult,
  verifyEvidencePipelineRequest,
  type EvidencePipelineRequest,
  type EvidencePipelineSubject,
  type EvidenceStageAttemptCheckpoint,
  type EvidenceStageResult,
} from "../evidence/jobs/contracts";
import type { FactRecord } from "../facts/contracts";
import type { FactRepository } from "../facts/repository";
import { createFactSnapshot } from "../facts/snapshots";
import type { FileJobRepository } from "../jobs/repository";
import { hashPlanConfig } from "../plans/canonical";
import type { FilePlanRepository } from "../plans/file-repository";
import { confined } from "../runtime/fs.mjs";
import type { BuildConfigV3, ComponentInstance } from "../topology/contracts";
import {
  provisionalCaseAdapterPlanAuthorityArtifact,
  type CaseAdapterEvidenceSourceClosure,
  type ResolvedProvisionalCaseAdapterContext,
  type ResolveProvisionalCaseAdapterContextRequest,
  type RootBoundProvisionalCaseAdapterAuthority,
} from "./provisional";
import {
  loadCurrentRuntimeCaseAdapterManifestsAtRoot,
  loadRuntimeCaseAdapterRegistrySnapshotAtRoot,
} from "./runtime-registry-repository";

const ATTEMPT_MEDIA_TYPE = "application/vnd.buildsim.evidence-job+json";
const FULL_IDENTITY_KEYS = ["brand", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"] as const;

export class ProvisionalCaseAdapterProductionAuthorityError extends Error {
  constructor(
    readonly code: "case_component_not_unique" | "exact_identity_unavailable" | "governed_fact_closure_unavailable" | "generation_attempt_not_unique",
    message: string,
  ) {
    super(message);
    this.name = "ProvisionalCaseAdapterProductionAuthorityError";
  }
}

interface CatalogSku {
  id: string;
  brand: string;
  category: string;
  model?: string;
  familyId?: string;
  modelId?: string;
  variantId?: string;
  revision?: string;
  region?: string;
}

interface ProductionCaseAdapterAuthorityOptions {
  plans: Pick<FilePlanRepository<BuildConfigV3>, "getAtRoot">;
  facts: Pick<FactRepository, "listCurrentFactsAtRoot">;
  claims: Pick<EvidenceClaimRepository, "getClaimAtRoot">;
  evidence: Pick<FileEvidenceRepository, "atActiveRoot">;
  jobs: Pick<FileJobRepository, "listAtRoot">;
  catalogAtRoot(activeRoot: string): { skus: CatalogSku[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function fullSubject(value: unknown): value is EvidencePipelineSubject & {
  modelId: string; variantId: string; revision: string; region: string;
} {
  if (!record(value) || !exactKeys(value, FULL_IDENTITY_KEYS)) return false;
  return value.category === "case" && FULL_IDENTITY_KEYS.filter((key) => key !== "category")
    .every((key) => typeof value[key] === "string" && Boolean(value[key]) && value[key] === (value[key] as string).normalize("NFC"));
}

function exactClaimSubject(value: unknown): value is EvidenceClaim["subject"] & {
  modelId: string; variantId: string; revision: string; region: string;
} {
  return record(value) && exactKeys(value, ["skuId", "familyId", "modelId", "variantId", "revision", "region"])
    && [value.skuId, value.familyId, value.modelId, value.variantId, value.revision, value.region]
      .every((item) => typeof item === "string" && Boolean(item) && item === item.normalize("NFC"));
}

function sameSubject(left: EvidencePipelineSubject, right: EvidencePipelineSubject): boolean {
  return FULL_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function claimSubjectMatches(claim: EvidenceClaim, subject: EvidencePipelineSubject): boolean {
  return claim.subject.skuId === subject.skuId && claim.subject.familyId === subject.familyId
    && claim.subject.modelId === subject.modelId && claim.subject.variantId === subject.variantId
    && claim.subject.revision === subject.revision && claim.subject.region === subject.region;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function caseComponents(config: BuildConfigV3): ComponentInstance[] {
  return config.components.filter((component) => component.kind === "case" && component.identity.status === "resolved");
}

function factMatchesSubject(fact: FactRecord, subject: EvidencePipelineSubject): boolean {
  return fact.subject.kind === "product" && fact.subject.skuId === subject.skuId
    && fact.subject.revision === subject.revision && fact.subject.region === subject.region
    && fact.scope === "revision" && fact.status === "active"
    && (fact.authority === "official" || fact.authority === "third_party");
}

function boundedPageText(source: string, snippets: readonly string[]): string {
  const windows = snippets.map((snippet) => {
    const offset = source.indexOf(snippet);
    if (offset < 0) throw new ProvisionalCaseAdapterProductionAuthorityError(
      "governed_fact_closure_unavailable",
      "governed claim locator does not resolve in the immutable source bytes",
    );
    const start = Math.max(0, offset - 1_024);
    const end = Math.min(source.length, offset + snippet.length + 1_024);
    return source.slice(start, end);
  });
  const text = [...new Set(windows)].join("\n…\n");
  if (!text || Buffer.byteLength(text, "utf8") > 256 * 1024) {
    throw new ProvisionalCaseAdapterProductionAuthorityError(
      "governed_fact_closure_unavailable",
      "governed claim locator projection exceeds the bounded replay limit",
    );
  }
  return text;
}

/**
 * Filesystem-backed production authority for the U5 generation/approval path.
 * Transport supplies only plan/component lookup keys; all identity, facts,
 * evidence bytes, generation attempt and registry CAS state are re-resolved at
 * one active root.
 */
export class FileRootBoundProvisionalCaseAdapterAuthority implements RootBoundProvisionalCaseAdapterAuthority {
  readonly authorityKind = "case-adapter-generation-root-bound-v1" as const;

  constructor(private readonly options: ProductionCaseAdapterAuthorityOptions) {}

  private async identityForComponentAtRoot(
    activeRoot: string,
    component: ComponentInstance,
  ): Promise<EvidencePipelineSubject & { modelId: string; variantId: string; revision: string; region: string }> {
    if (component.identity.status !== "resolved") {
      throw new ProvisionalCaseAdapterProductionAuthorityError("exact_identity_unavailable", "case component identity is unresolved");
    }
    const componentIdentity = component.identity;
    const catalog = this.options.catalogAtRoot(activeRoot);
    const sku = catalog.skus.find((candidate) => candidate.id === componentIdentity.skuId);
    if (!sku || sku.category !== "case") {
      throw new ProvisionalCaseAdapterProductionAuthorityError("exact_identity_unavailable", "case identity is absent from the active merged catalog");
    }
    const identityClaims = (await Promise.all(componentIdentity.identityClaimIds
      .filter((claimId) => /^claim-sha256-[a-f0-9]{64}$/.test(claimId))
      .map((claimId) => this.options.claims.getClaimAtRoot(activeRoot, claimId))))
      .filter((claim): claim is EvidenceClaim => claim !== null && claim.status === "active" && claim.authority === "official"
        && claim.scope === "revision" && exactClaimSubject(claim.subject) && claim.subject.skuId === componentIdentity.skuId);
    if (!identityClaims.length) {
      throw new ProvisionalCaseAdapterProductionAuthorityError(
        "exact_identity_unavailable",
        "case component lacks an active official full model/variant/revision identity claim",
      );
    }
    const subjects = new Map(identityClaims.map((claim) => {
      const subject = { brand: sku.brand, category: "case", ...claim.subject };
      if (!fullSubject(subject)) throw new ProvisionalCaseAdapterProductionAuthorityError("exact_identity_unavailable", "case identity claim is incomplete");
      return [stableAgentJson(subject), subject] as const;
    }));
    if (subjects.size !== 1) {
      throw new ProvisionalCaseAdapterProductionAuthorityError("exact_identity_unavailable", "case component exact identity claims are ambiguous");
    }
    const subject = structuredClone([...subjects.values()][0]!) as EvidencePipelineSubject & {
      modelId: string; variantId: string; revision: string; region: string;
    };
    const familyId = sku?.familyId ?? sku?.id;
    const modelId = sku?.modelId ?? sku?.model;
    if (!sku || sku.brand !== subject.brand || sku.category !== "case" || familyId !== subject.familyId || modelId !== subject.modelId
      || (["variantId", "revision", "region"] as const).some((key) => sku[key] !== undefined && sku[key] !== subject[key])) {
      throw new ProvisionalCaseAdapterProductionAuthorityError("exact_identity_unavailable", "case identity diverges from the active merged catalog");
    }
    return subject;
  }

  async resolveCaseComponentInstanceIdAtRoot(activeRoot: string, input: {
    planId: string;
    subject: EvidencePipelineSubject;
  }): Promise<string> {
    const plan = await this.options.plans.getAtRoot(activeRoot, input.planId);
    if (plan.draft.config.schemaVersion !== "3.0.0") {
      throw new ProvisionalCaseAdapterProductionAuthorityError("case_component_not_unique", "provisional case generation requires a V3 plan");
    }
    const matches: ComponentInstance[] = [];
    for (const component of caseComponents(plan.draft.config)) {
      if (component.identity.status !== "resolved" || component.identity.skuId !== input.subject.skuId) continue;
      const identity = await this.identityForComponentAtRoot(activeRoot, component);
      if (sameSubject(identity, input.subject)) matches.push(component);
    }
    if (matches.length !== 1) {
      throw new ProvisionalCaseAdapterProductionAuthorityError(
        "case_component_not_unique",
        `expected one exact case component for the governed evidence subject; found ${matches.length}`,
      );
    }
    return matches[0]!.instanceId;
  }

  private async generationAttemptAtRoot(
    activeRoot: string,
    planId: string,
    subject: EvidencePipelineSubject,
    runtimeGeneration: number,
  ): Promise<{ request: EvidencePipelineRequest; jobId: `job-${string}`; resultRef: `sha256:${string}`; attemptStartedAt: string }> {
    const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") });
    const matches: Array<{ request: EvidencePipelineRequest; jobId: `job-${string}`; resultRef: `sha256:${string}`; attemptStartedAt: string }> = [];
    for (const job of await this.options.jobs.listAtRoot(activeRoot)) {
      if (job.type !== "evidence.adapter.generate" || (job.status !== "running" && job.status !== "succeeded") || job.planId !== planId
        || job.runtimeGeneration !== runtimeGeneration || !job.checkpointRef?.startsWith("sha256:")) continue;
      const requestArtifact = await artifacts.get(job.payloadRef);
      if (!requestArtifact || requestArtifact.record.kind !== "evidence-pipeline-request") continue;
      let request: unknown;
      try { request = JSON.parse(requestArtifact.bytes.toString("utf8")); }
      catch { continue; }
      if (!await verifyEvidencePipelineRequest(request)) continue;
      const governedRequest = request as EvidencePipelineRequest;
      if (governedRequest.planId !== planId || !sameSubject(governedRequest.subject, subject)) continue;
      let completed: EvidenceStageResult | null = null;
      if (job.status === "succeeded") {
        const resultArtifact = await artifacts.get(job.checkpointRef);
        if (!resultArtifact || resultArtifact.record.kind !== "evidence-stage-result"
          || resultArtifact.record.mediaType !== ATTEMPT_MEDIA_TYPE) continue;
        let result: unknown;
        try { result = JSON.parse(resultArtifact.bytes.toString("utf8")); }
        catch { continue; }
        if (!validateEvidenceStageResult(result) || result.stage !== "adapter_generation" || result.jobId !== job.jobId
          || result.pipelineId !== governedRequest.pipelineId || result.status !== "completed"
          || job.resultCommitHash !== await evidenceStageCommitHash(result)
          || job.resultRefs.length !== result.resultRefs.length + 1
          || job.resultRefs.some((ref, index) => ref !== [job.checkpointRef, ...result.resultRefs][index])) continue;
        completed = result;
      }
      const candidateAttemptRefs = job.status === "running"
        ? [job.checkpointRef]
        : (await artifacts.list()).records
          .filter((record: { kind: string }) => record.kind === "evidence-stage-attempt")
          .map((record: { ref: string }) => record.ref);
      for (const attemptRef of candidateAttemptRefs) {
        const attemptArtifact = await artifacts.get(attemptRef);
        if (!attemptArtifact || attemptArtifact.record.kind !== "evidence-stage-attempt"
          || attemptArtifact.record.mediaType !== ATTEMPT_MEDIA_TYPE) continue;
        let attempt: unknown;
        try { attempt = JSON.parse(attemptArtifact.bytes.toString("utf8")); }
        catch { continue; }
        if (!validateEvidenceStageAttempt(attempt) || attempt.stage !== "adapter_generation" || attempt.jobId !== job.jobId
          || attempt.pipelineId !== governedRequest.pipelineId || !attempt.inputRefs.includes(job.payloadRef)
          || (completed && (completed.attemptStartedAt !== attempt.attemptStartedAt
            || completed.inputRefs.length !== attempt.inputRefs.length
            || completed.inputRefs.some((ref, index) => ref !== attempt.inputRefs[index])))) continue;
        matches.push({
          request: governedRequest,
          jobId: job.jobId as `job-${string}`,
          resultRef: attemptRef as `sha256:${string}`,
          attemptStartedAt: (attempt as EvidenceStageAttemptCheckpoint).attemptStartedAt,
        });
      }
    }
    if (matches.length !== 1) {
      throw new ProvisionalCaseAdapterProductionAuthorityError(
        "generation_attempt_not_unique",
        `expected one governed adapter generation attempt; found ${matches.length}`,
      );
    }
    return matches[0]!;
  }

  private async evidenceSourcesAtRoot(
    activeRoot: string,
    claims: readonly EvidenceClaim[],
  ): Promise<CaseAdapterEvidenceSourceClosure[]> {
    const evidence = this.options.evidence.atActiveRoot(activeRoot);
    const byCapture = new Map<string, EvidenceClaim[]>();
    for (const claim of claims) byCapture.set(claim.source.captureId, [...(byCapture.get(claim.source.captureId) ?? []), claim]);
    const sources: CaseAdapterEvidenceSourceClosure[] = [];
    for (const [captureId, captureClaims] of [...byCapture.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const content = await evidence.getDocumentContent(captureClaims[0]!.source.documentId);
      const capture = await evidence.getCapture(captureId);
      if (!content || !capture || content.document.sha256 !== captureClaims[0]!.source.documentSha256
        || capture.documentId !== content.document.id || sha256Bytes(content.bytes) !== content.document.sha256) {
        throw new ProvisionalCaseAdapterProductionAuthorityError("governed_fact_closure_unavailable", "evidence document/capture/bytes closure is unavailable");
      }
      let sourceText: string;
      try { sourceText = new TextDecoder("utf-8", { fatal: true }).decode(content.bytes); }
      catch {
        throw new ProvisionalCaseAdapterProductionAuthorityError(
          "governed_fact_closure_unavailable",
          "non-text evidence requires a governed OCR locator before provisional generation",
        );
      }
      const byPage = new Map<number, string[]>();
      for (const claim of captureClaims) {
        const snippet = claim.source.locator.snippet;
        if (typeof snippet !== "string" || !snippet) {
          throw new ProvisionalCaseAdapterProductionAuthorityError("governed_fact_closure_unavailable", "governed claim lacks a bounded source snippet");
        }
        const page = claim.source.locator.page ?? 1;
        byPage.set(page, [...(byPage.get(page) ?? []), snippet]);
      }
      const locatorMaterial = {
        schemaVersion: "case-adapter-locator-artifact-v1",
        documentId: content.document.id,
        documentSha256: content.document.sha256,
        sourceByteLength: content.document.byteLength,
        pages: [...byPage.entries()].sort(([left], [right]) => left - right)
          .map(([page, snippets]) => ({ page, text: boundedPageText(sourceText, snippets) })),
      };
      const locatorArtifactBytes = Buffer.from(stableAgentJson(locatorMaterial), "utf8");
      sources.push({
        document: content.document,
        capture,
        bytes: Buffer.from(content.bytes),
        locatorArtifactRef: `sha256:${sha256Bytes(locatorArtifactBytes)}`,
        locatorArtifactBytes,
      });
    }
    return sources;
  }

  async resolveProvisionalCaseAdapterContextAtRoot(
    activeRoot: string,
    request: ResolveProvisionalCaseAdapterContextRequest,
  ): Promise<ResolvedProvisionalCaseAdapterContext> {
    const plan = await this.options.plans.getAtRoot(activeRoot, request.planId);
    if (plan.draft.config.schemaVersion !== "3.0.0") {
      throw new ProvisionalCaseAdapterProductionAuthorityError("case_component_not_unique", "provisional case generation requires a V3 plan");
    }
    const matches = caseComponents(plan.draft.config).filter((component) => component.instanceId === request.caseComponentInstanceId);
    if (matches.length !== 1) {
      throw new ProvisionalCaseAdapterProductionAuthorityError("case_component_not_unique", "exact case component is missing or duplicated in the current plan");
    }
    const planComponent = matches[0]!;
    const catalogIdentity = await this.identityForComponentAtRoot(activeRoot, planComponent);
    const currentFacts = await this.options.facts.listCurrentFactsAtRoot(activeRoot, request.runtimeGeneration);
    const facts = currentFacts.filter((fact) => factMatchesSubject(fact, catalogIdentity))
      .sort((left, right) => left.factId.localeCompare(right.factId));
    const identityFacts = facts.filter((fact) => fact.field === "identity.revision" && fact.value === catalogIdentity.revision);
    if (!identityFacts.length) {
      throw new ProvisionalCaseAdapterProductionAuthorityError(
        "governed_fact_closure_unavailable",
        "exact case revision lacks a current governed identity fact",
      );
    }
    const claimIds = [...new Set(facts.flatMap((fact) => fact.evidenceRefs))].sort();
    const claims = (await Promise.all(claimIds.map((claimId) => this.options.claims.getClaimAtRoot(activeRoot, claimId))));
    if (claims.some((claim) => claim === null)) {
      throw new ProvisionalCaseAdapterProductionAuthorityError("governed_fact_closure_unavailable", "case fact contains a dangling evidence claim");
    }
    const evidenceClaims = claims as EvidenceClaim[];
    if (evidenceClaims.some((claim) => !claimSubjectMatches(claim, catalogIdentity))) {
      throw new ProvisionalCaseAdapterProductionAuthorityError("governed_fact_closure_unavailable", "case fact evidence crosses the exact catalog identity");
    }
    const generationJob = await this.generationAttemptAtRoot(
      activeRoot,
      request.planId,
      catalogIdentity,
      request.runtimeGeneration,
    );
    const snapshot = await createFactSnapshot({
      schemaVersion: "fact-snapshot-v2",
      factRefs: facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash })),
      conflictRefs: [],
      createdAt: generationJob.attemptStartedAt,
    });
    const loadedRegistry = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(activeRoot, request.runtimeGeneration);
    const currentRegistry = loadedRegistry.registryRef
      ? await loadRuntimeCaseAdapterRegistrySnapshotAtRoot(activeRoot, loadedRegistry.registryRef)
      : null;
    if (loadedRegistry.registryRef && !currentRegistry) throw new Error("runtime case adapter registry current snapshot is unavailable");
    const previousEntry = currentRegistry?.entries.find((entry) => entry.identity.skuId === catalogIdentity.skuId
      && entry.identity.revision === catalogIdentity.revision && entry.identity.region === catalogIdentity.region);
    const planContext = {
      planId: plan.id,
      caseComponentInstanceId: planComponent.instanceId,
      planRevision: plan.draftRevision,
      configHash: await hashPlanConfig(plan.draft.config),
    };
    const identity = {
      skuId: catalogIdentity.skuId,
      revision: catalogIdentity.revision,
      region: catalogIdentity.region,
      identityFactIds: identityFacts.map((fact) => fact.factId).sort(),
    };
    return {
      schemaVersion: "resolved-provisional-case-adapter-context-v1",
      planContext,
      planComponent: structuredClone(planComponent),
      planAuthority: provisionalCaseAdapterPlanAuthorityArtifact(planContext, planComponent, catalogIdentity, identity),
      registryGuard: {
        expectedPriorRegistrationHash: previousEntry?.contentHash ?? null,
        expectedPriorRegistryRef: loadedRegistry.registryRef,
      },
      generationJob: {
        jobId: generationJob.jobId,
        resultRef: generationJob.resultRef,
        attemptStartedAt: generationJob.attemptStartedAt,
      },
      catalogIdentity: structuredClone(catalogIdentity),
      identity,
      factClosure: { snapshot, facts, conflicts: [], evidenceClaims },
      evidenceSources: await this.evidenceSourcesAtRoot(activeRoot, evidenceClaims),
    };
  }
}

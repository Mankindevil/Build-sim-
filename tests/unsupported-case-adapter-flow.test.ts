import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentAuditHash } from "../src/agent/audit";
import { AgentWriteApprovalAuthority, type ValidatedAgentWriteApprovalProof } from "../src/agent/write-approval-authority";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { createEvidenceClaim } from "../src/evidence/claims";
import type { EvidenceClaim, EvidenceCapture, EvidenceDocument } from "../src/evidence/contracts";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import {
  createEvidencePipelineRequest,
  EVIDENCE_PIPELINE_HANDLER_VERSION,
  EVIDENCE_PIPELINE_JOB_TYPES,
  EVIDENCE_PIPELINE_STAGES,
  evidenceStageCommitHash,
  evidenceStageIdempotencyKey,
  evidenceStageInputHash,
  jobIdForEvidenceStage,
  type EvidencePipelineDescriptor,
  type EvidencePipelineStage,
  type EvidenceStageResult,
} from "../src/evidence/jobs/contracts";
import { createFactRecord } from "../src/facts/hash";
import { factFieldPolicy } from "../src/facts/field-registry";
import { createFactSnapshot } from "../src/facts/snapshots";
import type { FactRecord } from "../src/facts/contracts";
import { FileJobRepository } from "../src/jobs/repository";
import { FilePlanRepository } from "../src/plans/file-repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, canonicalJson, confined, readJson, sha256Json } from "../src/runtime/fs.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import type { ProductionEvidenceJobRuntime } from "../src/evidence/jobs/production";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { hashPlanConfig } from "../src/plans/canonical";
import { loadMergedCatalogSync } from "../scripts/price-server/catalog/repository.mjs";
import {
  catalogWriteOptions,
  initializeRuntimeCatalog,
  loadMergedCatalog,
  markRuntimeCatalogSkuAccepted,
  resultRequiresRuntimeCatalogRetention,
  withCatalogWrite,
} from "../scripts/price-server/catalog/repository.mjs";
import { catalogCandidateInputHash } from "../scripts/price-server/catalog/contracts.mjs";
import { runAutoEnrichment } from "../scripts/price-server/catalog/auto-enrichment.mjs";
import { confirmDraft } from "../scripts/price-server/catalog/write.mjs";
import {
  ProvisionalCaseAdapterService,
  provisionalCaseAdapterPlanAuthorityArtifact,
  readProvisionalCaseAdapterCandidateAtRoot,
  type ProvisionalCaseAdapterCandidate,
  type ResolvedProvisionalCaseAdapterContext,
  type RootBoundProvisionalCaseAdapterAuthority,
} from "../src/adapters/provisional";
import { FileRootBoundProvisionalCaseAdapterAuthority } from "../src/adapters/provisional-production";
import {
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
  RuntimeCaseAdapterRegistryRepository,
  loadCurrentRuntimeCaseAdapterManifestsAtRoot,
  loadRuntimeCaseAdapterRegistrySnapshotAtRoot,
  provisionalCaseAdapterApprovalInput,
} from "../src/adapters/runtime-registry-repository";
import { validateCaseAdapterManifestRuntime } from "../src/adapters/case-manifest-runtime.mjs";
import {
  hydrateRuntimeCaseAdapterRegistryArtifactRuntime,
  validateRuntimeCaseAdapterRegistryRuntime,
} from "../src/adapters/provisional-runtime.mjs";
import { createRuntimeCaseAdapterRegistryFixture } from "./helpers/runtime-case-adapter-registry-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CATALOG_IDENTITY = Object.freeze({
  brand: "JONSBO",
  category: "case",
  skuId: "case.jonsbo-fixture-case-model",
  familyId: "case.jonsbo-fixture-case-model",
  modelId: "fixture-case-model",
  variantId: "fixture.case.variant",
  revision: "rev-a",
  region: "global",
} as const);

const PORT_TOPOLOGY = Object.freeze({
  endpointId: "front.usb-c",
  connectorType: "usb-c",
  location: "front",
  controllerId: "case.front-io",
  pathId: "case.front-usb-c-path",
  quantity: 1,
} as const);

type RegistryGuard = ResolvedProvisionalCaseAdapterContext["registryGuard"];

class MutableCaseAuthority implements RootBoundProvisionalCaseAdapterAuthority {
  readonly authorityKind = "case-adapter-generation-root-bound-v1" as const;
  current: ResolvedProvisionalCaseAdapterContext | null = null;

  async resolveProvisionalCaseAdapterContextAtRoot(): Promise<ResolvedProvisionalCaseAdapterContext> {
    if (!this.current) throw new Error("fixture root-bound case authority is not configured");
    return this.current;
  }
}

interface Harness {
  root: string;
  coordinator: RuntimeCoordinator;
  artifacts: FileArtifactRepository;
  evidence: FileEvidenceRepository;
  jobs: FileJobRepository;
  authority: MutableCaseAuthority;
  service: ProvisionalCaseAdapterService;
  registry: RuntimeCaseAdapterRegistryRepository;
  now: () => string;
  advance(milliseconds?: number): void;
}

async function createHarness(label: string): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), `build-sim-provisional-case-${label}-`));
  roots.push(root);
  let clock = Date.parse("2026-08-28T10:00:00.000Z");
  const now = () => new Date(clock).toISOString();
  const coordinator = new RuntimeCoordinator({ root, now });
  await coordinator.initialize(`unsupported-case-${label}`);
  const artifacts = new FileArtifactRepository({ coordinator, now });
  await artifacts.initialize();
  const evidence = new FileEvidenceRepository({ coordinator, now });
  const jobs = new FileJobRepository({ coordinator, now, leaseDurationMs: 3_600_000, leaseToken: () => `lease-${label}-${clock}` });
  await jobs.initialize(`unsupported-case-${label}`);
  const authority = new MutableCaseAuthority();
  const service = new ProvisionalCaseAdapterService(coordinator, authority);
  const registry = new RuntimeCaseAdapterRegistryRepository(coordinator, authority, now);
  return {
    root,
    coordinator,
    artifacts,
    evidence,
    jobs,
    authority,
    service,
    registry,
    now,
    advance(milliseconds = 1_000) { clock += milliseconds; },
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableLocatorBytes(document: EvidenceDocument, text: string): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: "case-adapter-locator-artifact-v1",
    documentId: document.id,
    documentSha256: document.sha256,
    sourceByteLength: document.byteLength,
    pages: [{ page: 1, text }],
  }), "utf8");
}

async function factForClaim(claim: EvidenceClaim, label: string): Promise<FactRecord> {
  const policy = factFieldPolicy(claim.fieldId);
  if (!policy) throw new Error(`fixture fact policy missing for ${claim.fieldId}`);
  return createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: `fact.fixture.${label}.${claim.fieldId.replaceAll(".", "-")}`,
    subject: { kind: "product", ...claim.subject },
    field: claim.fieldId,
    value: structuredClone(claim.value),
    ...(claim.unit === undefined ? {} : { unit: claim.unit }),
    scope: "revision",
    authority: claim.authority,
    safetyClass: policy.safetyClass,
    status: "active",
    evidenceRefs: [claim.claimId],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: claim.retrievedAt,
  });
}

async function createResolvedContext(
  harness: Harness,
  options: {
    label: string;
    depthMm: number;
    planRevision?: number;
    configHash?: string;
    guard: RegistryGuard;
    productionJob?: boolean;
  },
): Promise<ResolvedProvisionalCaseAdapterContext> {
  const issuedAt = harness.now();
  const values: Array<{ fieldId: string; value: unknown; unit?: string }> = [
    { fieldId: "identity.revision", value: CATALOG_IDENTITY.revision },
    { fieldId: "physical.width", value: 240, unit: "mm" },
    { fieldId: "physical.height", value: 480, unit: "mm" },
    { fieldId: "physical.depth", value: options.depthMm, unit: "mm" },
    { fieldId: "mount.point_ids", value: ["mount.board.primary"] },
    { fieldId: "case.motherboard_form_factors", value: ["atx"] },
    { fieldId: "io.port_topology", value: PORT_TOPOLOGY },
  ];
  const snippets = values.map((item) => `${item.fieldId}=${JSON.stringify(item.value)}${item.unit ? ` ${item.unit}` : ""}`);
  const sourceText = [`Fixture official case specification ${options.label}`, ...snippets].join("\n");
  const sourceBytes = Buffer.from(sourceText, "utf8");
  const imported = await harness.evidence.importBuffer(sourceBytes, {
    kind: "official-product-page-snapshot",
    mediaType: "text/plain",
    title: `Fixture case specification ${options.label}`,
    createdAt: issuedAt,
    productIdentities: [{
      brand: CATALOG_IDENTITY.brand,
      basis: "official-document-explicit",
      category: "case",
      skuId: CATALOG_IDENTITY.skuId,
      familyId: CATALOG_IDENTITY.familyId,
      modelId: CATALOG_IDENTITY.modelId,
      variantId: CATALOG_IDENTITY.variantId,
      revision: CATALOG_IDENTITY.revision,
      region: CATALOG_IDENTITY.region,
    }],
    capture: {
      acquisitionMethod: "official-fetch",
      kindBasis: "content-verified",
      requestedUrl: `https://fixture.example/spec/${options.label}`,
      finalUrl: `https://fixture.example/spec/${options.label}`,
      canonicalUrl: `https://fixture.example/spec/${options.label}`,
      retrievedAt: issuedAt,
      status: 200,
      redirects: [],
      officialBrand: CATALOG_IDENTITY.brand,
    },
  }) as { document: EvidenceDocument; capture: EvidenceCapture };

  const locatorArtifactBytes = stableLocatorBytes(imported.document, sourceText);
  const locator = await harness.artifacts.put({
    bytes: locatorArtifactBytes,
    mediaType: "application/vnd.buildsim.case-adapter-locator+json",
    privacyClass: "runtime_internal",
    kind: "case-adapter-evidence-locator",
    references: [],
    createdAt: issuedAt,
  });
  let jobId = `job-${createHash("sha256").update(`case-generation:${options.label}`).digest("hex")}` as `job-${string}`;
  let attemptInputRefs: `sha256:${string}`[] = [];
  let attemptPipelineId = `evidence-pipeline-sha256-${"a".repeat(64)}`;
  if (options.productionJob) {
    const request = await createEvidencePipelineRequest({
      planId: "plan-unsupported-case",
      subject: structuredClone(CATALOG_IDENTITY),
      requestedFieldIds: values.map((item) => item.fieldId).sort(),
      entry: { kind: "search_query", query: `Fixture exact case ${options.label}` },
      allowThirdPartyFallback: true,
      requestedAt: issuedAt,
    });
    const requestArtifact = await harness.artifacts.put({
      bytes: Buffer.from(JSON.stringify(request), "utf8"),
      mediaType: "application/vnd.buildsim.evidence-job+json",
      privacyClass: "runtime_internal",
      kind: "evidence-pipeline-request",
      references: [],
      createdAt: issuedAt,
    });
    const stage = "adapter_generation" as const;
    attemptPipelineId = request.pipelineId;
    jobId = jobIdForEvidenceStage(request.pipelineId, stage) as `job-${string}`;
    const created = await harness.jobs.create({
      type: "evidence.adapter.generate",
      handlerVersion: "1",
      idempotencyKey: evidenceStageIdempotencyKey(request.pipelineId, stage),
      inputHash: await evidenceStageInputHash(request, stage, []),
      payloadRef: requestArtifact.record.ref,
      maxAttempts: 3,
    });
    if (created.job.jobId !== jobId) throw new Error("fixture evidence adapter generation job identity drifted");
    const claimed = await harness.jobs.claimNext(`worker-generation-${options.label}`, { types: ["evidence.adapter.generate"] });
    if (!claimed || claimed.job.jobId !== jobId) throw new Error("fixture evidence adapter generation job was not claimable");
    attemptInputRefs = [requestArtifact.record.ref as `sha256:${string}`];
  }
  const attempt = await harness.artifacts.put({
    bytes: Buffer.from(JSON.stringify({
      schemaVersion: "evidence-stage-attempt-v1",
      pipelineId: attemptPipelineId,
      stage: "adapter_generation",
      jobId,
      attemptStartedAt: issuedAt,
      inputRefs: attemptInputRefs,
    }), "utf8"),
    mediaType: options.productionJob
      ? "application/vnd.buildsim.evidence-job+json"
      : "application/vnd.buildsim.evidence-stage-attempt+json",
    privacyClass: "runtime_internal",
    kind: "evidence-stage-attempt",
    references: attemptInputRefs.map((ref) => ({ ref, necessity: "required_for_replay" as const })),
    createdAt: issuedAt,
  });
  if (options.productionJob) {
    const running = await harness.jobs.get(jobId);
    if (!running.leaseToken) throw new Error("fixture evidence adapter generation job lacks lease");
    await harness.jobs.checkpoint(jobId, {
      expectedRevision: running.revision,
      leaseToken: running.leaseToken,
      runtimeGeneration: running.runtimeGeneration,
    }, attempt.record.ref, { stage: "adapter_generation", completed: 0, total: 1 });
  }

  const claims: EvidenceClaim[] = [];
  for (const [index, item] of values.entries()) {
    claims.push(await createEvidenceClaim({
      schemaVersion: "evidence-claim-v1",
      subject: {
        skuId: CATALOG_IDENTITY.skuId,
        familyId: CATALOG_IDENTITY.familyId,
        modelId: CATALOG_IDENTITY.modelId,
        variantId: CATALOG_IDENTITY.variantId,
        revision: CATALOG_IDENTITY.revision,
        region: CATALOG_IDENTITY.region,
      },
      scope: "revision",
      fieldId: item.fieldId,
      value: structuredClone(item.value),
      ...(item.unit === undefined ? {} : { unit: item.unit }),
      authority: "official",
      source: {
        documentId: imported.document.id,
        documentSha256: imported.document.sha256,
        captureId: imported.capture.id,
        locator: { page: 1, field: `fixture-constraint-${index}`, snippet: snippets[index]! },
      },
      retrievedAt: issuedAt,
      status: "active",
    }));
  }
  const facts = await Promise.all(claims.map((claim) => factForClaim(claim, options.label)));
  const snapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash })),
    conflictRefs: [],
    createdAt: issuedAt,
  });
  const revisionFact = facts.find((fact) => fact.field === "identity.revision");
  if (!revisionFact) throw new Error("fixture identity revision fact is missing");
  const planContext = {
    planId: "plan-unsupported-case",
    caseComponentInstanceId: "case-component-unlisted",
    planRevision: options.planRevision ?? 1,
    configHash: options.configHash ?? "1".repeat(64),
  };
  const identity = {
    skuId: CATALOG_IDENTITY.skuId,
    region: CATALOG_IDENTITY.region,
    revision: CATALOG_IDENTITY.revision,
    identityFactIds: [revisionFact.factId],
  };
  const planComponent = {
    instanceId: planContext.caseComponentInstanceId,
    kind: "case" as const,
    role: "case",
    state: "planned" as const,
    identity: {
      status: "resolved" as const,
      skuId: CATALOG_IDENTITY.skuId,
      identityClaimIds: [claims[0]!.claimId],
    },
    source: "user" as const,
  };
  return {
    schemaVersion: "resolved-provisional-case-adapter-context-v1",
    planContext,
    planComponent,
    planAuthority: provisionalCaseAdapterPlanAuthorityArtifact(planContext, planComponent, CATALOG_IDENTITY, identity),
    registryGuard: structuredClone(options.guard),
    generationJob: { jobId, resultRef: attempt.record.ref, attemptStartedAt: issuedAt },
    catalogIdentity: structuredClone(CATALOG_IDENTITY),
    identity,
    factClosure: { snapshot, facts, conflicts: [], evidenceClaims: claims },
    evidenceSources: [{
      document: imported.document,
      capture: imported.capture,
      bytes: sourceBytes,
      locatorArtifactRef: locator.record.ref,
      locatorArtifactBytes,
    }],
  };
}

async function propose(harness: Harness, context: ResolvedProvisionalCaseAdapterContext): Promise<ProvisionalCaseAdapterCandidate> {
  harness.authority.current = context;
  const state = await harness.coordinator.readState();
  return harness.service.proposeAtRoot({
    planId: context.planContext.planId,
    caseComponentInstanceId: context.planContext.caseComponentInstanceId,
    expectedRuntimeGeneration: state.runtimeGeneration,
    expectedRuntimeRevision: state.revision,
  });
}

async function issueDurableApproval(
  harness: Harness,
  candidate: ProvisionalCaseAdapterCandidate,
  label: string,
): Promise<ValidatedAgentWriteApprovalProof> {
  const input = provisionalCaseAdapterApprovalInput(candidate);
  const runId = `run-provisional-case-${label}`;
  const sessionId = `session-provisional-case-${label}`;
  const callId = `call-provisional-case-${label}`;
  const planAudit = {
    schemaVersion: "1.0.0" as const,
    sessionId,
    runId,
    planId: candidate.planContext.planId,
    planVersionId: null,
    draftRevision: candidate.planContext.planRevision,
    configHash: candidate.planContext.configHash,
    evaluationHash: "e".repeat(64),
    spatialSelection: null,
    contextHash: agentAuditHash({ planId: candidate.planContext.planId, runId, candidateId: candidate.candidateId }),
    recordedAt: harness.now(),
  };
  await harness.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    await atomicWriteJson(confined(activeRoot, "audit", "plan-agent-context", `${runId}.json`), {
      schemaVersion: "plan-agent-context-audit-envelope-v1",
      kind: "plan-agent-context-audit",
      checksum: sha256Json(planAudit),
      payload: planAudit,
    });
    const session = { id: sessionId, contractVersion: "1.0.0", messages: [] };
    await atomicWriteJson(confined(activeRoot, "agent", "sessions", `${sessionId}.json`), {
      schemaVersion: "agent-session-v1",
      contentHash: sha256Bytes(Buffer.from(JSON.stringify(session), "utf8")),
      payload: session,
    });
    const audit = { runId, sessionId, recordedAt: harness.now() };
    await atomicWriteJson(confined(activeRoot, "agent", "audit", `${runId}.json`), {
      ...audit,
      recordHash: sha256Bytes(Buffer.from(canonicalJson(audit), "utf8")),
    });
  });
  const jobPayloadBytes = Buffer.from(JSON.stringify({ runId, input }), "utf8");
  const jobPayload = await harness.artifacts.put({
    bytes: jobPayloadBytes,
    mediaType: "application/json",
    privacyClass: "runtime_internal",
    kind: "agent-run-request",
    references: [],
    createdAt: harness.now(),
  });
  const created = await harness.jobs.create({
    type: "agent.run",
    handlerVersion: "1",
    idempotencyKey: `agent-run:${runId}`,
    inputHash: agentAuditHash({ runId, input }),
    payloadRef: jobPayload.record.ref,
    maxAttempts: 3,
  });
  const firstClaim = await harness.jobs.claimNext(`worker-${label}`, { types: ["agent.run"], leaseDurationMs: 3_600_000 });
  if (!firstClaim || firstClaim.job.jobId !== created.job.jobId) throw new Error("fixture Agent approval job could not be claimed");
  const authority = new AgentWriteApprovalAuthority(harness.artifacts, {
    jobs: harness.jobs,
    now: harness.now,
    token: () => createHash("sha256").update(`approval-token:${label}`).digest("hex"),
  });
  const requested = await authority.request({
    runId,
    sessionId,
    call: { id: callId, name: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME, input },
    toolTitle: "Register provisional case adapter",
    toolDefinitionHash: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
  }, {
    jobId: firstClaim.job.jobId,
    expectedRevision: firstClaim.lease.expectedRevision,
    leaseToken: firstClaim.lease.leaseToken,
    runtimeGeneration: firstClaim.lease.runtimeGeneration,
  });
  const pendingCheckpoint = await harness.jobs.checkpoint(
    firstClaim.job.jobId,
    firstClaim.lease,
    requested.authorityRef,
    { stage: "waiting_approval", completed: 0, total: 1 },
  );
  const waiting = await harness.jobs.pauseForUser(firstClaim.job.jobId, pendingCheckpoint.lease);
  const confirmed = await authority.confirm({
    authorityRef: requested.authorityRef,
    runId,
    approvalId: requested.pending.approvalId,
    nonce: requested.pending.nonce,
    approvedBy: `human-reviewer-${label}`,
  });
  await harness.jobs.resume(waiting.jobId, waiting.revision, { checkpointRef: confirmed.authorityRef });
  const secondClaim = await harness.jobs.claimNext(`worker-${label}-resume`, { types: ["agent.run"], leaseDurationMs: 3_600_000 });
  if (!secondClaim || secondClaim.job.jobId !== created.job.jobId) throw new Error("fixture Agent approval job could not resume");
  const expected = {
    toolName: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
    toolDefinitionHash: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
    sessionId,
    runId,
    inputHash: agentAuditHash(input),
    callId,
  };
  const authorized = await authority.authorize(confirmed.authorityRef, expected);
  if (!authorized) throw new Error("fixture Agent approval was not authorized");
  return authorized.proof;
}

async function registryArtifactCount(harness: Harness): Promise<number> {
  const listing = await harness.artifacts.list();
  return listing.records.filter((record: { kind: string }) => record.kind === "runtime-case-adapter-registry-snapshot").length;
}

function withContentHash<T extends Record<string, unknown>>(value: T): T & { manifestHash: string } {
  return { ...value, manifestHash: sha256Json(value) };
}

async function approveFixtureCatalogSku(harness: Harness): Promise<void> {
  const candidateId = `catalog-candidate-${createHash("sha256").update(harness.root).digest("hex").slice(0, 16)}`;
  const url = `https://www.jonsbo.com/en/products/${candidateId}.html`;
  const fields = [
    ["brand", CATALOG_IDENTITY.brand],
    ["model", CATALOG_IDENTITY.modelId],
    ["dims.lengthMm", 420],
    ["dims.widthMm", 240],
    ["dims.heightMm", 480],
  ].map(([field, value], index) => ({
    provenanceId: `${candidateId}-${index}`,
    field,
    value,
    evidence: "official",
    sourceUrl: url,
    sourceKind: "official-page",
    retrievedAt: harness.now(),
    extractor: "governed-provisional-case-catalog-fixture-v1",
    locator: `fixture:${String(field)}`,
    snippet: `${String(field)}: ${String(value)}`,
    confidence: 1,
  }));
  const candidate = {
    candidateId,
    query: {
      raw: `${CATALOG_IDENTITY.brand} ${CATALOG_IDENTITY.modelId}`,
      brand: CATALOG_IDENTITY.brand,
      model: CATALOG_IDENTITY.modelId,
      category: "case",
      locale: "zh-CN",
      tokens: [CATALOG_IDENTITY.brand.toLocaleLowerCase(), CATALOG_IDENTITY.modelId],
    },
    brand: CATALOG_IDENTITY.brand,
    model: CATALOG_IDENTITY.modelId,
    category: "case",
    title: `${CATALOG_IDENTITY.brand} ${CATALOG_IDENTITY.modelId}`,
    url,
    canonicalUrl: url,
    source: { kind: "official", domain: "www.jonsbo.com", retrievedAt: harness.now(), httpStatus: 200, finalUrl: url },
    official: { trustStatus: "trusted", brand: CATALOG_IDENTITY.brand, pageKind: "product", reasons: [] },
    identity: { verdict: "exact", score: 0.99, criticalMatches: [], criticalConflicts: [], unknowns: [], reasons: ["official brand and model exactly match"], agentReviewRequired: false },
    match: { score: 0.99, kind: "brand-model", reasons: ["fixture exact governed catalog identity"] },
    extraction: {
      status: "ok",
      fieldsFound: fields.length,
      fieldsMissing: 0,
      adapter: "governed-provisional-case-catalog-fixture-v1",
      contentHash: createHash("sha256").update(candidateId).digest("hex"),
    },
    fields,
    conflicts: [],
  };
  const repositoryOptions = { coordinator: harness.coordinator, runtimeRoot: harness.root, generationAware: true };
  await initializeRuntimeCatalog(repositoryOptions);
  const result = await withCatalogWrite(repositoryOptions, async (paths: Record<string, unknown>) => {
    const catalog = await loadMergedCatalog({ ...paths, direct: true, generationAware: false });
    const options = {
      ...catalogWriteOptions(paths, catalog),
      candidate,
      expectedHash: catalogCandidateInputHash(candidate),
      autoEnrichTrustedOfficial: true,
      catalogWriteEnabled: true,
    };
    const draft = await runAutoEnrichment(candidateId, options);
    if (draft.status !== "draft") throw new Error(`fixture governed catalog draft blocked: ${(draft.reasons ?? []).join("; ")}`);
    const confirmed = await confirmDraft(draft.draftId, { ...options, approved: true, expectedHash: draft.expectedHash });
    if (resultRequiresRuntimeCatalogRetention(confirmed) && !confirmed.runtimeCatalogRetained) {
      await markRuntimeCatalogSkuAccepted(confirmed.skuId, { ...paths, direct: true, generationAware: false });
    }
    return confirmed;
  });
  if (result.status !== "confirmed" || result.skuId !== CATALOG_IDENTITY.skuId) {
    throw new Error(`fixture governed catalog approval did not produce exact SKU: ${JSON.stringify(result)}`);
  }
}

async function persistMigratedFactEvidenceClosure(
  harness: Harness,
  context: ResolvedProvisionalCaseAdapterContext,
): Promise<void> {
  const claims = context.factClosure.evidenceClaims;
  const facts = context.factClosure.facts;
  const document = context.evidenceSources[0]!.document;
  const manuals = [{ file: "data/fixture-unsupported-case-spec.txt", sha256: document.sha256 }];
  const formal = claims.map((claim) => ({
    constraintId: String(claim.source.locator.field),
    fieldId: claim.fieldId,
    ...(claim.unit === undefined ? {} : { unit: claim.unit }),
    valueHash: sha256Json(claim.value),
    sourceFile: "references/fixture-unsupported-case-spec.txt",
    page: Number(claim.source.locator.page),
    skuId: claim.subject.skuId,
  }));
  const catalogHash = "c".repeat(64); const constraintsHash = "d".repeat(64);
  const sourceHash = sha256Json({ catalogHash, constraintsHash, manuals });
  const planHash = sha256Json({
    schemaVersion: "catalog-facts-v1-plan",
    migrationId: "catalog-facts-v1",
    sourceHash,
    catalogHash,
    constraintsHash,
    manuals,
    formal,
    legacyUnverified: [],
  });
  const baseManifest = {
    schemaVersion: "catalog-facts-v1-manifest",
    migrationId: "catalog-facts-v1",
    status: "applied",
    sourceHash,
    planHash,
    catalogHash,
    constraintsHash,
    manuals,
    formal,
    legacyUnverified: [],
    claims: claims.map((claim) => ({
      claimId: claim.claimId,
      contentHash: claim.contentHash,
      documentId: claim.source.documentId,
      captureId: claim.source.captureId,
    })).sort((left, right) => left.claimId.localeCompare(right.claimId)),
    facts: facts.map((fact) => ({
      factId: fact.factId,
      contentHash: fact.contentHash,
      claimId: fact.evidenceRefs[0]!,
    })).sort((left, right) => left.factId.localeCompare(right.factId)),
    appliedAt: harness.now(),
  };
  const migrationManifest = withContentHash(baseManifest);
  await harness.coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
    for (const claim of claims) {
      await atomicWriteJson(confined(activeRoot, "evidence", "claims", claim.contentHash.slice(0, 2), `${claim.claimId}.json`), {
        schemaVersion: "evidence-claim-envelope-v1",
        kind: "evidence-claim",
        checksum: sha256Json(claim),
        payload: claim,
      });
    }
    for (const fact of facts) {
      const payload = { schemaVersion: "fact-repository-v1", revision: 0, recordHash: sha256Json(fact), fact };
      await atomicWriteJson(confined(activeRoot, "facts", "records", `${fact.factId}.json`), {
        schemaVersion: "fact-repository-envelope-v1",
        kind: "fact",
        checksum: sha256Json(payload),
        payload,
      });
    }
    const snapshot = context.factClosure.snapshot;
    await atomicWriteJson(confined(activeRoot, "facts", "snapshots", `${snapshot.snapshotId}.json`), {
      schemaVersion: "fact-repository-envelope-v1",
      kind: "snapshot",
      checksum: sha256Json(snapshot),
      payload: snapshot,
    });
    await atomicWriteJson(confined(activeRoot, "migrations", "catalog-facts-v1", "manifest.json"), migrationManifest);
  });
}

async function createProductionCandidate(harness: Harness): Promise<{
  context: ResolvedProvisionalCaseAdapterContext;
  candidate: ProvisionalCaseAdapterCandidate;
}> {
  await approveFixtureCatalogSku(harness);
  const context = await createResolvedContext(harness, {
    label: "production-closure",
    depthMm: 420,
    planRevision: 0,
    configHash: "0".repeat(64),
    guard: { expectedPriorRegistrationHash: null, expectedPriorRegistryRef: null },
    productionJob: true,
  });
  await persistProductionPlanClosure(harness, context);
  return { context, candidate: await propose(harness, context) };
}

async function persistProductionPlanClosure(
  harness: Harness,
  context: ResolvedProvisionalCaseAdapterContext,
): Promise<void> {
  const config = createEmptyBuildConfigV3("draft-unsupported-case", "Unsupported case", harness.now());
  config.components.push(structuredClone(context.planComponent));
  const plans = new FilePlanRepository<BuildConfigV3>({
    coordinator: harness.coordinator,
    topologyV3Enabled: true,
    now: harness.now,
    id: (prefix) => prefix === "plan" ? "plan-unsupported-case" : "version-unsupported-case",
    getCatalogAtRoot: (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }),
  });
  const plan = await plans.create({ name: "Unsupported case", config });
  const configHash = await hashPlanConfig(plan.draft.config);
  context.planContext = {
    planId: plan.id,
    caseComponentInstanceId: context.planComponent.instanceId,
    planRevision: plan.draftRevision,
    configHash,
  };
  context.planAuthority = provisionalCaseAdapterPlanAuthorityArtifact(
    context.planContext,
    context.planComponent,
    context.catalogIdentity,
    context.identity,
  );
  await persistMigratedFactEvidenceClosure(harness, context);
}

async function completeFixtureEvidenceStage(
  runtime: ProductionEvidenceJobRuntime,
  descriptor: EvidencePipelineDescriptor,
  stage: EvidencePipelineStage,
): Promise<void> {
  const jobId = jobIdForEvidenceStage(descriptor.pipelineId, stage);
  const claimed = await runtime.jobs.claimNext(`fixture-upstream-${stage}`, {
    types: [EVIDENCE_PIPELINE_JOB_TYPES[stage]],
    leaseDurationMs: 3_600_000,
    online: true,
  });
  if (!claimed || claimed.job.jobId !== jobId) throw new Error(`fixture could not claim ${stage}`);
  const priorResultRefs: string[] = [];
  for (const priorStage of EVIDENCE_PIPELINE_STAGES.slice(0, EVIDENCE_PIPELINE_STAGES.indexOf(stage))) {
    const prior = await runtime.jobs.get(jobIdForEvidenceStage(descriptor.pipelineId, priorStage));
    if (prior.status === "succeeded" && prior.checkpointRef) priorResultRefs.push(prior.checkpointRef);
  }
  const inputRefs = [descriptor.requestRef, ...priorResultRefs];
  const attemptStartedAt = "2026-08-28T10:30:00.000Z";
  const attemptRef = await runtime.artifacts.putAttempt({
    schemaVersion: "evidence-stage-attempt-v1",
    pipelineId: descriptor.pipelineId,
    stage,
    jobId,
    attemptStartedAt,
    inputRefs,
  }, { jobId, ...claimed.lease });
  const checkpoint = await runtime.jobs.checkpoint(jobId, claimed.lease, attemptRef, {
    stage,
    completed: 0,
    total: 1,
  });
  const result: EvidenceStageResult = {
    schemaVersion: "evidence-stage-result-v1",
    pipelineId: descriptor.pipelineId,
    stage,
    handlerVersion: EVIDENCE_PIPELINE_HANDLER_VERSION,
    jobId,
    idempotencyKey: evidenceStageIdempotencyKey(descriptor.pipelineId, stage),
    attemptStartedAt,
    completedAt: attemptStartedAt,
    status: stage === "fact_impact" ? "completed" : "skipped",
    inputRefs,
    output: stage === "fact_impact"
      ? { reason: "fixture_current_governed_facts_already_promoted" }
      : { reason: "fixture_upstream_receipt_preseeded" },
    resultRefs: [],
  };
  const resultRef = await runtime.artifacts.putResult(result, { jobId, ...checkpoint.lease });
  const committed = await runtime.jobs.checkpoint(jobId, checkpoint.lease, resultRef, {
    stage,
    completed: 1,
    total: 1,
  });
  await runtime.jobs.succeed(jobId, committed.lease, [resultRef], await evidenceStageCommitHash(result));
}

async function prepareWorkspaceProductionGeneration(harness: Harness): Promise<{
  runtime: ProductionEvidenceJobRuntime;
  descriptor: EvidencePipelineDescriptor;
  workspace: ReturnType<typeof createWorkspaceRepositories<BuildConfigV3>>;
}> {
  await approveFixtureCatalogSku(harness);
  const context = await createResolvedContext(harness, {
    label: "workspace-production-handler",
    depthMm: 420,
    planRevision: 0,
    configHash: "0".repeat(64),
    guard: { expectedPriorRegistrationHash: null, expectedPriorRegistryRef: null },
  });
  await persistProductionPlanClosure(harness, context);
  const workspace = createWorkspaceRepositories<BuildConfigV3>({
    RUNTIME_ROOT: harness.root,
    BUILD_SIM_DURABLE_JOBS_ENABLED: "true",
    BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
    BUILD_SIM_FACT_GRAPH_ENABLED: "true",
    BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "true",
    BUILD_SIM_EVIDENCE_NETWORK_ENABLED: "false",
  });
  const runtime = workspace.evidenceJobs;
  if (!runtime?.options.provisionalCaseAdapter) throw new Error("production workspace did not compose provisional adapter generation");
  await runtime.initialize();
  const descriptor = await runtime.enqueue({
    planId: context.planContext.planId,
    subject: structuredClone(CATALOG_IDENTITY),
    requestedFieldIds: context.factClosure.facts.map((fact) => fact.field).sort(),
    entry: { kind: "search_query", query: "JONSBO exact unsupported case official specification" },
    allowThirdPartyFallback: true,
    requestedAt: harness.now(),
  });
  for (const stage of EVIDENCE_PIPELINE_STAGES.slice(0, EVIDENCE_PIPELINE_STAGES.indexOf("adapter_generation"))) {
    await completeFixtureEvidenceStage(runtime, descriptor, stage);
  }
  return { runtime, descriptor, workspace };
}

describe("unsupported case provisional adapter production authority", () => {
  it("reaches candidate persistence through the real flag-gated workspace evidence handler", async () => {
    const harness = await createHarness("workspace-production-handler");
    const disabled = createWorkspaceRepositories<BuildConfigV3>({
      RUNTIME_ROOT: harness.root,
      BUILD_SIM_DURABLE_JOBS_ENABLED: "true",
      BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_GENERIC_ADAPTERS_ENABLED: "false",
      BUILD_SIM_EVIDENCE_NETWORK_ENABLED: "false",
    });
    expect(disabled.evidenceJobs?.options.provisionalCaseAdapter).toBeUndefined();
    expect((await harness.artifacts.list()).records.filter((record: { kind: string }) =>
      record.kind === "provisional-case-adapter-candidate")).toHaveLength(0);

    const { runtime, descriptor, workspace } = await prepareWorkspaceProductionGeneration(harness);
    await expect(harness.coordinator.withConsistentSnapshot(async ({ activeRoot }: { activeRoot: string }) =>
      runtime.options.provisionalCaseAdapter!.resolveCaseComponentInstanceIdAtRoot(activeRoot, {
        planId: "plan-unsupported-case",
        subject: structuredClone(CATALOG_IDENTITY),
      }))).resolves.toMatchObject({ result: "case-component-unlisted" });
    const generationTick = await runtime.tick();
    expect(generationTick.worker, JSON.stringify(generationTick.worker)).toMatchObject({
      outcome: "succeeded",
      job: { jobId: descriptor.jobIds.adapter_generation, type: "evidence.adapter.generate" },
    });
    const status = await runtime.status(descriptor.pipelineId);
    const generated = status.stages.find((entry) => entry.stage === "adapter_generation")?.result;
    expect(generated).toMatchObject({
      status: "completed",
      output: {
        schemaVersion: "provisional-case-adapter-candidate-v1",
        status: "ready_for_review",
        domains: {
          electronics: { status: "ready" },
          geometry: { status: "blocked" },
          routing: { status: "blocked" },
          assembly: { status: "blocked" },
        },
      },
    });
    const candidate = generated?.output as unknown as ProvisionalCaseAdapterCandidate;
    expect(candidate.authorityRefs).toMatchObject({
      generationJobId: descriptor.jobIds.adapter_generation,
      generationJobResultRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      evidenceClaimIds: expect.arrayContaining([expect.stringMatching(/^claim-sha256-/)]),
    });
    expect(await readProvisionalCaseAdapterCandidateAtRoot(
      harness.coordinator.activeRoot(await harness.coordinator.readState()),
      candidate.candidateId,
    )).toEqual(candidate);
    const productionAuthority = new FileRootBoundProvisionalCaseAdapterAuthority({
      plans: workspace.repository,
      facts: workspace.factRepository,
      claims: workspace.evidenceClaimRepository,
      evidence: workspace.evidenceRepository,
      jobs: runtime.jobs,
      catalogAtRoot: (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }),
    });
    const registrationRepository = new RuntimeCaseAdapterRegistryRepository(
      harness.coordinator,
      productionAuthority,
      harness.now,
    );
    const registered = await registrationRepository.approve(
      candidate.candidateId,
      await issueDurableApproval(harness, candidate, "workspace-production-handler"),
    );
    expect(registered).toMatchObject({ alreadyRegistered: false, registryGeneration: 1 });
    const restarted = new RuntimeCaseAdapterRegistryRepository(
      new RuntimeCoordinator({ root: harness.root, now: harness.now }),
      productionAuthority,
      harness.now,
    );
    await expect(restarted.resolve({
      skuId: CATALOG_IDENTITY.skuId,
      region: CATALOG_IDENTITY.region,
      revision: CATALOG_IDENTITY.revision,
    })).resolves.toMatchObject({
      registryRef: registered.registryRef,
      registration: { candidateId: candidate.candidateId },
    });
    await expect(createProductionReferenceGraph({ coordinator: harness.coordinator, now: harness.now }))
      .resolves.toMatchObject({ graphVersion: "portable-reference-graph-v1" });
  });

  it("closes a server-resolved production candidate through the portable reference graph", async () => {
    const harness = await createHarness("production-graph");
    const { context, candidate } = await createProductionCandidate(harness);
    expect(candidate).toMatchObject({
      status: "ready_for_review",
      domains: {
        electronics: { status: "ready" },
        geometry: { status: "blocked" },
        routing: { status: "blocked" },
        assembly: { status: "blocked" },
      },
    });
    await expect(createProductionReferenceGraph({ coordinator: harness.coordinator, now: harness.now })).resolves.toMatchObject({
      graphVersion: "portable-reference-graph-v1",
    });
    harness.authority.current = context;
    const registered = await harness.registry.approve(candidate.candidateId, await issueDurableApproval(
      harness,
      candidate,
      "production-graph",
    ));
    expect(registered).toMatchObject({ registryGeneration: 1, alreadyRegistered: false });
    await expect(createProductionReferenceGraph({ coordinator: harness.coordinator, now: harness.now })).resolves.toMatchObject({
      graphVersion: "portable-reference-graph-v1",
    });
  });

  it("publishes exact gen1/gen2 immutable registry bytes for adapter lock/cache consumers", async () => {
    const fixture = await createRuntimeCaseAdapterRegistryFixture();
    expect(fixture.first.registryBytes).not.toBe(fixture.second.registryBytes);
    expect(fixture.second).toMatchObject({ runtimeGeneration: 1, registryGeneration: 2 });
    for (const version of [fixture.first, fixture.second]) {
      expect(validateRuntimeCaseAdapterRegistryRuntime(version.state)).toEqual([]);
      expect(hydrateRuntimeCaseAdapterRegistryArtifactRuntime(
        JSON.parse(version.registryBytes),
        version.registryRef,
      )).toEqual(version.state);
    }
  });

  it("separates active runtime generation from empty and restored immutable registry source generations", async () => {
    const password = "a sufficiently long password";
    const empty = await createHarness("empty-registry-restore");
    const emptyStateV1 = await empty.coordinator.readState();
    const emptyV1 = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      empty.coordinator.activeRoot(emptyStateV1),
      emptyStateV1.runtimeGeneration,
    );
    expect(emptyV1).toMatchObject({
      registryRef: null,
      registryBytes: null,
      activeRuntimeGeneration: 1,
      registrySourceRuntimeGeneration: null,
      registryGeneration: 0,
      manifests: [],
    });
    const emptyBackup = path.join(empty.root, "empty-registry.backup");
    await createBackup({ coordinator: empty.coordinator, outputFile: emptyBackup, password, now: empty.now });
    await restoreBackup({ coordinator: empty.coordinator, inputFile: emptyBackup, password, now: empty.now });
    const emptyStateV2 = await empty.coordinator.readState();
    const emptyV2 = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      empty.coordinator.activeRoot(emptyStateV2),
      emptyStateV2.runtimeGeneration,
    );
    expect(emptyStateV2.runtimeGeneration).toBe(2);
    expect(emptyV2).toMatchObject({
      registryRef: null,
      registryBytes: null,
      activeRuntimeGeneration: 2,
      registrySourceRuntimeGeneration: null,
      registryGeneration: 0,
      manifests: [],
    });

    const populated = await createHarness("populated-registry-restore");
    const { context, candidate } = await createProductionCandidate(populated);
    populated.authority.current = context;
    const approved = await populated.registry.approve(
      candidate.candidateId,
      await issueDurableApproval(populated, candidate, "populated-registry-restore"),
    );
    const populatedStateV1 = await populated.coordinator.readState();
    const populatedV1 = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      populated.coordinator.activeRoot(populatedStateV1),
      populatedStateV1.runtimeGeneration,
    );
    expect(populatedV1).toMatchObject({
      registryRef: approved.registryRef,
      activeRuntimeGeneration: 1,
      registrySourceRuntimeGeneration: 1,
      registryGeneration: 1,
    });
    const populatedBackup = path.join(populated.root, "populated-registry.backup");
    await createBackup({ coordinator: populated.coordinator, outputFile: populatedBackup, password, now: populated.now });
    await expect(verifyBackup({ inputFile: populatedBackup, password, now: populated.now })).resolves.toMatchObject({ valid: true });
    await restoreBackup({ coordinator: populated.coordinator, inputFile: populatedBackup, password, now: populated.now });
    const populatedStateV2 = await populated.coordinator.readState();
    const populatedV2 = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      populated.coordinator.activeRoot(populatedStateV2),
      populatedStateV2.runtimeGeneration,
    );
    expect(populatedStateV2.runtimeGeneration).toBe(2);
    expect(populatedV2).toMatchObject({
      registryRef: approved.registryRef,
      registryBytes: populatedV1.registryBytes,
      activeRuntimeGeneration: 2,
      registrySourceRuntimeGeneration: 1,
      registryGeneration: 1,
      manifests: populatedV1.manifests,
    });
    await expect(loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      populated.coordinator.activeRoot(populatedStateV2),
      1,
    )).rejects.toThrow(/active generation\/root guard is stale/);
  });

  it("supports immutable same-identity supersession with old snapshot replay and stale CAS zero-write", async () => {
    const harness = await createHarness("supersession");
    const emptyGuard: RegistryGuard = { expectedPriorRegistrationHash: null, expectedPriorRegistryRef: null };
    const contextA = await createResolvedContext(harness, { label: "a", depthMm: 420, guard: emptyGuard });
    const candidateA = await propose(harness, contextA);
    expect(candidateA.status).toBe("ready_for_review");
    expect(candidateA.manifest).not.toBeNull();
    expect(validateCaseAdapterManifestRuntime(candidateA.manifest)).toEqual([]);
    harness.authority.current = contextA;
    const approvedA = await harness.registry.approve(candidateA.candidateId, await issueDurableApproval(harness, candidateA, "a"));
    expect(approvedA).toMatchObject({ alreadyRegistered: false, registryGeneration: 1 });
    expect(approvedA.registration.previousEntryHash).toBeNull();
    const oldRegistryRef = approvedA.registryRef;

    harness.advance();
    const successorGuard: RegistryGuard = {
      expectedPriorRegistrationHash: approvedA.registration.contentHash,
      expectedPriorRegistryRef: approvedA.registryRef,
    };
    const contextB = await createResolvedContext(harness, { label: "b", depthMm: 430, guard: successorGuard });
    const candidateB = await propose(harness, contextB);
    harness.advance();
    const contextConcurrent = await createResolvedContext(harness, { label: "concurrent", depthMm: 440, guard: successorGuard });
    const concurrentCandidate = await propose(harness, contextConcurrent);

    harness.authority.current = contextB;
    const approvedB = await harness.registry.approve(candidateB.candidateId, await issueDurableApproval(harness, candidateB, "b"));
    expect(approvedB).toMatchObject({ alreadyRegistered: false, registryGeneration: 2 });
    expect(approvedB.registration.previousEntryHash).toBe(approvedA.registration.contentHash);
    expect(approvedB.registryRef).not.toBe(oldRegistryRef);

    const current = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      harness.coordinator.activeRoot(await harness.coordinator.readState()),
      (await harness.coordinator.readState()).runtimeGeneration,
    );
    expect(current).toMatchObject({ registryRef: approvedB.registryRef, registryGeneration: 2 });
    expect(current.registryBytes).toBeTypeOf("string");
    expect(current.manifests).toHaveLength(1);
    expect(current.manifests[0]?.contentHash).toBe(candidateB.manifest?.contentHash);
    const oldSnapshot = await loadRuntimeCaseAdapterRegistrySnapshotAtRoot(
      harness.coordinator.activeRoot(await harness.coordinator.readState()),
      oldRegistryRef,
    );
    expect(oldSnapshot).toMatchObject({ registryGeneration: 1, previousRegistryRef: null });
    expect(oldSnapshot?.entries[0]?.candidateId).toBe(candidateA.candidateId);

    harness.authority.current = contextConcurrent;
    const staleProof = await issueDurableApproval(harness, concurrentCandidate, "concurrent");
    const registryWritesBeforeStale = await registryArtifactCount(harness);
    await expect(harness.registry.approve(concurrentCandidate.candidateId, staleProof)).rejects.toThrow(/supersession CAS guard is stale/);
    expect(await registryArtifactCount(harness)).toBe(registryWritesBeforeStale);

    const restartedCoordinator = new RuntimeCoordinator({ root: harness.root, now: harness.now });
    const restartedRegistry = new RuntimeCaseAdapterRegistryRepository(restartedCoordinator, harness.authority, harness.now);
    const restarted = await restartedRegistry.resolve({
      skuId: CATALOG_IDENTITY.skuId,
      region: CATALOG_IDENTITY.region,
      revision: CATALOG_IDENTITY.revision,
    });
    expect(restarted).toMatchObject({ registryRef: approvedB.registryRef, registryGeneration: 2 });
    expect(restarted?.registration.candidateId).toBe(candidateB.candidateId);
  });

  it("keeps an immutable candidate auditable after a legitimate plan edit but rejects approval with zero registry writes", async () => {
    const harness = await createHarness("plan-edit");
    const originalContext = await createResolvedContext(harness, {
      label: "plan-v1",
      depthMm: 420,
      guard: { expectedPriorRegistrationHash: null, expectedPriorRegistryRef: null },
    });
    const candidate = await propose(harness, originalContext);
    const activeRoot = harness.coordinator.activeRoot(await harness.coordinator.readState());
    const replayedBeforeEdit = await readProvisionalCaseAdapterCandidateAtRoot(activeRoot, candidate.candidateId);
    expect(replayedBeforeEdit).toEqual(candidate);

    const editedPlanContext = {
      ...originalContext.planContext,
      planRevision: originalContext.planContext.planRevision + 1,
      configHash: "2".repeat(64),
    };
    harness.authority.current = {
      ...originalContext,
      planContext: editedPlanContext,
      planAuthority: provisionalCaseAdapterPlanAuthorityArtifact(
        editedPlanContext,
        originalContext.planComponent,
        originalContext.catalogIdentity,
        originalContext.identity,
      ),
    };
    const proof = await issueDurableApproval(harness, candidate, "plan-edit-stale");
    const registryWritesBeforeApproval = await registryArtifactCount(harness);
    await expect(harness.registry.approve(candidate.candidateId, proof)).rejects.toThrow(/plan revision\/config\/identity\/evidence replay guard is stale/);
    expect(await registryArtifactCount(harness)).toBe(registryWritesBeforeApproval);

    const replayedAfterEdit = await readProvisionalCaseAdapterCandidateAtRoot(activeRoot, candidate.candidateId);
    expect(replayedAfterEdit).toEqual(candidate);
    expect(replayedAfterEdit?.authorityRefs.planContextArtifactRef).toBe(originalContext.planAuthority.artifactRef);
    const current = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      activeRoot,
      (await harness.coordinator.readState()).runtimeGeneration,
    );
    expect(current).toMatchObject({ registryRef: null, registryBytes: null, registryGeneration: 0, manifests: [] });
  });
});

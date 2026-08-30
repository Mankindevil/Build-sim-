import { createHash } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { agentAuditHash } from "../src/agent/audit";
import type { ProviderAdapter } from "../src/agent/contracts";
import { AgentRuntime } from "../src/agent/runtime";
import { agentRunIdForIdempotency } from "../src/agent/run-identity";
import { AgentSkillLoader } from "../src/agent/skill-loader";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import { AgentWriteApprovalAuthority } from "../src/agent/write-approval-authority";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createEvidenceClaim } from "../src/evidence/claims";
import type { EvidenceCapture, EvidenceClaim, EvidenceDocument } from "../src/evidence/contracts";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import type { FactRecord } from "../src/facts/contracts";
import { factFieldPolicy } from "../src/facts/field-registry";
import { createFactRecord } from "../src/facts/hash";
import { createFactSnapshot } from "../src/facts/snapshots";
import { FileJobRepository } from "../src/jobs/repository";
import { FilePlanAgentContextAuditStore } from "../src/plans/agent-context-audit";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { FileAgentRunAuditStore } from "../src/server/file-audit-store";
import { FileAgentSessionStore } from "../src/server/file-session-store";
import { createAgentServer } from "../src/server/agent-server";
import { createBuildSimTools } from "../src/server/domain-tools";
import {
  ProvisionalCaseAdapterService,
  provisionalCaseAdapterPlanAuthorityArtifact,
  type ProvisionalCaseAdapterCandidate,
  type ResolvedProvisionalCaseAdapterContext,
  type RootBoundProvisionalCaseAdapterAuthority,
} from "../src/adapters/provisional";
import { createProductionProvisionalCaseAdapterActions } from "../src/adapters/provisional-agent-actions";
import {
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
  RuntimeCaseAdapterRegistryRepository,
  loadCurrentRuntimeCaseAdapterManifestsAtRoot,
  provisionalCaseAdapterApprovalInput,
} from "../src/adapters/runtime-registry-repository";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const IDENTITY = Object.freeze({
  brand: "Fixture",
  category: "case",
  skuId: "case.fixture-agent-runtime",
  familyId: "case.fixture-agent-runtime",
  modelId: "fixture-agent-runtime",
  variantId: "fixture.agent-runtime.variant",
  revision: "rev-a",
  region: "global",
} as const);

class FixedCaseAuthority implements RootBoundProvisionalCaseAdapterAuthority {
  readonly authorityKind = "case-adapter-generation-root-bound-v1" as const;

  constructor(readonly context: ResolvedProvisionalCaseAdapterContext) {}

  async resolveProvisionalCaseAdapterContextAtRoot(): Promise<ResolvedProvisionalCaseAdapterContext> {
    return this.context;
  }
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function usage() {
  return {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

async function postJson(server: Server, pathname: string, body: unknown): Promise<{
  status: number;
  payload: Record<string, unknown>;
}> {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const request = Readable.from([bytes]) as unknown as IncomingMessage;
  Object.assign(request, {
    method: "POST",
    url: `/api/agent${pathname}`,
    headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) },
  });
  return new Promise((resolve, reject) => {
    let status = 0;
    const chunks: Buffer[] = [];
    const response = {
      writeHead(nextStatus: number) { status = nextStatus; return response; },
      write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        try {
          resolve({ status, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
        } catch (error) { reject(error); }
        return response;
      },
    } as unknown as ServerResponse;
    server.emit("request", request, response);
  });
}

async function factForClaim(claim: EvidenceClaim, index: number): Promise<FactRecord> {
  const policy = factFieldPolicy(claim.fieldId);
  if (!policy) throw new Error(`fixture fact policy missing for ${claim.fieldId}`);
  return createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: `fact.fixture.agent-runtime.${String(index).padStart(2, "0")}`,
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

async function createCandidateFixture(input: {
  coordinator: RuntimeCoordinator;
  artifacts: FileArtifactRepository;
  evidence: FileEvidenceRepository;
  now: () => string;
}): Promise<{ candidate: ProvisionalCaseAdapterCandidate; authority: FixedCaseAuthority }> {
  const issuedAt = input.now();
  const values: Array<{ fieldId: string; value: unknown; unit?: string }> = [
    { fieldId: "identity.revision", value: IDENTITY.revision },
    { fieldId: "physical.width", value: 240, unit: "mm" },
    { fieldId: "physical.height", value: 480, unit: "mm" },
    { fieldId: "physical.depth", value: 420, unit: "mm" },
    { fieldId: "mount.point_ids", value: ["mount.board.primary"] },
    { fieldId: "case.motherboard_form_factors", value: ["atx"] },
    { fieldId: "io.port_topology", value: {
      endpointId: "front.usb-c",
      connectorType: "usb-c",
      location: "front",
      controllerId: "case.front-io",
      pathId: "case.front-usb-c-path",
      quantity: 1,
    } },
  ];
  const snippets = values.map((item) => `${item.fieldId}=${JSON.stringify(item.value)}${item.unit ? ` ${item.unit}` : ""}`);
  const sourceText = ["Fixture official case specification", ...snippets].join("\n");
  const sourceBytes = Buffer.from(sourceText, "utf8");
  const imported = await input.evidence.importBuffer(sourceBytes, {
    kind: "official-product-page-snapshot",
    mediaType: "text/plain",
    title: "Fixture AgentRuntime case specification",
    createdAt: issuedAt,
    productIdentities: [{
      brand: IDENTITY.brand,
      basis: "official-document-explicit",
      category: "case",
      skuId: IDENTITY.skuId,
      familyId: IDENTITY.familyId,
      modelId: IDENTITY.modelId,
      variantId: IDENTITY.variantId,
      revision: IDENTITY.revision,
      region: IDENTITY.region,
    }],
    capture: {
      acquisitionMethod: "official-fetch",
      kindBasis: "content-verified",
      requestedUrl: "https://fixture.example/agent-runtime-case",
      finalUrl: "https://fixture.example/agent-runtime-case",
      canonicalUrl: "https://fixture.example/agent-runtime-case",
      retrievedAt: issuedAt,
      status: 200,
      redirects: [],
      officialBrand: IDENTITY.brand,
    },
  }) as { document: EvidenceDocument; capture: EvidenceCapture };

  const locatorArtifactBytes = Buffer.from(JSON.stringify({
    schemaVersion: "case-adapter-locator-artifact-v1",
    documentId: imported.document.id,
    documentSha256: imported.document.sha256,
    sourceByteLength: imported.document.byteLength,
    pages: [{ page: 1, text: sourceText }],
  }), "utf8");
  const locator = await input.artifacts.put({
    bytes: locatorArtifactBytes,
    mediaType: "application/vnd.buildsim.case-adapter-locator+json",
    privacyClass: "runtime_internal",
    kind: "case-adapter-evidence-locator",
    references: [],
    createdAt: issuedAt,
  });
  const generationJobId = `job-${createHash("sha256").update("agent-runtime-case-generation").digest("hex")}` as const;
  const generationAttempt = await input.artifacts.put({
    bytes: Buffer.from(JSON.stringify({
      schemaVersion: "evidence-stage-attempt-v1",
      pipelineId: `evidence-pipeline-sha256-${"a".repeat(64)}`,
      stage: "adapter_generation",
      jobId: generationJobId,
      attemptStartedAt: issuedAt,
      inputRefs: [],
    }), "utf8"),
    mediaType: "application/vnd.buildsim.evidence-stage-attempt+json",
    privacyClass: "runtime_internal",
    kind: "evidence-stage-attempt",
    references: [],
    createdAt: issuedAt,
  });

  const claims = await Promise.all(values.map((item, index) => createEvidenceClaim({
    schemaVersion: "evidence-claim-v1",
    subject: {
      skuId: IDENTITY.skuId,
      familyId: IDENTITY.familyId,
      modelId: IDENTITY.modelId,
      variantId: IDENTITY.variantId,
      revision: IDENTITY.revision,
      region: IDENTITY.region,
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
      locator: { page: 1, field: `fixture-field-${index}`, snippet: snippets[index]! },
    },
    retrievedAt: issuedAt,
    status: "active",
  })));
  const facts = await Promise.all(claims.map(factForClaim));
  const snapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash })),
    conflictRefs: [],
    createdAt: issuedAt,
  });
  const revisionFact = facts.find((fact) => fact.field === "identity.revision");
  if (!revisionFact) throw new Error("fixture identity fact is missing");
  const planContext = {
    planId: "plan-agent-runtime-provisional-case",
    caseComponentInstanceId: "case-agent-runtime-unlisted",
    planRevision: 0,
    configHash: "1".repeat(64),
  };
  const caseIdentity = {
    skuId: IDENTITY.skuId,
    region: IDENTITY.region,
    revision: IDENTITY.revision,
    identityFactIds: [revisionFact.factId],
  };
  const planComponent = {
    instanceId: planContext.caseComponentInstanceId,
    kind: "case" as const,
    role: "case",
    state: "planned" as const,
    identity: {
      status: "resolved" as const,
      skuId: IDENTITY.skuId,
      identityClaimIds: [claims[0]!.claimId],
    },
    source: "agent" as const,
  };
  const context: ResolvedProvisionalCaseAdapterContext = {
    schemaVersion: "resolved-provisional-case-adapter-context-v1",
    planContext,
    planComponent,
    planAuthority: provisionalCaseAdapterPlanAuthorityArtifact(planContext, planComponent, IDENTITY, caseIdentity),
    registryGuard: { expectedPriorRegistrationHash: null, expectedPriorRegistryRef: null },
    generationJob: {
      jobId: generationJobId,
      resultRef: generationAttempt.record.ref,
      attemptStartedAt: issuedAt,
    },
    catalogIdentity: structuredClone(IDENTITY),
    identity: caseIdentity,
    factClosure: { snapshot, facts, conflicts: [], evidenceClaims: claims },
    evidenceSources: [{
      document: imported.document,
      capture: imported.capture,
      bytes: sourceBytes,
      locatorArtifactRef: locator.record.ref,
      locatorArtifactBytes,
    }],
  };
  const authority = new FixedCaseAuthority(context);
  const state = await input.coordinator.readState();
  const candidate = await new ProvisionalCaseAdapterService(input.coordinator, authority).proposeAtRoot({
    planId: planContext.planId,
    caseComponentInstanceId: planContext.caseComponentInstanceId,
    expectedRuntimeGeneration: state.runtimeGeneration,
    expectedRuntimeRevision: state.revision,
  });
  return { candidate, authority };
}

describe("provisional case adapter real AgentRuntime approval", () => {
  it("keeps the rollout-off Tool absent and the immutable registry empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-provisional-agent-off-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    await coordinator.initialize("provisional-agent-off");
    const registry = new AgentToolRegistry(createBuildSimTools({ provisionalCaseAdapterToolEnabled: false }));
    expect(registry.names()).not.toContain(REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME);

    const state = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(state);
    await expect(loadCurrentRuntimeCaseAdapterManifestsAtRoot(activeRoot, state.runtimeGeneration)).resolves.toMatchObject({
      registryRef: null,
      registryGeneration: 0,
      manifests: [],
    });
    const artifacts = new FileArtifactRepository({ coordinator });
    await artifacts.initialize();
    expect((await artifacts.list()).records.filter((record: { kind: string }) => record.kind === "runtime-case-adapter-registry-snapshot"))
      .toHaveLength(0);
  });

  it("pauses, confirms through HTTP, registers once, and resolves after repository restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-provisional-agent-on-"));
    roots.push(root);
    const now = () => new Date().toISOString();
    const coordinator = new RuntimeCoordinator({ root, now });
    await coordinator.initialize("provisional-agent-on");
    const artifacts = new FileArtifactRepository({ coordinator, now });
    await artifacts.initialize();
    const evidence = new FileEvidenceRepository({ coordinator, now });
    const jobs = new FileJobRepository({ coordinator, now, leaseDurationMs: 60_000 });
    const { candidate, authority } = await createCandidateFixture({ coordinator, artifacts, evidence, now });
    expect(candidate).toMatchObject({ status: "ready_for_review", manifest: { identity: {
      skuId: IDENTITY.skuId,
      region: IDENTITY.region,
      revision: IDENTITY.revision,
    } } });

    const actions = createProductionProvisionalCaseAdapterActions({ coordinator, authority, now });
    const toolRegistry = new AgentToolRegistry(createBuildSimTools({
      provisionalCaseAdapterActions: actions,
      provisionalCaseAdapterToolEnabled: true,
    }));
    expect(toolRegistry.names()).toContain(REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME);
    expect(toolRegistry.definitionHash(REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME))
      .toBe(REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH);

    const approvalInput = provisionalCaseAdapterApprovalInput(candidate);
    let providerTurns = 0;
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{
        provider: "deepseek",
        id: "provisional-case-agent-fixture",
        label: "provisional case Agent fixture",
        capabilities: { streaming: true, tools: true, parallelTools: false, structuredOutput: true, thinking: false },
      }],
      async createTurn(request) {
        providerTurns += 1;
        if (!request.messages.some((message) => message.role === "tool")) {
          expect(request.tools.map((tool) => tool.name)).toContain(REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME);
          return {
            provider: "deepseek",
            providerRequestId: "provisional-case-turn-1",
            model: request.model,
            content: "",
            toolCalls: [{
              id: "call-register-provisional-case",
              name: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
              input: approvalInput,
            }],
            stopReason: "tool_use",
            usage: usage(),
            latencyMs: 1,
          };
        }
        return {
          provider: "deepseek",
          providerRequestId: "provisional-case-turn-2",
          model: request.model,
          content: "临时机箱适配器已通过人工审批并注册。",
          toolCalls: [],
          stopReason: "end_turn",
          usage: usage(),
          latencyMs: 1,
        };
      },
    };
    let idSequence = 0;
    const writeApprovalAuthority = new AgentWriteApprovalAuthority(artifacts, {
      jobs,
      now,
      token: () => "2".repeat(64),
    });
    const runtime = new AgentRuntime([provider], new FileAgentSessionStore({ coordinator, now }), {
      now,
      id: () => String(++idSequence).padStart(8, "0"),
      toolRegistry,
      skillLoader: new AgentSkillLoader(path.resolve("skills"), toolRegistry),
      auditStore: new FileAgentRunAuditStore({ coordinator, now }),
      writeApprovalAuthority,
      durableJobs: { repository: jobs, artifacts, workerId: "provisional-case-agent-runtime" },
    });
    await runtime.initializeDurableRuns();
    const server = createAgentServer({ runtime });
    const session = await runtime.createSession({ provider: "deepseek", model: "provisional-case-agent-fixture" });
    const idempotencyKey = "provisional-case-agent-e2e";
    const runId = agentRunIdForIdempotency(session.id, idempotencyKey);
    const planAuditStore = new FilePlanAgentContextAuditStore({ coordinator });
    const lease = await coordinator.acquireMaintenanceLease("provisional-case-agent-context");
    await planAuditStore.putWithMaintenanceLease({
      schemaVersion: "1.0.0",
      sessionId: session.id,
      runId,
      planId: candidate.planContext.planId,
      planVersionId: null,
      draftRevision: candidate.planContext.planRevision,
      configHash: candidate.planContext.configHash,
      evaluationHash: "e".repeat(64),
      spatialSelection: null,
      contextHash: agentAuditHash({ runId, candidateId: candidate.candidateId }),
      recordedAt: now(),
    }, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);

    await runtime.startRun(session.id, {
      content: "审查并注册这个服务端生成的临时机箱适配器。",
      skillId: "evidence-and-attachments",
      idempotencyKey,
    });
    await runtime.waitForRun(runId);
    const pendingState = await runtime.getRunState(runId);
    expect(pendingState).toMatchObject({ status: "waiting_approval", durableStatus: "waiting_user" });
    expect(pendingState.pendingApproval?.call).toEqual({
      id: "call-register-provisional-case",
      name: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
      input: approvalInput,
    });
    let state = await coordinator.readState();
    await expect(loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      coordinator.activeRoot(state),
      state.runtimeGeneration,
    )).resolves.toMatchObject({ registryRef: null, registryGeneration: 0, manifests: [] });

    const pending = pendingState.pendingApproval!;
    const confirmed = await postJson(
      server,
      `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(pending.approvalId)}/confirm`,
      { nonce: pending.nonce, approvedBy: "human-provisional-reviewer" },
    );
    expect(confirmed).toMatchObject({ status: 202, payload: { runId, approvalId: pending.approvalId, status: "queued" } });
    await runtime.waitForRun(runId);
    expect(await runtime.getRunState(runId)).toMatchObject({ status: "completed", durableStatus: "succeeded" });
    expect(providerTurns).toBe(2);
    const toolResult = runtime.getRun(runId).events.find((event) => event.type === "tool_result");
    if (toolResult?.type === "tool_result" && !toolResult.result.ok) {
      throw new Error(`provisional case Tool failed: ${JSON.stringify(toolResult.result)}`);
    }
    expect(toolResult).toMatchObject({ type: "tool_result", toolName: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME, result: { ok: true } });

    state = await coordinator.readState();
    const current = await loadCurrentRuntimeCaseAdapterManifestsAtRoot(
      coordinator.activeRoot(state),
      state.runtimeGeneration,
    );
    expect(current).toMatchObject({ registryGeneration: 1, manifests: [{ contentHash: candidate.manifest!.contentHash }] });
    expect(current.registryRef).toMatch(/^sha256:[a-f0-9]{64}$/);

    const restartedCoordinator = new RuntimeCoordinator({ root, now });
    const restartedRepository = new RuntimeCaseAdapterRegistryRepository(restartedCoordinator, authority, now);
    await expect(restartedRepository.resolve({
      skuId: IDENTITY.skuId,
      region: IDENTITY.region,
      revision: IDENTITY.revision,
    })).resolves.toMatchObject({
      registryRef: current.registryRef,
      registryGeneration: 1,
      registration: { candidateId: candidate.candidateId },
      manifest: { contentHash: candidate.manifest!.contentHash },
    });
  });
});

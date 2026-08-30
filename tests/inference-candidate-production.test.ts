import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_CONTRACT_VERSION,
  type AgentToolContext,
  type AgentWriteApprovalEnvelope,
  type ProviderAdapter,
  type ProviderTurnRequest,
} from "../src/agent/contracts";
import { agentAuditHash, sealAgentRunAudit } from "../src/agent/audit";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentSkillLoader } from "../src/agent/skill-loader";
import { MemoryAgentSessionStore } from "../src/agent/session-store";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import { AgentWriteApprovalAuthority } from "../src/agent/write-approval-authority";
import { createBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { createProductionGovernedAgentActions } from "../src/attachments/production-actions";
import { EvidenceClaimRepository } from "../src/evidence/claim-repository";
import { createEvidenceClaim } from "../src/evidence/claims";
import type { EvidenceClaim } from "../src/evidence/contracts";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { createProductionEvidenceJobRuntime } from "../src/evidence/jobs/production";
import { createOfficialDocumentIdentityConfirmation } from "../src/evidence/ladder.mjs";
import { canFactAloneSupportSafetyPass, type FactRecord, type FactSubject } from "../src/facts/contracts";
import { factFieldPolicy } from "../src/facts/field-registry";
import { createFactRecord } from "../src/facts/hash";
import {
  ProductionInferenceRuleRegistry,
  createFilePlanInferenceAuthority,
  inferenceProductionEnabled,
} from "../src/facts/inference-production";
import {
  InferenceCandidateRepository,
} from "../src/facts/inference-candidate-repository";
import {
  BUILTIN_INFERENCE_RULE_IDS,
  InferenceCandidateService,
  ensureBuiltinInferenceRuleRegistrations,
  inferenceRuleImplementationArtifactInput,
  inferenceRuleArtifactInput,
  type GovernedInferenceRuleExecutionContext,
  type GovernedInferenceRuleExecutionResult,
  type GovernedInferenceRuleRegistration,
  type InferencePlanAuthority,
} from "../src/facts/inference-candidate-service";
import {
  inferenceCandidateReferencesRuntime,
  validateFactInferenceCandidateRuntime,
  type GovernedInferenceRuleArtifact,
} from "../src/facts/inference-candidate-runtime.mjs";
import { FactRepository, type FactRepositoryOptions } from "../src/facts/repository";
import { factSubjectKey } from "../src/facts/resolver";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanAgentContextAuditStore } from "../src/plans/agent-context-audit";
import { hashPlanConfig, sha256Hex } from "../src/plans/canonical";
import { createPlanAgentContext, planAgentContextEnvelope } from "../src/agent/plan-context";
import { evaluateBuild } from "../src/core/evaluate";
import { FilePlanRepository } from "../src/plans/file-repository";
import { runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { FileJobRepository, type ClaimedBackgroundJob } from "../src/jobs";
import { atomicWriteJson, confined, readJson, sha256Bytes, sha256Json } from "../src/runtime/fs.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { createReferenceGraphAtSnapshot, verifyReferenceGraph } from "../src/runtime/reference-graph.mjs";
import { createBuildSimTools } from "../src/server/domain-tools";
import { createWorkspaceRepositories } from "../src/server/workspace-server";
import { FileAgentSessionStore } from "../src/server/file-session-store";
import { FileAgentRunAuditStore } from "../src/server/file-audit-store";
import { loadMergedCatalogSync } from "../scripts/price-server/catalog/repository.mjs";

const NOW = "2026-08-28T00:00:00.000Z";
const roots: string[] = [];
const digest = (letter: string): string => letter.repeat(64);
const PLAN_ID = "plan-inference-production";
const PLAN_CONFIG_HASH = digest("9");
const RULE_ID = "clearance.from-width";
const IMPLEMENTATION_ID = "builtin.clearance-from-width.v1";

const productSubject = Object.freeze({
  kind: "product" as const,
  skuId: "case.inference.example",
  familyId: "case.inference.family",
  modelId: "case-inference-model",
  variantId: "case-inference-variant",
  revision: "A",
  region: "CN",
});

const executeWidthClearance = (
  { planId, rule: governedRule, currentFacts }: GovernedInferenceRuleExecutionContext,
): GovernedInferenceRuleExecutionResult => {
  const input = currentFacts.find((fact) => fact.field === "physical.width");
  if (!input || typeof input.value !== "number") throw new Error("governed width fact unavailable");
  const parameters = governedRule.parameters as { serviceMarginMm: number; uncertaintyMm: number };
  const value = input.value - parameters.serviceMarginMm;
  return {
    inputFactIds: [input.factId],
    subject: { kind: "plan_subject" as const, planId, subjectRef: { kind: "placement" as const, placementId: "case-width-envelope" } },
    scope: "plan_subject" as const,
    value,
    unit: "mm",
    outputRange: { min: value - parameters.uncertaintyMm, max: value + parameters.uncertaintyMm, unit: "mm" },
  };
};

const WIDTH_IMPLEMENTATION_HASH = sha256Bytes(Buffer.from(Function.prototype.toString.call(executeWidthClearance), "utf8"));

const rule = Object.freeze({
  schemaVersion: "governed-inference-rule-v1" as const,
  ruleId: RULE_ID,
  ruleVersion: "1.0.0",
  implementationId: IMPLEMENTATION_ID,
  implementationHash: WIDTH_IMPLEMENTATION_HASH,
  engine: "rule" as const,
  targetFieldId: "physical.clearance",
  inputFieldIds: Object.freeze(["physical.width"]),
  formula: "clearance_mm = physical.width - service_margin_mm",
  parameters: Object.freeze({ serviceMarginMm: 10, uncertaintyMm: 2 }),
  assumptions: Object.freeze(["case width and placement datum share the governed reference plane"]),
  confidence: 0.72,
  invalidationConditions: Object.freeze([
    "input_fact_hash_changed",
    "plan_revision_changed",
    "rule_artifact_changed",
  ]),
}) satisfies GovernedInferenceRuleArtifact;

type ProductFactSubject = Extract<FactSubject, { kind: "product" }>;

async function sourceClaim(
  width: number,
  hashLetter: string,
  subject: ProductFactSubject = productSubject,
  fieldId = "physical.width",
): Promise<EvidenceClaim> {
  return createEvidenceClaim({
    schemaVersion: "evidence-claim-v1",
    subject: {
      skuId: subject.skuId,
      familyId: subject.familyId ?? subject.skuId,
      ...(subject.modelId === undefined ? {} : { modelId: subject.modelId }),
      ...(subject.variantId === undefined ? {} : { variantId: subject.variantId }),
      ...(subject.revision === undefined ? {} : { revision: subject.revision }),
      ...(subject.region === undefined ? {} : { region: subject.region }),
    },
    scope: "revision",
    fieldId,
    value: width,
    unit: "mm",
    authority: "official",
    source: {
      documentId: `doc-sha256-${digest(hashLetter)}`,
      documentSha256: digest(hashLetter),
      captureId: `capture-sha256-${digest(hashLetter === "a" ? "b" : "d")}`,
      locator: { page: 1, section: "Dimensions" },
    },
    retrievedAt: NOW,
    status: "active",
  });
}

async function sourceFact(
  id: string,
  claim: EvidenceClaim,
  supersedes?: FactRecord,
  subject: ProductFactSubject = productSubject,
  fieldId = claim.fieldId,
): Promise<FactRecord> {
  const policy = factFieldPolicy(fieldId);
  if (!policy) throw new Error("numeric fact policy missing");
  return createFactRecord({
    schemaVersion: "fact-record-v1",
    factId: id,
    subject,
    field: fieldId,
    value: claim.value,
    unit: "mm",
    scope: claim.scope,
    authority: "official",
    safetyClass: policy.safetyClass,
    status: "active",
    evidenceRefs: [claim.claimId],
    derivedFromFactIds: [],
    confidence: 1,
    retrievedAt: NOW,
    ...(supersedes ? { supersedesFactId: supersedes.factId, supersededFactHash: supersedes.contentHash } : {}),
  });
}

interface Harness {
  root: string;
  coordinator: RuntimeCoordinator;
  artifacts: FileArtifactRepository;
  facts: FactRepository;
  candidates: InferenceCandidateRepository;
  service: InferenceCandidateService;
  claims: Map<string, EvidenceClaim>;
  registration: GovernedInferenceRuleRegistration;
  initialFact: FactRecord;
  planAuthority: InferencePlanAuthority;
  factOptions: FactRepositoryOptions;
  approvalAuthority: {
    capability: object;
    service: InferenceCandidateService | null;
  };
  planState: { draftRevision: number; configHash: string };
  currentArtifactHashes: Map<string, string>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-inference-candidate-"));
  roots.push(root);
  const coordinator = new RuntimeCoordinator({ root, now: () => NOW });
  await coordinator.initialize("inference-candidate-production-test");
  const artifacts = new FileArtifactRepository({ coordinator, now: () => NOW });
  await artifacts.initialize();
  const claims = new Map<string, EvidenceClaim>();
  const lookup = {
    getClaim: async (claimId: string) => structuredClone(claims.get(claimId) ?? null),
    getClaimAtRoot: async (_activeRoot: string, claimId: string) => structuredClone(claims.get(claimId) ?? null),
  };
  const currentArtifactHashes = new Map<string, string>();
  const approvalAuthority: Harness["approvalAuthority"] = {
    capability: Object.freeze({ kind: "test-inference-approval" }),
    service: null,
  };
  const factOptions: FactRepositoryOptions = {
    coordinator,
    evidenceClaims: lookup,
    now: () => NOW,
    currentInferenceArtifactHash: async (trace) => currentArtifactHashes.get(trace.ruleOrModelId) ?? null,
    inferenceCandidateApprovalAuthority: {
      approvalCapability: approvalAuthority.capability,
      async resolveForApprovalAtRoot(activeRoot, runtimeGeneration, candidateId, expectedCandidateHash) {
        if (!approvalAuthority.service) throw new Error("test inference approval service unavailable");
        return approvalAuthority.service.resolveForRepositoryApprovalAtRoot(
          activeRoot,
          runtimeGeneration,
          candidateId,
          expectedCandidateHash,
        );
      },
      async resolveCurrentFactAtRoot(activeRoot, runtimeGeneration, candidateId, expectedCandidateHash, currentFacts) {
        if (!approvalAuthority.service) return null;
        return approvalAuthority.service.resolveCurrentFactAtRoot(
          activeRoot,
          runtimeGeneration,
          candidateId,
          expectedCandidateHash,
          currentFacts,
        );
      },
    },
  };
  const facts = new FactRepository(factOptions);
  const initialClaim = await sourceClaim(200, "a");
  claims.set(initialClaim.claimId, initialClaim);
  const initialFact = await sourceFact("fact-width-a", initialClaim);
  await facts.putFact({ fact: initialFact });
  const storedImplementation = await artifacts.put(inferenceRuleImplementationArtifactInput(executeWidthClearance, NOW));
  if (storedImplementation.record.sha256 !== rule.implementationHash) throw new Error("test inference implementation hash drifted");
  const storedRule = await artifacts.put(inferenceRuleArtifactInput(rule, NOW));
  currentArtifactHashes.set(RULE_ID, storedRule.record.sha256);
  const registration: GovernedInferenceRuleRegistration = Object.freeze({
    ruleId: RULE_ID,
    implementationId: IMPLEMENTATION_ID,
    implementationHash: rule.implementationHash,
    artifactRef: storedRule.record.ref as `sha256:${string}`,
    execute: executeWidthClearance,
  });
  const planState = { draftRevision: 3, configHash: PLAN_CONFIG_HASH };
  const planAuthority: InferencePlanAuthority = Object.freeze({
    resolveAtRoot: async (
      _activeRoot: string,
      planId: string,
      currentFacts: readonly Readonly<FactRecord>[],
    ) => {
      if (planId !== PLAN_ID) throw new Error("plan missing");
      return {
        planDraftRevision: planState.draftRevision,
        planConfigHash: planState.configHash,
        relevantFactIds: currentFacts.filter((fact) => ["physical.width", "physical.clearance"].includes(fact.field))
          .map(({ factId }) => factId),
        relevantProductSubjectKeys: [factSubjectKey(productSubject)],
      };
    },
  });
  const candidates = new InferenceCandidateRepository(coordinator);
  const service = new InferenceCandidateService({
    coordinator, artifacts, facts, candidates, planAuthority, rules: [registration], now: () => NOW,
  });
  approvalAuthority.service = service;
  return {
    root,
    coordinator,
    artifacts,
    facts,
    candidates,
    service,
    claims,
    registration,
    initialFact,
    planAuthority,
    factOptions,
    approvalAuthority,
    planState,
    currentArtifactHashes,
  };
}

async function guardedInput(coordinator: RuntimeCoordinator, overrides: Record<string, unknown> = {}) {
  const state = await coordinator.readState();
  return {
    planId: PLAN_ID,
    ruleId: RULE_ID,
    target: { fieldId: "physical.clearance" },
    guard: { runtimeGeneration: state.runtimeGeneration, runtimeRevision: state.revision, planDraftRevision: 3 },
    ...overrides,
  };
}

let approvalSequence = 0;
function approvedContext(
  registry: AgentToolRegistry,
  toolName: string,
  input: unknown,
  sessionId = "session-inference-production",
  runId = "run-inference-production",
): AgentToolContext {
  approvalSequence += 1;
  const approval: AgentWriteApprovalEnvelope = {
    contractVersion: AGENT_CONTRACT_VERSION,
    approvalId: `approval-inference-${approvalSequence}`,
    toolName,
    toolDefinitionHash: registry.definitionHash(toolName),
    sessionId,
    runId,
    inputHash: agentAuditHash(input),
    idempotencyKey: `inference-tool-${approvalSequence}`,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    approvedBy: "human-inference-reviewer",
    approvalToken: "out-of-band-inference-approval-token-000000000000000000",
    backup: { required: true, target: "runtime/facts/inference" },
    rollback: { required: true, strategy: "disable inference and retain immutable history" },
  };
  return {
    sessionId,
    runId,
    buildConfig: null,
    signal: new AbortController().signal,
    approval,
  };
}

function officialInferenceMetadata(subject: ProductFactSubject, category: "case" | "gpu", suffix: string) {
  return {
    mediaType: "application/pdf",
    kind: "manufacturer-manual",
    title: `${subject.skuId} governed dimensions`,
    productIdentities: [{
      brand: "Inference Fixture",
      model: subject.modelId ?? subject.skuId,
      category,
      skuId: subject.skuId,
      basis: "official-document-explicit",
      familyId: subject.familyId ?? subject.skuId,
      ...(subject.modelId === undefined ? {} : { modelId: subject.modelId }),
      ...(subject.variantId === undefined ? {} : { variantId: subject.variantId }),
      ...(subject.revision === undefined ? {} : { revision: subject.revision }),
      ...(subject.region === undefined ? {} : { region: subject.region }),
    }],
    capture: {
      acquisitionMethod: "official-fetch",
      requestedUrl: `https://example.com/${suffix}`,
      finalUrl: `https://example.com/${suffix}.pdf`,
      canonicalUrl: `https://example.com/${suffix}.pdf`,
      retrievedAt: NOW,
      status: 200,
      redirects: [],
      officialBrand: "Inference Fixture",
    },
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("production inference candidate core", () => {
  it("keeps production inference independently gated off unless both strict flags are enabled", async () => {
    expect(inferenceProductionEnabled({})).toBe(false);
    expect(inferenceProductionEnabled({ BUILD_SIM_FACT_GRAPH_ENABLED: "true" })).toBe(false);
    expect(inferenceProductionEnabled({ BUILD_SIM_AGENT_INFERENCE_ENABLED: "true" })).toBe(false);
    expect(inferenceProductionEnabled({
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "true",
    })).toBe(true);
    expect(() => inferenceProductionEnabled({ BUILD_SIM_AGENT_INFERENCE_ENABLED: "sometimes" })).toThrow(/must be true or false/);

    const runtime = await harness();
    const candidate = await runtime.service.propose(await guardedInput(runtime.coordinator));
    const committed = await runtime.facts.putInferenceCandidateApproval({
      candidateId: candidate.candidateId,
      expectedCandidateHash: candidate.contentHash,
      approvalCapability: runtime.approvalAuthority.capability,
    });
    const before = await runtime.artifacts.list();
    const disabled = new ProductionInferenceRuleRegistry({
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "false",
    });
    await expect(disabled.initialize(runtime.artifacts, () => NOW)).resolves.toEqual([]);
    expect((await runtime.artifacts.list()).manifest).toEqual(before.manifest);
    await expect(disabled.createService(runtime.artifacts, {
      coordinator: runtime.coordinator,
      facts: runtime.facts,
      candidates: runtime.candidates,
      planAuthority: runtime.planAuthority,
      now: () => NOW,
    })).rejects.toMatchObject({ code: "invalid_input" });
    // Rollback is non-destructive: historical authorities remain readable.
    await expect(runtime.candidates.get(candidate.candidateId)).resolves.toEqual(candidate);
    await expect(runtime.facts.getFact(committed.fact.factId)).resolves.toEqual(committed.fact);
  });

  it("accepts only server-resolved rule inputs and creates a replayable inactive critical candidate", async () => {
    const runtime = await harness();
    const before = await runtime.coordinator.readState();
    await expect(runtime.service.propose({
      ...await guardedInput(runtime.coordinator),
      facts: [runtime.initialFact],
      formula: "caller supplied",
      artifactHash: digest("f"),
      value: 999,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await runtime.coordinator.readState()).toEqual(before);
    expect(await runtime.candidates.list()).toEqual([]);

    const candidate = await runtime.service.propose(await guardedInput(runtime.coordinator));
    expect(validateFactInferenceCandidateRuntime(candidate)).toEqual([]);
    expect(candidate).toMatchObject({
      candidateStatus: "pending_approval",
      maySupportSafetyPass: false,
      safetyDisposition: "blocked_requires_non_inference_evidence",
      rule: {
        formula: rule.formula,
        parameters: rule.parameters,
        assumptions: rule.assumptions,
        invalidationConditions: rule.invalidationConditions,
      },
      trace: {
        inputFactRefs: [{ factId: runtime.initialFact.factId, contentHash: runtime.initialFact.contentHash }],
        outputRange: { min: 188, max: 192, unit: "mm" },
      },
      proposedFact: {
        authority: "agent_inference",
        field: "physical.clearance",
        value: 190,
        unit: "mm",
        safetyClass: "compatibility_critical",
      },
    });
    expect(candidate.trace.outputFactIds).toEqual([candidate.proposedFact.factId]);
    expect(canFactAloneSupportSafetyPass(candidate.proposedFact)).toBe(false);
    expect(inferenceCandidateReferencesRuntime(candidate)).toEqual([
      { ref: `plan:${PLAN_ID}`, necessity: "required_for_replay" },
      { ref: runtime.registration.artifactRef, necessity: "required_for_replay" },
      { ref: `fact:${runtime.initialFact.factId}`, necessity: "required_for_replay" },
    ]);

    const restarted = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: runtime.facts,
      candidates: new InferenceCandidateRepository(runtime.coordinator),
      planAuthority: runtime.planAuthority,
      rules: [runtime.registration],
      now: () => NOW,
    });
    await expect(restarted.replay(candidate.candidateId, PLAN_ID)).resolves.toEqual(candidate);
    await expect(restarted.resolveForApproval(candidate.candidateId, PLAN_ID)).resolves.toMatchObject({
      candidate: { candidateId: candidate.candidateId, maySupportSafetyPass: false },
      trace: { inferenceTraceId: candidate.trace.inferenceTraceId },
      proposedFact: { factId: candidate.proposedFact.factId, authority: "agent_inference" },
      ruleArtifactRef: runtime.registration.artifactRef,
    });
  });

  it("rejects every direct trace/fact and forged approval-capability bypass with zero authority writes", async () => {
    const runtime = await harness();
    const candidate = await runtime.service.propose(await guardedInput(runtime.coordinator));
    const state = await runtime.coordinator.readState();
    const activeRoot = runtime.coordinator.activeRoot(state);
    const before = await runtime.facts.snapshotReferences(activeRoot);

    await expect(runtime.facts.putInferenceFactWithTrace({
      trace: candidate.trace,
      fact: candidate.proposedFact,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runtime.facts.putInferenceFactWithTraceAtRoot(activeRoot, {
      trace: candidate.trace,
      fact: candidate.proposedFact,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runtime.facts.putInferenceCandidateApproval({
      candidateId: candidate.candidateId,
      expectedCandidateHash: candidate.contentHash,
      approvalCapability: undefined as unknown as object,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runtime.facts.putInferenceCandidateApprovalAtRoot(activeRoot, state.runtimeGeneration, {
      candidateId: candidate.candidateId,
      expectedCandidateHash: candidate.contentHash,
      approvalCapability: Object.freeze({ forged: true }),
    })).rejects.toMatchObject({ code: "invalid_input" });

    expect(await runtime.facts.snapshotReferences(activeRoot)).toEqual(before);
    await expect(runtime.facts.getInferenceTrace(candidate.trace.inferenceTraceId))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(runtime.facts.getFact(candidate.proposedFact.factId))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("marks a candidate stale when an input fact is replaced and replays its replacement", async () => {
    const runtime = await harness();
    const first = await runtime.service.propose(await guardedInput(runtime.coordinator));
    const replacementClaim = await sourceClaim(210, "c");
    runtime.claims.set(replacementClaim.claimId, replacementClaim);
    const replacement = await sourceFact("fact-width-b", replacementClaim, runtime.initialFact);
    await runtime.facts.putFact({ fact: replacement });

    await expect(runtime.service.assessCurrent(first.candidateId, PLAN_ID)).resolves.toMatchObject({
      status: "stale",
      reasons: ["authority_or_input_changed"],
    });
    await expect(runtime.service.resolveForApproval(first.candidateId, PLAN_ID)).rejects.toMatchObject({ code: "stale" });
    const current = await runtime.service.propose(await guardedInput(runtime.coordinator));
    expect(current.trace.inputFactRefs).toEqual([{ factId: replacement.factId, contentHash: replacement.contentHash }]);
    expect(current.proposedFact.value).toBe(200);
    await expect(runtime.service.replay(current.candidateId, PLAN_ID)).resolves.toEqual(current);
  });

  it("installs a usable built-in rule bound to executable bytes and invalidates it when those bytes change", async () => {
    const runtime = await harness();
    const caseSubject: ProductFactSubject = Object.freeze({
      ...productSubject,
      skuId: "case.gpu-clearance.example",
      familyId: "case.gpu-clearance.family",
      modelId: "case-gpu-clearance-model",
      variantId: "case-gpu-clearance-variant",
    });
    const gpuSubject: ProductFactSubject = Object.freeze({
      ...productSubject,
      skuId: "gpu.length.example",
      familyId: "gpu.length.family",
      modelId: "gpu-length-model",
      variantId: "gpu-length-variant",
    });
    const caseClaim = await sourceClaim(330, "e", caseSubject, "case.gpu_max_length");
    const gpuClaim = await sourceClaim(300, "f", gpuSubject, "gpu.length");
    runtime.claims.set(caseClaim.claimId, caseClaim);
    runtime.claims.set(gpuClaim.claimId, gpuClaim);
    const caseFact = await sourceFact("fact-case-gpu-max-length", caseClaim, undefined, caseSubject);
    const gpuFact = await sourceFact("fact-gpu-length", gpuClaim, undefined, gpuSubject);
    await runtime.facts.putFact({ fact: caseFact });
    await runtime.facts.putFact({ fact: gpuFact });

    const [registration] = await ensureBuiltinInferenceRuleRegistrations(runtime.artifacts, () => NOW);
    if (!registration) throw new Error("built-in inference registration missing");
    expect(registration.ruleId).toBe(BUILTIN_INFERENCE_RULE_IDS.GPU_LENGTH_CLEARANCE);
    const state = await runtime.coordinator.readState();
    const artifactRoot = await runtime.artifacts.repositoryRoot(runtime.coordinator.activeRoot(state));
    const stored = await runtime.artifacts.getAt(artifactRoot, registration.artifactRef, { initialize: false });
    const governedRule = JSON.parse(Buffer.from(stored!.bytes).toString("utf8")) as GovernedInferenceRuleArtifact;
    expect(governedRule.implementationHash).toBe(registration.implementationHash);
    expect(validateFactInferenceCandidateRuntime).toBeTypeOf("function");

    let currentArtifactHash = registration.artifactRef.slice("sha256:".length);
    const builtinFacts = new FactRepository({
      ...runtime.factOptions,
      currentInferenceArtifactHash: async (trace) => trace.ruleOrModelId === registration.ruleId ? currentArtifactHash : null,
    });
    const planAuthority: InferencePlanAuthority = Object.freeze({
      resolveAtRoot: async (_activeRoot: string, planId: string, currentFacts: readonly Readonly<FactRecord>[]) => ({
        planDraftRevision: 3,
        planConfigHash: PLAN_CONFIG_HASH,
        relevantFactIds: currentFacts
          .filter((fact) => ["case.gpu_max_length", "gpu.length"].includes(fact.field))
          .map(({ factId }) => factId),
        relevantProductSubjectKeys: [factSubjectKey(caseSubject), factSubjectKey(gpuSubject)],
      }),
    });
    const service = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: builtinFacts,
      candidates: runtime.candidates,
      planAuthority,
      rules: [registration],
      now: () => NOW,
    });
    const candidate = await service.propose({
      ...await guardedInput(runtime.coordinator),
      ruleId: registration.ruleId,
    });
    expect(candidate.proposedFact).toMatchObject({ value: 30, unit: "mm", authority: "agent_inference" });
    expect(candidate.rule.implementationHash).toBe(registration.implementationHash);
    expect(candidate.trace.inputFactRefs.map(({ factId }) => factId).sort()).toEqual([caseFact.factId, gpuFact.factId].sort());

    const [sameAfterRestart] = await ensureBuiltinInferenceRuleRegistrations(runtime.artifacts, () => NOW);
    expect(sameAfterRestart).toMatchObject({
      artifactRef: registration.artifactRef,
      implementationHash: registration.implementationHash,
    });
    const restarted = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: builtinFacts,
      candidates: runtime.candidates,
      planAuthority,
      rules: [sameAfterRestart!],
      now: () => NOW,
    });
    await expect(restarted.replay(candidate.candidateId, PLAN_ID)).resolves.toEqual(candidate);

    const changedExecute: GovernedInferenceRuleRegistration["execute"] = (context) => registration.execute(context);
    const changedImplementation = await runtime.artifacts.put(
      inferenceRuleImplementationArtifactInput(changedExecute, NOW),
    );
    const changedImplementationHash = changedImplementation.record.sha256;
    const changedRule: GovernedInferenceRuleArtifact = Object.freeze({
      ...governedRule,
      implementationHash: changedImplementationHash,
    });
    const changedStored = await runtime.artifacts.put(inferenceRuleArtifactInput(changedRule, NOW));
    const changedRegistration: GovernedInferenceRuleRegistration = Object.freeze({
      ...registration,
      implementationHash: changedImplementationHash,
      artifactRef: changedStored.record.ref as `sha256:${string}`,
      execute: changedExecute,
    });
    currentArtifactHash = changedStored.record.sha256;
    const changedService = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: builtinFacts,
      candidates: runtime.candidates,
      planAuthority,
      rules: [changedRegistration],
      now: () => NOW,
    });
    await expect(changedService.assessCurrent(candidate.candidateId, PLAN_ID)).resolves.toMatchObject({ status: "stale" });
    const replacement = await changedService.propose({
      ...await guardedInput(runtime.coordinator),
      ruleId: changedRegistration.ruleId,
    });
    expect(replacement.candidateId).not.toBe(candidate.candidateId);
    expect(replacement.trace.ruleOrModelArtifactHash).toBe(changedStored.record.sha256);
  });

  it("uses real Plan, Fact, and Artifact repositories across restart before atomically activating an approved fact", async () => {
    const runtime = await harness();
    const plans = new FilePlanRepository({
      coordinator: runtime.coordinator,
      runtimeRoot: runtime.root,
      topologyV3Enabled: false,
      now: () => NOW,
      id: (prefix) => `${prefix}-inference-real-12345678`,
    });
    const config = createDefaultN6Config("draft-inference-real", NOW);
    config.selection.gpuId = "gpu.rtx-a2000-12gb";
    const plan = await plans.create({ name: "Real inference plan", config });
    const caseSubject: ProductFactSubject = Object.freeze({
      kind: "product",
      skuId: "case.jonsbo-n6",
      familyId: "case.jonsbo-n6",
      modelId: "jonsbo-n6",
      variantId: "case.jonsbo-n6.global",
      revision: "vendor-unversioned",
      region: "global",
    });
    const gpuSubject: ProductFactSubject = Object.freeze({
      kind: "product",
      skuId: "gpu.rtx-a2000-12gb",
      familyId: "gpu.rtx-a2000",
      modelId: "rtx-a2000-12gb",
      variantId: "gpu.rtx-a2000-12gb.global",
      revision: "catalog-v1",
      region: "global",
    });
    const caseClaim = await sourceClaim(320, "b", caseSubject, "case.gpu_max_length");
    const gpuClaim = await sourceClaim(169, "c", gpuSubject, "gpu.length");
    runtime.claims.set(caseClaim.claimId, caseClaim);
    runtime.claims.set(gpuClaim.claimId, gpuClaim);
    const caseFact = await sourceFact("fact-real-case-gpu-limit", caseClaim, undefined, caseSubject);
    const gpuFact = await sourceFact("fact-real-gpu-length", gpuClaim, undefined, gpuSubject);

    const environment = {
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "true",
    };
    const registry = new ProductionInferenceRuleRegistry(environment);
    await registry.initialize(runtime.artifacts, () => NOW);
    const productionFacts = new FactRepository({
      ...runtime.factOptions,
      currentInferenceArtifactHash: registry.currentArtifactHash,
    });
    await productionFacts.putFact({ fact: caseFact });
    await productionFacts.putFact({ fact: gpuFact });
    const planAuthority = createFilePlanInferenceAuthority({ topologyV3Enabled: false });
    const service = await registry.createService(runtime.artifacts, {
      coordinator: runtime.coordinator,
      facts: productionFacts,
      candidates: runtime.candidates,
      planAuthority,
      now: () => NOW,
    }, () => NOW);
    const state = await runtime.coordinator.readState();
    const candidate = await service.propose({
      planId: plan.id,
      ruleId: BUILTIN_INFERENCE_RULE_IDS.GPU_LENGTH_CLEARANCE,
      target: { fieldId: "physical.clearance" },
      guard: {
        runtimeGeneration: state.runtimeGeneration,
        runtimeRevision: state.revision,
        planDraftRevision: plan.draftRevision,
      },
    });
    expect(candidate.proposedFact.value).toBe(151);

    const restartedRegistry = new ProductionInferenceRuleRegistry(environment);
    await restartedRegistry.initialize(runtime.artifacts, () => NOW);
    const restartedFacts = new FactRepository({
      ...runtime.factOptions,
      currentInferenceArtifactHash: restartedRegistry.currentArtifactHash,
    });
    const restartedService = await restartedRegistry.createService(runtime.artifacts, {
      coordinator: runtime.coordinator,
      facts: restartedFacts,
      candidates: new InferenceCandidateRepository(runtime.coordinator),
      planAuthority,
      now: () => NOW,
    }, () => NOW);
    runtime.approvalAuthority.service = restartedService;
    await expect(restartedService.replay(candidate.candidateId, plan.id)).resolves.toEqual(candidate);
    const committed = (await runtime.coordinator.withWrite(async ({ activeRoot, state: writerState }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => {
      const approval = await restartedService.resolveForApprovalAtRoot(
        activeRoot,
        writerState.runtimeGeneration,
        candidate.candidateId,
        plan.id,
      );
      return restartedFacts.putInferenceCandidateApprovalAtRoot(activeRoot, writerState.runtimeGeneration, {
        candidateId: approval.candidate.candidateId,
        expectedCandidateHash: approval.candidate.contentHash,
        approvalCapability: runtime.approvalAuthority.capability,
      });
    })).result;
    expect(committed.fact).toEqual(candidate.proposedFact);
    await expect(restartedFacts.listCurrentFacts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: candidate.proposedFact.factId, authority: "agent_inference" }),
    ]));
  });

  it("reaches production tools and preserves candidate/approval closure through graph, Doctor, backup, restore, and flag-off", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-inference-tool-production-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => NOW });
    await coordinator.initialize("inference-tool-production-test");
    const plans = new FilePlanRepository({
      coordinator,
      runtimeRoot: root,
      topologyV3Enabled: false,
      now: () => NOW,
      id: (prefix) => `${prefix}-inference-tool-12345678`,
    });
    const config = createDefaultN6Config("draft-inference-tool", NOW);
    config.selection.gpuId = "gpu.rtx-a2000-12gb";
    const plan = await plans.create({ name: "Inference tool production plan", config });
    await coordinator.withWrite(async ({ activeRoot }: { activeRoot: string }) => {
      const base = loadMergedCatalogSync({ activeRoot, generationAware: true });
      const modelTokens = new Map([
        ["case.jonsbo-n6", "jonsbo-n6"],
        ["gpu.rtx-a2000-12gb", "rtx-a2000-12gb"],
      ]);
      const replacements = [...modelTokens].map(([skuId, model]) => {
        const source = base.skus.find((sku: { id: string }) => sku.id === skuId);
        if (!source) throw new Error(`official inference catalog SKU is missing: ${skuId}`);
        return {
          ...structuredClone(source),
          model,
          variantId: "standard",
          revision: "vendor-unversioned",
          region: "global",
        };
      });
      await atomicWriteJson(confined(activeRoot, "catalog-overlays", "product-catalog.json"), {
        schemaVersion: base.schemaVersion,
        catalogVersion: "2.0.1",
        updatedAt: NOW,
        skus: replacements,
        runtimeCatalog: {
          schemaVersion: "1.0.0",
          overlayKind: "product_catalog_overlay",
          overlayVersion: "2.0.1",
          acceptedSkuIds: replacements.map(({ id }: { id: string }) => id),
          baseCatalogVersion: base.catalogVersion ?? base.schemaVersion,
          baseUpdatedAt: base.updatedAt,
        },
      });
    });
    const caseSubject: ProductFactSubject = Object.freeze({
      kind: "product",
      skuId: "case.jonsbo-n6",
      familyId: "case.jonsbo-n6",
      modelId: "jonsbo-n6",
      variantId: "standard",
      revision: "vendor-unversioned",
      region: "global",
    });
    const gpuSubject: ProductFactSubject = Object.freeze({
      kind: "product",
      skuId: "gpu.rtx-a2000-12gb",
      familyId: "gpu.rtx-a2000-12gb",
      modelId: "rtx-a2000-12gb",
      variantId: "standard",
      revision: "vendor-unversioned",
      region: "global",
    });
    const evidence = new FileEvidenceRepository({ coordinator, runtimeRoot: root, now: () => NOW });
    const claims = new EvidenceClaimRepository({ coordinator, runtimeRoot: root, evidence });
    const officialSpecs = [{
      brand: "JONSBO",
      category: "case",
      subject: caseSubject,
      fieldId: "case.gpu_max_length",
      value: 320,
      pageUrl: "https://www.jonsbo.com/products/n6",
      manualUrl: "https://www.jonsbo.com/products/n6/manual.txt",
    }, {
      brand: "NVIDIA",
      category: "gpu",
      subject: gpuSubject,
      fieldId: "gpu.length",
      value: 169,
      pageUrl: "https://www.nvidia.com/en-us/design-visualization/rtx-a2000/",
      manualUrl: "https://www.nvidia.com/en-us/design-visualization/rtx-a2000/manual.txt",
    }] as const;
    const specForUrl = (url: string) => officialSpecs.find((spec) => url === spec.pageUrl || url === spec.manualUrl);
    const evidenceJobs = createProductionEvidenceJobRuntime({
      runtimeRoot: root,
      coordinator,
      evidenceRepository: evidence,
      artifactRepository: new FileArtifactRepository({ coordinator, now: () => NOW }),
      topologyV3Enabled: false,
      online: () => true,
      now: () => NOW,
      rateLimiter: Object.freeze({ acquire: async () => undefined }),
      officialFetcher: async (url: string, input: { includeBody?: boolean }) => {
        const spec = specForUrl(url);
        if (!spec) throw new Error(`unexpected official fixture URL: ${url}`);
        const bytes = Buffer.from(`${spec.brand} ${spec.subject.modelId} ${spec.fieldId} ${spec.value} mm`, "utf8");
        return input.includeBody === true ? {
          status: 200,
          finalUrl: spec.manualUrl,
          redirects: [],
          rawBody: bytes,
          body: bytes.toString("utf8"),
          contentType: "text/plain",
          contentHash: sha256Bytes(bytes),
          retrievedAt: NOW,
        } : {
          status: 200,
          finalUrl: spec.pageUrl,
          redirects: [],
          body: `<a href="${spec.manualUrl}">official manual</a>`,
          contentType: "text/html",
          retrievedAt: NOW,
        };
      },
      officialClaimExtractor: async (input: {
        request: { subject: {
          brand: string;
          skuId: string;
          familyId: string;
          modelId: string;
          variantId?: string;
          revision?: string;
          region?: string;
        } };
        documentId: `doc-sha256-${string}`;
        documentSha256: string;
        captureId: `capture-sha256-${string}`;
        attemptedAt: string;
      }) => {
        const spec = officialSpecs.find((entry) => entry.subject.skuId === input.request.subject.skuId);
        if (!spec) throw new Error("official inference extraction subject unavailable");
        const identity = {
          brand: spec.brand,
          skuId: spec.subject.skuId,
          familyId: spec.subject.familyId!,
          modelId: spec.subject.modelId!,
          variantId: spec.subject.variantId!,
          revision: spec.subject.revision!,
          region: spec.subject.region!,
        };
        const confirmation = createOfficialDocumentIdentityConfirmation({
          authority: "official",
          documentSha256: input.documentSha256,
          pageKind: "manual",
          scope: "revision",
          identity,
          locator: {
            page: 1,
            section: "Product identity",
            excerpt: `${spec.brand} ${spec.subject.modelId} ${spec.subject.variantId} ${spec.subject.revision}`,
          },
          matchedTokens: {
            model: spec.subject.modelId!,
            variant: spec.subject.variantId!,
            revision: spec.subject.revision!,
          },
          extractor: { id: "inference-production-fixture", version: "1.0.0" },
          confirmedAt: input.attemptedAt,
        });
        return {
          claimCandidates: [{
            schemaVersion: "evidence-claim-v1" as const,
            subject: {
              skuId: spec.subject.skuId,
              familyId: spec.subject.familyId!,
              modelId: spec.subject.modelId!,
              variantId: spec.subject.variantId!,
              revision: spec.subject.revision!,
              region: spec.subject.region!,
            },
            scope: "revision" as const,
            fieldId: spec.fieldId,
            value: spec.value,
            unit: "mm",
            authority: "official" as const,
            source: {
              documentId: input.documentId,
              documentSha256: input.documentSha256,
              captureId: input.captureId,
              locator: { page: 1, field: spec.fieldId, section: "Dimensions" },
            },
            retrievedAt: input.attemptedAt,
            status: "active" as const,
          }],
          officialPromotionInput: {
            registryTrust: "trusted" as const,
            documentSha256: input.documentSha256,
            requiredScope: "revision" as const,
            expectedIdentity: { kind: "product" as const, ...identity },
            confirmation,
          },
        };
      },
    });
    await evidenceJobs.initialize();
    const descriptors = await Promise.all(officialSpecs.map((spec) => evidenceJobs.enqueue({
      planId: plan.id,
      subject: {
        brand: spec.brand,
        category: spec.category,
        skuId: spec.subject.skuId,
        familyId: spec.subject.familyId,
        modelId: spec.subject.modelId,
        variantId: spec.subject.variantId,
        revision: spec.subject.revision,
        region: spec.subject.region,
      },
      requestedFieldIds: [spec.fieldId],
      entry: { kind: "official_url", url: spec.pageUrl },
      allowThirdPartyFallback: false,
      requestedAt: NOW,
    })));
    await evidenceJobs.scheduler.drain(40);
    const environment = {
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "true",
    };
    const production = createProductionGovernedAgentActions({
      coordinator,
      runtimeRoot: root,
      topologyV3Enabled: false,
      environment,
      now: () => NOW,
    });
    await production.initializeInference();
    const contextAuditStore = new FilePlanAgentContextAuditStore({ coordinator });
    const contextAuditLease = await coordinator.acquireMaintenanceLease("inference-production-context-fixture");
    await contextAuditStore.putWithMaintenanceLease({
      schemaVersion: "1.0.0",
      sessionId: "session-inference-production",
      runId: "run-inference-production",
      planId: plan.id,
      planVersionId: plan.activeVersionId,
      draftRevision: plan.draftRevision,
      configHash: await hashPlanConfig(plan.draft.config),
      evaluationHash: digest("d"),
      spatialSelection: null,
      contextHash: digest("c"),
      recordedAt: NOW,
    }, contextAuditLease.token);
    await coordinator.releaseMaintenanceLease(contextAuditLease.token);
    await new FileAgentSessionStore({ coordinator, now: () => NOW }).put({
      contractVersion: AGENT_CONTRACT_VERSION,
      id: "session-inference-production",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      messages: [],
      buildConfig: plan.draft.config,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await new FileAgentRunAuditStore({ coordinator, now: () => NOW }).put(sealAgentRunAudit({
      contractVersion: AGENT_CONTRACT_VERSION,
      runId: "run-inference-production",
      sessionId: "session-inference-production",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      status: "running",
      startedAt: NOW,
      finishedAt: null,
      buildConfigHash: agentAuditHash(plan.draft.config),
      skill: null,
      providerTurns: [],
      toolCalls: [],
      error: null,
    }));
    expect(production.inferenceActions).toBeDefined();
    const tools = new AgentToolRegistry(createBuildSimTools({
      evidenceFactActions: production.evidenceFactActions,
      inferenceActions: production.inferenceActions!,
    }));
    const approvalNow = new Date().toISOString();
    const approvalJobs = new FileJobRepository({
      coordinator,
      now: () => approvalNow,
      leaseToken: (() => { let sequence = 0; return () => `${++sequence}`.padStart(64, "0"); })(),
      leaseDurationMs: 60_000,
    });
    await approvalJobs.initialize();
    const approvalRunPayload = {
      schemaVersion: "agent-run-payload-v1" as const,
      runId: "run-inference-production",
      sessionId: "session-inference-production",
      inputHash: agentAuditHash({ fixture: "inference-production" }),
      userMessage: {
        id: "message-inference-production",
        role: "user" as const,
        content: "governed inference production fixture",
        createdAt: NOW,
      },
      buildConfig: plan.draft.config,
      skillId: "evidence-and-attachments",
      approvals: [],
      startedAt: approvalNow,
    };
    const approvalPayload = await production.artifacts.put({
      bytes: Buffer.from(JSON.stringify(approvalRunPayload), "utf8"),
      mediaType: "application/json",
      privacyClass: "private_user",
      kind: "agent-run-input",
      references: [],
      createdAt: approvalNow,
    });
    await approvalJobs.create({
      type: "agent.run",
      handlerVersion: "1",
      idempotencyKey: "agent-run:run-inference-production",
      inputHash: approvalRunPayload.inputHash,
      payloadRef: approvalPayload.record.ref,
      networkRequired: false,
      maxAttempts: 20,
    });
    let approvalClaim: ClaimedBackgroundJob | null = await approvalJobs.claimNext("inference-production-worker", {
      types: ["agent.run"],
      leaseDurationMs: 60_000,
    });
    if (!approvalClaim) throw new Error("production approval Agent job was not claimed");
    const approvalAuthority = new AgentWriteApprovalAuthority(production.artifacts, {
      now: () => approvalNow,
      token: () => "1".repeat(64),
      jobs: approvalJobs,
    });
    let productionApprovalSequence = 0;
    const productionApprovedContext = async (
      registry: AgentToolRegistry,
      toolName: string,
      input: unknown,
    ): Promise<AgentToolContext> => {
      productionApprovalSequence += 1;
      const call = {
        id: `call-inference-production-${productionApprovalSequence}`,
        name: toolName,
        input,
      };
      const currentApprovalClaim = approvalClaim;
      if (!currentApprovalClaim) throw new Error("production approval Agent job lost its running lease");
      const requested = await approvalAuthority.request({
        runId: "run-inference-production",
        sessionId: "session-inference-production",
        call,
        toolTitle: toolName,
        toolDefinitionHash: registry.definitionHash(toolName),
      }, {
        jobId: currentApprovalClaim.job.jobId,
        runtimeGeneration: currentApprovalClaim.lease.runtimeGeneration,
        expectedRevision: currentApprovalClaim.lease.expectedRevision,
        leaseToken: currentApprovalClaim.lease.leaseToken,
      });
      approvalClaim = await approvalJobs.checkpoint(
        currentApprovalClaim.job.jobId,
        currentApprovalClaim.lease,
        requested.authorityRef,
      );
      await approvalJobs.pauseForUser(approvalClaim.job.jobId, approvalClaim.lease);
      const confirmed = await approvalAuthority.confirm({
        authorityRef: requested.authorityRef,
        runId: "run-inference-production",
        approvalId: requested.pending.approvalId,
        nonce: requested.pending.nonce,
        approvedBy: "human-inference-reviewer",
      });
      const waiting = await approvalJobs.get(approvalClaim.job.jobId);
      await approvalJobs.resume(waiting.jobId, waiting.revision, { checkpointRef: confirmed.authorityRef });
      approvalClaim = await approvalJobs.claimNext("inference-production-worker", {
        types: ["agent.run"],
        leaseDurationMs: 60_000,
      });
      if (!approvalClaim) throw new Error("confirmed production approval Agent job was not reclaimed");
      const authorized = await approvalAuthority.authorize(confirmed.authorityRef, {
        toolName,
        toolDefinitionHash: registry.definitionHash(toolName),
        sessionId: "session-inference-production",
        runId: "run-inference-production",
        inputHash: agentAuditHash(input),
        callId: call.id,
      });
      if (!authorized) throw new Error("production Agent write approval was not authorized");
      return {
        sessionId: "session-inference-production",
        runId: "run-inference-production",
        buildConfig: plan.draft.config,
        signal: new AbortController().signal,
        approval: authorized.envelope,
        writeApprovalProof: authorized.proof,
      };
    };
    const promotedClaims: EvidenceClaim[] = [];
    for (const descriptor of descriptors) {
      const status = await evidenceJobs.status(descriptor.pipelineId);
      const extraction = status.stages.find(({ stage }) => stage === "claim_extraction")?.result;
      const candidateId = Array.isArray(extraction?.output.claimCandidateIds)
        ? String(extraction.output.claimCandidateIds[0]) : "";
      if (!candidateId) throw new Error(`official inference claim candidate was not produced: ${JSON.stringify(status)}`);
      const input = { candidateId };
      const approvedContext = await productionApprovedContext(tools, "archive_official_evidence", input);
      if (!approvedContext.writeApprovalProof) throw new Error("official inference approval proof was not authorized");
      const promoted = await production.claimCandidates.promoteOfficial(candidateId, plan.id, {
        proof: approvedContext.writeApprovalProof,
        approvedInput: input,
      });
      promotedClaims.push(promoted.claim);
    }
    const [caseClaim, gpuClaim] = promotedClaims;
    if (!caseClaim || !gpuClaim) throw new Error("official inference claims were not promoted");
    await production.facts.putFact({ fact: await sourceFact("fact-tool-case-limit", caseClaim, undefined, caseSubject) });
    await production.facts.putFact({ fact: await sourceFact("fact-tool-gpu-length", gpuClaim, undefined, gpuSubject) });
    expect(tools.names()).toEqual(expect.arrayContaining(["propose_agent_inference", "approve_agent_inference"]));
    const proposalInput = {
      ruleId: BUILTIN_INFERENCE_RULE_IDS.GPU_LENGTH_CLEARANCE,
      target: { fieldId: "physical.clearance" },
      guard: { planDraftRevision: plan.draftRevision },
    };
    const beforeForgery = await production.inferenceCandidates.list();
    const forged = await tools.dispatch(
      "propose_agent_inference",
      { ...proposalInput, facts: [{ value: 9_999 }], formula: "caller controlled" },
      await productionApprovedContext(tools, "propose_agent_inference", {
        ...proposalInput,
        facts: [{ value: 9_999 }],
        formula: "caller controlled",
      }),
    );
    if (forged.result.errorCode === "approval_invalid") {
      throw new Error(`inference fixture approval invalid: ${forged.result.message}`);
    }
    expect(forged.result).toMatchObject({ ok: false, errorCode: "tool_input_invalid" });
    expect(await production.inferenceCandidates.list()).toEqual(beforeForgery);

    const proposed = await tools.dispatch(
      "propose_agent_inference",
      proposalInput,
      await productionApprovedContext(tools, "propose_agent_inference", proposalInput),
    );
    expect(proposed.result).toMatchObject({
      ok: true,
      content: {
        outcomeKind: "inference_candidate_only",
        authorityEffects: { claimActivated: false, factActivated: false },
        proposal: {
          proposedFact: { value: 151, authority: "agent_inference" },
          maySupportSafetyPass: false,
        },
      },
    });
    const candidate = (proposed.result.content as {
      proposal: Awaited<ReturnType<InferenceCandidateService["get"]>>;
    }).proposal!;
    const pendingWorkspace = createWorkspaceRepositories({
      RUNTIME_ROOT: root,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "true",
    });
    await expect(pendingWorkspace.planResolutionSummary?.forPlan(plan.id)).resolves.toMatchObject({
      planId: plan.id,
      inferences: [{
        candidateId: candidate.candidateId,
        lifecycle: "pending_approval",
        proposalApprovalRef: candidate.proposalApprovalRef,
        inference: {
          formula: candidate.rule.formula,
          inputFactRefs: candidate.trace.inputFactRefs,
          assumptions: candidate.trace.assumptions,
          outputRange: candidate.trace.outputRange,
          invalidationConditions: candidate.trace.invalidationConditions,
        },
        maySupportSafetyPass: false,
      }],
    });
    await expect(pendingWorkspace.planResolutionSummary?.forPlan("plan-other-inference"))
      .resolves.toMatchObject({ inferences: [] });
    await expect(production.facts.getFact(candidate.proposedFact.factId)).rejects.toMatchObject({ code: "not_found" });
    await expect(createProductionReferenceGraph({ coordinator, now: () => NOW })).resolves.toMatchObject({
      nodes: expect.arrayContaining([`fact-inference-candidate:${candidate.candidateId}`]),
    });
    const approvalInput = { candidateId: candidate.candidateId };
    const inferenceApprovalContext = await productionApprovedContext(
      tools,
      "approve_agent_inference",
      approvalInput,
    );
    if (!inferenceApprovalContext.writeApprovalProof) {
      throw new Error("production inference approval proof is missing");
    }

    const crashingApprovalCapability = Object.freeze({ kind: "test-production-crash-approval" });
    let crashingService: InferenceCandidateService | null = null;
    const crashingFacts = new FactRepository({
      coordinator,
      runtimeRoot: root,
      evidenceClaims: claims,
      currentInferenceArtifactHash: production.inferenceRegistry.currentArtifactHash,
      inferenceCandidateApprovalAuthority: {
        approvalCapability: crashingApprovalCapability,
        async resolveForApprovalAtRoot(activeRoot, runtimeGeneration, candidateId, expectedCandidateHash) {
          if (!crashingService) throw new Error("crashing approval service unavailable");
          return crashingService.resolveForRepositoryApprovalAtRoot(
            activeRoot,
            runtimeGeneration,
            candidateId,
            expectedCandidateHash,
          );
        },
        async resolveCurrentFactAtRoot(activeRoot, runtimeGeneration, candidateId, expectedCandidateHash, currentFacts) {
          if (!crashingService) return null;
          return crashingService.resolveCurrentFactAtRoot(
            activeRoot,
            runtimeGeneration,
            candidateId,
            expectedCandidateHash,
            currentFacts,
          );
        },
      },
      now: () => NOW,
      inferenceApprovalFaultInjector: () => { throw new Error("simulated production approval crash"); },
    });
    crashingService = await production.inferenceRegistry.createService(production.artifacts, {
      coordinator,
      facts: crashingFacts,
      candidates: production.inferenceCandidates,
      planAuthority: createFilePlanInferenceAuthority({ topologyV3Enabled: false }),
      now: () => NOW,
    }, () => NOW);
    await expect(coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => {
      const closure = await crashingService.resolveForApprovalAtRoot(
        activeRoot,
        state.runtimeGeneration,
        candidate.candidateId,
        plan.id,
      );
      return crashingFacts.putInferenceCandidateApprovalAtRoot(activeRoot, state.runtimeGeneration, {
        candidateId: closure.candidate.candidateId,
        expectedCandidateHash: closure.candidate.contentHash,
        approvalCapability: crashingApprovalCapability,
        approvalAuthorityRef: inferenceApprovalContext.writeApprovalProof!.authorityRef as `sha256:${string}`,
      });
    })).rejects.toThrow("simulated production approval crash");
    const pendingGraph = await createProductionReferenceGraph({ coordinator, now: () => NOW });
    expect(pendingGraph.edges).toEqual(expect.arrayContaining([{
      fromRef: expect.stringMatching(/^fact-inference-approval:/),
      toRef: `fact-inference-candidate:${candidate.candidateId}`,
      necessity: "required_for_replay",
    }]));
    await expect(crashingFacts.getFact(candidate.proposedFact.factId)).rejects.toMatchObject({ code: "not_found" });

    const restarted = createProductionGovernedAgentActions({
      coordinator,
      runtimeRoot: root,
      topologyV3Enabled: false,
      environment,
      now: () => NOW,
    });
    await restarted.initializeInference();
    const restartedTools = new AgentToolRegistry(createBuildSimTools({ inferenceActions: restarted.inferenceActions! }));
    const approved = await restartedTools.dispatch(
      "approve_agent_inference",
      approvalInput,
      inferenceApprovalContext,
    );
    expect(approved.result).toMatchObject({
      ok: true,
      content: {
        status: "fact_activated",
        candidateId: candidate.candidateId,
        fact: { factId: candidate.proposedFact.factId, authority: "agent_inference" },
        authorityEffects: { claimActivated: false, factActivated: true },
        maySupportSafetyPass: false,
      },
    });
    await expect(restarted.facts.listCurrentFacts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: candidate.proposedFact.factId }),
    ]));
    const activeWorkspace = createWorkspaceRepositories({
      RUNTIME_ROOT: root,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "true",
    });
    if (!activeWorkspace.planResolutionSummary) throw new Error("workspace plan inference summary authority is unavailable");
    const activeSummary = await activeWorkspace.planResolutionSummary.forPlan(plan.id);
    expect(activeSummary).toMatchObject({
      inferences: [{
        candidateId: candidate.candidateId,
        lifecycle: "active",
        transaction: {
          status: "committed",
          approvalAuthorityRef: inferenceApprovalContext.writeApprovalProof.authorityRef,
        },
        output: { factId: candidate.proposedFact.factId, value: 151 },
      }],
    });
    const summaryState = await coordinator.readState();
    const summaryCatalog = loadMergedCatalogSync({
      activeRoot: coordinator.activeRoot(summaryState),
      generationAware: true,
    });
    const summaryEvaluation = evaluateBuild(plan.draft.config, summaryCatalog);
    const agentContext = await createPlanAgentContext({
      plan,
      snapshot: {
        schemaVersion: "1.0.0",
        planId: plan.id,
        planVersionId: plan.activeVersionId,
        draftRevision: plan.draftRevision,
        configHash: await hashPlanConfig(plan.draft.config),
        evaluationHash: await sha256Hex(summaryEvaluation),
        evaluatedAt: NOW,
        evaluation: summaryEvaluation,
      },
      selection: null,
      purchaseSummary: {},
      buildTaskSummary: {},
      inferenceSummaries: activeSummary.inferences,
    });
    const providerRequests: ProviderTurnRequest[] = [];
    const fivePartAnswer = [
      "证据阶梯：第 6 级，agent_inference。",
      "官网未找到原因：unknown。",
      "第三方证据：unknown / 未成立。",
      `可重放推断：active；${candidate.trace.inferenceTraceId}；${candidate.rule.formula}；maySupportSafetyPass=false。`,
      "下一步补证：补充非推断证据后再做安全结论。",
    ].join("\n");
    const provider: ProviderAdapter = {
      id: "deepseek",
      models: [{
        provider: "deepseek",
        id: "deepseek-v4-flash",
        label: "fixture",
        capabilities: { streaming: true, tools: true, parallelTools: true, structuredOutput: true, thinking: true },
      }],
      async createTurn(request) {
        providerRequests.push(request);
        expect(request.system).toContain("证据阶梯");
        expect(request.messages.at(-1)?.content).toContain(candidate.trace.inferenceTraceId);
        expect(request.messages.at(-1)?.content).toContain(candidate.rule.formula);
        return {
          provider: "deepseek",
          providerRequestId: `inference-summary-provider-${providerRequests.length}`,
          model: request.model,
          content: fivePartAnswer,
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          latencyMs: 1,
        };
      },
    };
    const agentRuntime = new AgentRuntime([provider], new MemoryAgentSessionStore(), {
      toolRegistry: restartedTools,
      skillLoader: new AgentSkillLoader(path.resolve("skills"), restartedTools),
    });
    for (const skillId of [undefined, "evidence-and-attachments"] as const) {
      const session = await agentRuntime.createSession();
      const run = await agentRuntime.startRun(session.id, {
        content: planAgentContextEnvelope("解释真实审批后的推断", agentContext),
        buildConfig: plan.draft.config,
        ...(skillId === undefined ? {} : { skillId }),
      });
      await agentRuntime.waitForRun(run.runId);
      expect(agentRuntime.getRun(run.runId).status).toBe("completed");
      expect((await agentRuntime.getSession(session.id)).messages.at(-1)?.content).toBe(fivePartAnswer);
    }
    expect(providerRequests[0]?.tools.map(({ name }) => name)).not.toContain("propose_agent_inference");
    expect(providerRequests[1]?.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "propose_agent_inference", "approve_agent_inference",
    ]));
    const graph = await createProductionReferenceGraph({ coordinator, now: () => NOW });
    expect(graph.edges).toEqual(expect.arrayContaining([
      {
        fromRef: expect.stringMatching(/^fact-inference-approval:/),
        toRef: `fact-inference-candidate:${candidate.candidateId}`,
        necessity: "required_for_replay",
      },
      {
        fromRef: `fact-inference-candidate:${candidate.candidateId}`,
        toRef: `sha256:${candidate.rule.implementationHash}`,
        necessity: "required_for_replay",
      },
    ]));
    expect((await runDoctor({ coordinator, now: () => NOW })).report.checks
      .find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "pass" });

    const backup = path.join(root, "inference-production.backup");
    await createBackup({ coordinator, outputFile: backup, password: "a sufficiently long password", now: () => approvalNow });
    await expect(verifyBackup({ inputFile: backup, password: "a sufficiently long password", now: () => approvalNow }))
      .resolves.toMatchObject({ valid: true });
    await restoreBackup({ coordinator, inputFile: backup, password: "a sufficiently long password", now: () => approvalNow });
    const restored = createProductionGovernedAgentActions({
      coordinator,
      runtimeRoot: root,
      topologyV3Enabled: false,
      environment,
      now: () => NOW,
    });
    await restored.initializeInference();
    await expect(restored.facts.getFact(candidate.proposedFact.factId)).resolves.toMatchObject({
      authority: "agent_inference",
    });
    await expect(restored.facts.listCurrentFacts()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: candidate.proposedFact.factId }),
    ]));

    const disabled = createProductionGovernedAgentActions({
      coordinator,
      runtimeRoot: root,
      topologyV3Enabled: false,
      environment: { BUILD_SIM_FACT_GRAPH_ENABLED: "true", BUILD_SIM_AGENT_INFERENCE_ENABLED: "false" },
      now: () => NOW,
    });
    await disabled.initializeInference();
    expect(disabled.inferenceActions).toBeUndefined();
    await expect(disabled.facts.getFact(candidate.proposedFact.factId)).resolves.toBeDefined();
    expect((await disabled.facts.listCurrentFacts()).map(({ factId }) => factId)).not.toContain(candidate.proposedFact.factId);
    const disabledWorkspace = createWorkspaceRepositories({
      RUNTIME_ROOT: root,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "false",
    });
    await expect(disabledWorkspace.planResolutionSummary?.forPlan(plan.id)).resolves.toMatchObject({
      inferences: [{ candidateId: candidate.candidateId, featureEnabled: false, lifecycle: "disabled_historical" }],
    });

    const workspaceEnvironment = {
      RUNTIME_ROOT: root,
      BUILD_SIM_FACT_GRAPH_ENABLED: "true",
      BUILD_SIM_AGENT_INFERENCE_ENABLED: "true",
    };
    const workspaceBeforeSwap = createWorkspaceRepositories(workspaceEnvironment);
    expect((await workspaceBeforeSwap.factRepository.listCurrentFacts()).map(({ factId }) => factId))
      .toContain(candidate.proposedFact.factId);

    // A checksum-valid metadata rewrite still cannot turn arbitrary artifact
    // metadata into the active allowlisted rule authority.
    const currentState = await coordinator.readState();
    const activeRoot = coordinator.activeRoot(currentState);
    const artifactHash = candidate.trace.ruleOrModelArtifactHash;
    const metadataFile = path.join(activeRoot, "artifacts", "metadata", `${artifactHash}.json`);
    const manifestFile = path.join(activeRoot, "artifacts", "repository-manifest.json");
    const metadata = await readJson(metadataFile);
    metadata.record.kind = "ordinary-runtime-artifact";
    metadata.checksum = sha256Json(metadata.record);
    await atomicWriteJson(metadataFile, metadata);
    const manifest = await readJson(manifestFile);
    manifest.records[artifactHash] = metadata.checksum;
    const { contentHash: _manifestHash, ...manifestMaterial } = manifest;
    manifest.contentHash = sha256Json(manifestMaterial);
    await atomicWriteJson(manifestFile, manifest);

    const workspaceAfterSwap = createWorkspaceRepositories(workspaceEnvironment);
    expect((await workspaceAfterSwap.factRepository.listCurrentFacts()).map(({ factId }) => factId))
      .not.toContain(candidate.proposedFact.factId);
    expect((await restored.facts.listCurrentFacts()).map(({ factId }) => factId))
      .not.toContain(candidate.proposedFact.factId);
    await expect(createProductionReferenceGraph({ coordinator, now: () => NOW }))
      .rejects.toThrow(/governed artifact closure is invalid/);
  }, 30_000);

  it("rejects a product inference that splices required input facts from two exact SKU subjects", async () => {
    const runtime = await harness();
    const siblingSubject: ProductFactSubject = Object.freeze({
      ...productSubject,
      skuId: "case.inference.sibling",
      variantId: "case-inference-sibling-variant",
      revision: "B",
    });
    const siblingClaim = await sourceClaim(220, "e", siblingSubject);
    runtime.claims.set(siblingClaim.claimId, siblingClaim);
    const siblingFact = await sourceFact("fact-width-sibling", siblingClaim, undefined, siblingSubject);
    await runtime.facts.putFact({ fact: siblingFact });
    const executeCrossSkuSplice = (
      { currentFacts }: GovernedInferenceRuleExecutionContext,
    ): GovernedInferenceRuleExecutionResult => {
      const inputs = currentFacts.filter((fact) => fact.field === "physical.width");
      return {
        inputFactIds: inputs.map(({ factId }) => factId),
        subject: productSubject,
        scope: "revision" as const,
        value: 220,
        unit: "mm",
        outputRange: { min: 218, max: 222, unit: "mm" },
      };
    };
    const implementation = await runtime.artifacts.put(inferenceRuleImplementationArtifactInput(executeCrossSkuSplice, NOW));
    const productRule = Object.freeze({
      ...rule,
      ruleId: "case-limit.from-two-widths.invalid",
      implementationId: "test.cross-sku-splice.v1",
      implementationHash: implementation.record.sha256,
      targetFieldId: "case.gpu_max_length",
      formula: "invalid_case_limit_mm = max(widths_mm)",
    }) satisfies GovernedInferenceRuleArtifact;
    const storedRule = await runtime.artifacts.put(inferenceRuleArtifactInput(productRule, NOW));
    const registration: GovernedInferenceRuleRegistration = Object.freeze({
      ruleId: productRule.ruleId,
      implementationId: productRule.implementationId,
      implementationHash: productRule.implementationHash,
      artifactRef: storedRule.record.ref as `sha256:${string}`,
      execute: executeCrossSkuSplice,
    });
    const planAuthority: InferencePlanAuthority = Object.freeze({
      resolveAtRoot: async (_activeRoot: string, _planId: string, currentFacts: readonly Readonly<FactRecord>[]) => ({
        planDraftRevision: 3,
        planConfigHash: PLAN_CONFIG_HASH,
        relevantFactIds: currentFacts.filter((fact) => fact.field === "physical.width").map(({ factId }) => factId),
        relevantProductSubjectKeys: [factSubjectKey(productSubject), factSubjectKey(siblingSubject)],
      }),
    });
    const service = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: runtime.facts,
      candidates: runtime.candidates,
      planAuthority,
      rules: [registration],
      now: () => NOW,
    });
    const before = (await runtime.candidates.list()).length;
    await expect(service.propose({
      ...await guardedInput(runtime.coordinator),
      ruleId: productRule.ruleId,
      target: { fieldId: productRule.targetFieldId },
    })).rejects.toMatchObject({ code: "corrupt_data" });
    expect((await runtime.candidates.list()).length).toBe(before);
  });

  it("atomically approves trace+fact and recovers an after-trace crash into a closed reference graph", async () => {
    const runtime = await harness();
    const candidate = await runtime.service.propose(await guardedInput(runtime.coordinator));
    const approval = await runtime.service.resolveForApproval(candidate.candidateId, PLAN_ID);
    let crashed = false;
    const crashingFacts = new FactRepository({
      ...runtime.factOptions,
      inferenceApprovalFaultInjector: (point) => {
        if (point === "after_trace_write" && !crashed) {
          crashed = true;
          throw new Error("simulated after-trace crash");
        }
      },
    });
    await expect(crashingFacts.putInferenceCandidateApproval({
      candidateId: approval.candidate.candidateId,
      expectedCandidateHash: approval.candidate.contentHash,
      approvalCapability: runtime.approvalAuthority.capability,
    })).rejects.toThrow("simulated after-trace crash");
    await expect(runtime.facts.getInferenceTrace(approval.trace.inferenceTraceId)).resolves.toEqual(approval.trace);
    await expect(runtime.facts.getFact(approval.proposedFact.factId)).rejects.toMatchObject({ code: "not_found" });

    const restartedFacts = new FactRepository(runtime.factOptions);
    const recovery = await restartedFacts.recoverPendingInferenceApprovals();
    expect(recovery).toMatchObject({
      recovered: [{
        transactionId: expect.stringMatching(/^inference-approval-sha256-/),
        recovered: true,
        fact: { factId: approval.proposedFact.factId },
        trace: { inferenceTraceId: approval.trace.inferenceTraceId },
      }],
      abortedTransactionIds: [],
    });
    await expect(restartedFacts.getFact(approval.proposedFact.factId)).resolves.toEqual(approval.proposedFact);
    expect((await restartedFacts.listCurrentFacts()).map(({ factId }) => factId)).toContain(approval.proposedFact.factId);

    const state = await runtime.coordinator.readState();
    const activeRoot = runtime.coordinator.activeRoot(state);
    const factsSnapshot = await restartedFacts.snapshotReferences(activeRoot);
    const transactionNode = factsSnapshot.nodes.find((node) => node.startsWith("fact-inference-approval:"));
    expect(transactionNode).toBeDefined();
    expect(factsSnapshot.edges).toEqual(expect.arrayContaining([
      { fromRef: transactionNode, toRef: `fact:${approval.proposedFact.factId}`, necessity: "required_for_replay" },
      { fromRef: transactionNode, toRef: `fact-inference:${approval.trace.inferenceTraceId}`, necessity: "required_for_replay" },
    ]));
    const claimNodes = [...runtime.claims.keys()].map((claimId) => `evidence-claim:${claimId}`);
    const graph = await createReferenceGraphAtSnapshot({
      state,
      activeRoot,
      providers: [
        restartedFacts,
        {
          snapshotReferences: async () => ({
            providerId: "test-evidence-claims",
            revision: claimNodes.length,
            manifestHash: sha256Json(claimNodes),
            snapshotPointers: [],
            nodes: claimNodes,
            edges: [],
          }),
        },
      ],
      now: () => NOW,
    });
    expect(verifyReferenceGraph(graph)).toEqual([]);
  });

  it("supports one outer coordinator writer for root-bound approval resolution and atomic publication", async () => {
    const runtime = await harness();
    const candidate = await runtime.service.propose(await guardedInput(runtime.coordinator));
    const committed = (await runtime.coordinator.withWrite(async ({ activeRoot, state }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => {
      const approval = await runtime.service.resolveForApprovalAtRoot(
        activeRoot,
        state.runtimeGeneration,
        candidate.candidateId,
        PLAN_ID,
      );
      return runtime.facts.putInferenceCandidateApprovalAtRoot(activeRoot, state.runtimeGeneration, {
        candidateId: approval.candidate.candidateId,
        expectedCandidateHash: approval.candidate.contentHash,
        approvalCapability: runtime.approvalAuthority.capability,
      });
    })).result;
    expect(committed).toMatchObject({ recovered: false, fact: { factId: candidate.proposedFact.factId } });
    await expect(runtime.facts.getFact(candidate.proposedFact.factId)).resolves.toEqual(candidate.proposedFact);
    await expect(runtime.facts.getInferenceTrace(candidate.trace.inferenceTraceId)).resolves.toEqual(candidate.trace);
    expect((await runtime.facts.listCurrentFacts()).map(({ factId }) => factId)).toContain(candidate.proposedFact.factId);
    runtime.planState.draftRevision = 4;
    runtime.planState.configHash = digest("8");
    expect((await runtime.facts.listCurrentFacts()).map(({ factId }) => factId)).not.toContain(candidate.proposedFact.factId);
    // Immutable history remains readable after plan authority invalidates it.
    await expect(runtime.facts.getFact(candidate.proposedFact.factId)).resolves.toEqual(candidate.proposedFact);
  });

  it("invalidates a transitive inference when its inferred input becomes stale", async () => {
    const runtime = await harness();
    const executeDerivedHeight = (
      { planId, currentFacts }: GovernedInferenceRuleExecutionContext,
    ): GovernedInferenceRuleExecutionResult => {
      const input = currentFacts.find((fact) => fact.field === "physical.clearance");
      if (!input || typeof input.value !== "number") throw new Error("governed clearance fact unavailable");
      const value = input.value - 1;
      return {
        inputFactIds: [input.factId],
        subject: {
          kind: "plan_subject" as const,
          planId,
          subjectRef: { kind: "placement" as const, placementId: "derived-height-envelope" },
        },
        scope: "plan_subject" as const,
        value,
        unit: "mm",
        outputRange: { min: value - 1, max: value + 1, unit: "mm" },
      };
    };
    const implementation = await runtime.artifacts.put(inferenceRuleImplementationArtifactInput(executeDerivedHeight, NOW));
    const derivedRule = Object.freeze({
      ...rule,
      ruleId: "height.from-clearance",
      implementationId: "test.height-from-clearance.v1",
      implementationHash: implementation.record.sha256,
      targetFieldId: "physical.height",
      inputFieldIds: Object.freeze(["physical.clearance"]),
      formula: "height_mm = clearance_mm - 1",
      parameters: Object.freeze({ offsetMm: 1 }),
      assumptions: Object.freeze(["derived planning envelope shares the clearance datum"]),
    }) satisfies GovernedInferenceRuleArtifact;
    const storedRule = await runtime.artifacts.put(inferenceRuleArtifactInput(derivedRule, NOW));
    runtime.currentArtifactHashes.set(derivedRule.ruleId, storedRule.record.sha256);
    const derivedRegistration: GovernedInferenceRuleRegistration = Object.freeze({
      ruleId: derivedRule.ruleId,
      implementationId: derivedRule.implementationId,
      implementationHash: derivedRule.implementationHash,
      artifactRef: storedRule.record.ref as `sha256:${string}`,
      execute: executeDerivedHeight,
    });
    const service = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: runtime.facts,
      candidates: runtime.candidates,
      planAuthority: runtime.planAuthority,
      rules: [runtime.registration, derivedRegistration],
      now: () => NOW,
    });
    runtime.approvalAuthority.service = service;

    const first = await service.propose(await guardedInput(runtime.coordinator));
    await runtime.facts.putInferenceCandidateApproval({
      candidateId: first.candidateId,
      expectedCandidateHash: first.contentHash,
      approvalCapability: runtime.approvalAuthority.capability,
    });
    const state = await runtime.coordinator.readState();
    const second = await service.propose({
      planId: PLAN_ID,
      ruleId: derivedRule.ruleId,
      target: { fieldId: derivedRule.targetFieldId },
      guard: {
        runtimeGeneration: state.runtimeGeneration,
        runtimeRevision: state.revision,
        planDraftRevision: runtime.planState.draftRevision,
      },
    });
    await runtime.facts.putInferenceCandidateApproval({
      candidateId: second.candidateId,
      expectedCandidateHash: second.contentHash,
      approvalCapability: runtime.approvalAuthority.capability,
    });
    expect((await runtime.facts.listCurrentFacts()).map(({ factId }) => factId)).toEqual(expect.arrayContaining([
      first.proposedFact.factId,
      second.proposedFact.factId,
    ]));

    const replacementClaim = await sourceClaim(210, "c");
    runtime.claims.set(replacementClaim.claimId, replacementClaim);
    await runtime.facts.putFact({
      fact: await sourceFact("fact-width-transitive-replacement", replacementClaim, runtime.initialFact),
    });
    const currentIds = (await runtime.facts.listCurrentFacts()).map(({ factId }) => factId);
    expect(currentIds).not.toContain(first.proposedFact.factId);
    expect(currentIds).not.toContain(second.proposedFact.factId);
  });

  it("aborts a crashed pending approval when its input authority becomes stale", async () => {
    const runtime = await harness();
    const candidate = await runtime.service.propose(await guardedInput(runtime.coordinator));
    const approval = await runtime.service.resolveForApproval(candidate.candidateId, PLAN_ID);
    const crashingFacts = new FactRepository({
      ...runtime.factOptions,
      inferenceApprovalFaultInjector: () => { throw new Error("simulated after-trace crash"); },
    });
    await expect(crashingFacts.putInferenceCandidateApproval({
      candidateId: approval.candidate.candidateId,
      expectedCandidateHash: approval.candidate.contentHash,
      approvalCapability: runtime.approvalAuthority.capability,
    }))
      .rejects.toThrow("simulated after-trace crash");
    const replacementClaim = await sourceClaim(210, "c");
    runtime.claims.set(replacementClaim.claimId, replacementClaim);
    const replacement = await sourceFact("fact-width-after-crash", replacementClaim, runtime.initialFact);
    await runtime.facts.putFact({ fact: replacement });

    const recovered = await new FactRepository(runtime.factOptions).recoverPendingInferenceApprovals();
    expect(recovered.recovered).toEqual([]);
    expect(recovered.abortedTransactionIds).toHaveLength(1);
    await expect(runtime.facts.getFact(approval.proposedFact.factId)).rejects.toMatchObject({ code: "not_found" });
    await expect(new FactRepository(runtime.factOptions).recoverPendingInferenceApprovals()).resolves.toEqual({
      recovered: [],
      abortedTransactionIds: [],
    });
  });

  it("survives restore while fencing old generations and writes nothing for a missing rule artifact", async () => {
    const runtime = await harness();
    const candidate = await runtime.service.propose(await guardedInput(runtime.coordinator));
    const beforeRestore = await runtime.coordinator.readState();
    const oldActiveRoot = runtime.coordinator.activeRoot(beforeRestore);
    const lease = await runtime.coordinator.acquireMaintenanceLease("inference-candidate-restore-test");
    const staging = await runtime.coordinator.createStagingGeneration(lease.token);
    await cp(path.join(oldActiveRoot, "facts"), path.join(staging, "facts"), { recursive: true, force: true });
    await cp(path.join(oldActiveRoot, "artifacts"), path.join(staging, "artifacts"), { recursive: true, force: true });
    await runtime.coordinator.activateStagingGeneration(staging, beforeRestore.runtimeGeneration, lease.token);
    await runtime.coordinator.releaseMaintenanceLease(lease.token);

    const restored = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: runtime.facts,
      candidates: new InferenceCandidateRepository(runtime.coordinator),
      planAuthority: runtime.planAuthority,
      rules: [runtime.registration],
      now: () => NOW,
    });
    await expect(restored.replay(candidate.candidateId, PLAN_ID)).resolves.toEqual(candidate);
    const restoredState = await runtime.coordinator.readState();
    const count = (await runtime.candidates.list()).length;
    await expect(restored.propose({
      ...await guardedInput(runtime.coordinator),
      guard: {
        runtimeGeneration: beforeRestore.runtimeGeneration,
        runtimeRevision: restoredState.revision,
        planDraftRevision: 3,
      },
    })).rejects.toMatchObject({ code: "fenced" });
    expect((await runtime.candidates.list()).length).toBe(count);
    expect((await runtime.coordinator.readState()).revision).toBe(restoredState.revision);

    const missingRef = `sha256:${digest("f")}` as const;
    const fake = new InferenceCandidateService({
      coordinator: runtime.coordinator,
      artifacts: runtime.artifacts,
      facts: runtime.facts,
      candidates: runtime.candidates,
      planAuthority: runtime.planAuthority,
      rules: [{ ...runtime.registration, ruleId: "clearance.fake", artifactRef: missingRef }],
      now: () => NOW,
    });
    const beforeFake = await runtime.coordinator.readState();
    await expect(fake.propose(await guardedInput(runtime.coordinator, { ruleId: "clearance.fake" })))
      .rejects.toMatchObject({ code: "corrupt_data" });
    expect((await runtime.candidates.list()).length).toBe(count);
    expect(await runtime.coordinator.readState()).toEqual(beforeFake);
    expect((await runtime.candidates.snapshotReferences(runtime.coordinator.activeRoot(beforeFake))).manifestHash)
      .toBe(sha256Json([{ candidateId: candidate.candidateId, contentHash: candidate.contentHash }]));
  });
});

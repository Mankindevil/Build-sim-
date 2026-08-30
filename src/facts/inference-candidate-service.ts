import type { FileArtifactRepository } from "../artifacts/repository.mjs";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { sha256Bytes, sha256Json } from "../runtime/fs.mjs";
import { canFactAloneSupportSafetyPass, validateFactRecord, type FactRecord, type FactSubject } from "./contracts";
import { factFieldPolicy, type FactScope } from "./field-registry";
import { createFactRecord } from "./hash";
import { factSubjectKey } from "./resolver";
import { executeGpuLengthClearanceV1 } from "./inference-rules/gpu-length-clearance-v1.mjs";
import {
  GOVERNED_INFERENCE_IMPLEMENTATION_ARTIFACT_KIND,
  GOVERNED_INFERENCE_IMPLEMENTATION_MEDIA_TYPE,
  GOVERNED_INFERENCE_RULE_ARTIFACT_KIND,
  GOVERNED_INFERENCE_RULE_MEDIA_TYPE,
  inspectGovernedInferenceArtifactAtRoot,
} from "./inference-artifact-authority.mjs";
import {
  factInferenceCandidateIdRuntime,
  validateFactInferenceCandidateRuntime,
  validateGovernedInferenceRuleArtifactRuntime,
  type FactInferenceCandidateRecord,
  type GovernedInferenceRuleArtifact,
} from "./inference-candidate-runtime.mjs";
import { InferenceCandidateRepository, InferenceCandidateRepositoryError } from "./inference-candidate-repository";
import { createReplayableInferenceTrace, inferenceTraceIsCurrent, type ReplayableInferenceTrace } from "./inference-policy";
import type { FactRepository } from "./repository";

const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/;
const ARTIFACT_REF = /^sha256:([a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RULE_MEDIA_TYPE = GOVERNED_INFERENCE_RULE_MEDIA_TYPE;
const RULE_ARTIFACT_KIND = GOVERNED_INFERENCE_RULE_ARTIFACT_KIND;
const RULE_IMPLEMENTATION_MEDIA_TYPE = GOVERNED_INFERENCE_IMPLEMENTATION_MEDIA_TYPE;
const RULE_IMPLEMENTATION_ARTIFACT_KIND = GOVERNED_INFERENCE_IMPLEMENTATION_ARTIFACT_KIND;

export interface InferenceCandidateProposalInput {
  readonly planId: string;
  readonly ruleId: string;
  readonly target: { readonly fieldId: string };
  readonly guard: {
    readonly runtimeGeneration: number;
    readonly runtimeRevision: number;
    readonly planDraftRevision: number;
  };
}

export interface InferencePlanAuthorityResolution {
  readonly planDraftRevision: number;
  readonly planConfigHash: string;
  /** Server-selected current facts relevant to this plan. */
  readonly relevantFactIds: readonly string[];
  /** Exact product subjects proven by the plan authority to be selected by this plan. */
  readonly relevantProductSubjectKeys: readonly string[];
}

export interface InferencePlanAuthority {
  resolveAtRoot(
    activeRoot: string,
    planId: string,
    currentFacts: readonly Readonly<FactRecord>[],
  ): Promise<InferencePlanAuthorityResolution>;
}

export interface GovernedInferenceRuleExecutionResult {
  readonly inputFactIds: readonly string[];
  readonly subject: FactSubject;
  readonly scope: FactScope;
  readonly value: unknown;
  readonly unit?: string;
  readonly outputRange: { readonly min: number; readonly max: number; readonly unit?: string };
}

export interface GovernedInferenceRuleExecutionContext {
  readonly planId: string;
  readonly target: { readonly fieldId: string };
  readonly rule: Readonly<GovernedInferenceRuleArtifact>;
  readonly currentFacts: readonly Readonly<FactRecord>[];
}

export interface GovernedInferenceRuleRegistration {
  readonly ruleId: string;
  readonly implementationId: string;
  readonly implementationHash: string;
  readonly artifactRef: `sha256:${string}`;
  readonly execute: (context: GovernedInferenceRuleExecutionContext) =>
    GovernedInferenceRuleExecutionResult | Promise<GovernedInferenceRuleExecutionResult>;
}

export interface InferenceCandidateServiceOptions {
  readonly coordinator: RuntimeCoordinator;
  readonly facts: FactRepository;
  readonly artifacts: FileArtifactRepository;
  readonly candidates: InferenceCandidateRepository;
  readonly planAuthority: InferencePlanAuthority;
  readonly rules: readonly GovernedInferenceRuleRegistration[];
  readonly now?: () => string;
}

export interface InferenceCandidateCurrentAssessment {
  readonly status: "current" | "stale";
  readonly candidate: FactInferenceCandidateRecord;
  readonly reasons: readonly string[];
}

export interface ResolvedInferenceCandidateApproval {
  readonly candidate: FactInferenceCandidateRecord;
  readonly trace: ReplayableInferenceTrace;
  readonly proposedFact: FactRecord;
  readonly ruleArtifactRef: `sha256:${string}`;
}

type ErrorCode = "invalid_input" | "not_found" | "conflict" | "fenced" | "cross_plan" | "stale" | "corrupt_data";

export class InferenceCandidateServiceError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "InferenceCandidateServiceError";
  }
}

interface LoadedRule {
  readonly rule: GovernedInferenceRuleArtifact;
  readonly artifactHash: string;
  readonly registration: GovernedInferenceRuleRegistration;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function normalizedInput(value: unknown): InferenceCandidateProposalInput {
  if (!exact(value, ["planId", "ruleId", "target", "guard"])
    || !PLAN_ID.test(String(value.planId ?? "")) || !TOKEN.test(String(value.ruleId ?? ""))
    || !exact(value.target, ["fieldId"]) || !TOKEN.test(String(value.target.fieldId ?? ""))
    || !exact(value.guard, ["runtimeGeneration", "runtimeRevision", "planDraftRevision"])) {
    throw new InferenceCandidateServiceError("invalid_input", "fact inference proposal input fields are invalid");
  }
  for (const field of ["runtimeGeneration", "runtimeRevision", "planDraftRevision"] as const) {
    const number = value.guard[field];
    if (!Number.isSafeInteger(number) || Number(number) < (field === "runtimeGeneration" ? 1 : 0)) {
      throw new InferenceCandidateServiceError("invalid_input", `fact inference proposal ${field} guard is invalid`);
    }
  }
  return Object.freeze({
    planId: String(value.planId),
    ruleId: String(value.ruleId),
    target: Object.freeze({ fieldId: String(value.target.fieldId) }),
    guard: Object.freeze({
      runtimeGeneration: Number(value.guard.runtimeGeneration),
      runtimeRevision: Number(value.guard.runtimeRevision),
      planDraftRevision: Number(value.guard.planDraftRevision),
    }),
  });
}

function validatePlanAuthority(
  value: InferencePlanAuthorityResolution,
  currentFacts: readonly FactRecord[],
): InferencePlanAuthorityResolution {
  if (!exact(value, ["planDraftRevision", "planConfigHash", "relevantFactIds", "relevantProductSubjectKeys"])
    || !Number.isSafeInteger(value.planDraftRevision) || value.planDraftRevision < 0
    || !SHA256.test(String(value.planConfigHash ?? "")) || !Array.isArray(value.relevantFactIds)
    || value.relevantFactIds.length < 1 || value.relevantFactIds.some((id) => !TOKEN.test(String(id)))
    || new Set(value.relevantFactIds).size !== value.relevantFactIds.length
    || !Array.isArray(value.relevantProductSubjectKeys)
    || value.relevantProductSubjectKeys.some((key) => typeof key !== "string" || key.length < 1 || key.length > 2_048)
    || new Set(value.relevantProductSubjectKeys).size !== value.relevantProductSubjectKeys.length) {
    throw new InferenceCandidateServiceError("corrupt_data", "inference plan authority resolution is invalid");
  }
  const currentIds = new Set(currentFacts.map(({ factId }) => factId));
  if (value.relevantFactIds.some((id) => !currentIds.has(id))) {
    throw new InferenceCandidateServiceError("corrupt_data", "inference plan authority selected a non-current fact");
  }
  const selected = currentFacts.filter(({ factId }) => value.relevantFactIds.includes(factId));
  const provedProductKeys = new Set(value.relevantProductSubjectKeys);
  if (selected.some((fact) => fact.subject.kind === "product" && !provedProductKeys.has(factSubjectKey(fact.subject)))) {
    throw new InferenceCandidateServiceError("cross_plan", "inference plan authority did not prove a selected product subject");
  }
  return Object.freeze({
    planDraftRevision: value.planDraftRevision,
    planConfigHash: value.planConfigHash,
    relevantFactIds: Object.freeze([...value.relevantFactIds].sort()),
    relevantProductSubjectKeys: Object.freeze([...value.relevantProductSubjectKeys].sort()),
  });
}

function validateExecution(
  value: GovernedInferenceRuleExecutionResult,
  input: InferenceCandidateProposalInput,
  rule: GovernedInferenceRuleArtifact,
  relevantFacts: readonly FactRecord[],
  authority: InferencePlanAuthorityResolution,
): { execution: GovernedInferenceRuleExecutionResult; inputFacts: FactRecord[] } {
  if (!exact(value, ["inputFactIds", "subject", "scope", "value", "unit", "outputRange"],
    ["inputFactIds", "subject", "scope", "value", "outputRange"])
    || !Array.isArray(value.inputFactIds) || value.inputFactIds.length < 1
    || value.inputFactIds.some((id) => !TOKEN.test(String(id))) || new Set(value.inputFactIds).size !== value.inputFactIds.length
    || !exact(value.outputRange, ["min", "max", "unit"], ["min", "max"])
    || typeof value.outputRange.min !== "number" || !Number.isFinite(value.outputRange.min)
    || typeof value.outputRange.max !== "number" || !Number.isFinite(value.outputRange.max)
    || value.outputRange.min > value.outputRange.max
    || (value.outputRange.unit !== undefined && !TOKEN.test(value.outputRange.unit))) {
    throw new InferenceCandidateServiceError("corrupt_data", "allowlisted inference implementation returned an invalid result shape");
  }
  const byId = new Map(relevantFacts.map((fact) => [fact.factId, fact]));
  const ids = [...value.inputFactIds].sort();
  const inputFacts = ids.map((id) => byId.get(id)).filter((fact): fact is FactRecord => fact !== undefined);
  if (inputFacts.length !== ids.length || inputFacts.some((fact) => !rule.inputFieldIds.includes(fact.field))) {
    throw new InferenceCandidateServiceError("corrupt_data", "allowlisted inference implementation selected facts outside plan/rule authority");
  }
  const selectedFields = new Set(inputFacts.map(({ field }) => field));
  if (rule.inputFieldIds.some((field) => !selectedFields.has(field))) {
    throw new InferenceCandidateServiceError("corrupt_data", "allowlisted inference implementation omitted a required input field");
  }
  if (value.subject.kind === "plan_subject") {
    const productKeys = new Set(authority.relevantProductSubjectKeys);
    if (value.subject.planId !== input.planId
      || inputFacts.some((fact) => fact.subject.kind === "plan_subject" ? fact.subject.planId !== input.planId
        : !productKeys.has(factSubjectKey(fact.subject)))) {
      throw new InferenceCandidateServiceError("cross_plan", "inference plan subject/input belongs to another plan");
    }
    if (rule.inputFieldIds.some((field) => inputFacts.filter((fact) => fact.field === field).length !== 1
      || relevantFacts.filter((fact) => fact.field === field).length !== 1)) {
      throw new InferenceCandidateServiceError("conflict", "plan inference requires one unambiguous fact for every governed input field");
    }
  } else if (inputFacts.some((fact) => fact.subject.kind !== "product" || !same(fact.subject, value.subject))) {
    // First production contract is intentionally strict: a product inference
    // cannot splice fields from sibling SKUs, variants, revisions, or regions.
    throw new InferenceCandidateServiceError("corrupt_data", "inference product inputs do not share one exact output subject");
  }
  if (typeof value.value === "number" && (value.value < value.outputRange.min || value.value > value.outputRange.max)) {
    throw new InferenceCandidateServiceError("corrupt_data", "inference output value is outside its governed range");
  }
  if ((value.unit === undefined) !== (value.outputRange.unit === undefined)
    || (value.unit !== undefined && value.outputRange.unit !== value.unit)) {
    throw new InferenceCandidateServiceError("corrupt_data", "inference output range unit does not close to the proposed fact unit");
  }
  return {
    execution: Object.freeze({
      inputFactIds: Object.freeze(ids),
      subject: deepFreeze(clone(value.subject)) as FactSubject,
      scope: value.scope,
      value: deepFreeze(clone(value.value)),
      ...(value.unit === undefined ? {} : { unit: value.unit }),
      outputRange: Object.freeze(clone(value.outputRange)),
    }),
    inputFacts,
  };
}

export class InferenceCandidateService {
  private readonly registrations: ReadonlyMap<string, GovernedInferenceRuleRegistration>;
  private readonly now: () => string;

  constructor(readonly options: InferenceCandidateServiceOptions) {
    const registrations = new Map<string, GovernedInferenceRuleRegistration>();
    for (const registration of options.rules) {
      if (!exact(registration, ["ruleId", "implementationId", "implementationHash", "artifactRef", "execute"])
        || !TOKEN.test(registration.ruleId) || !TOKEN.test(registration.implementationId)
        || !SHA256.test(registration.implementationHash) || !ARTIFACT_REF.test(registration.artifactRef)
        || typeof registration.execute !== "function"
        || registrations.has(registration.ruleId)) {
        throw new TypeError("governed inference rule registration is invalid or duplicated");
      }
      registrations.set(registration.ruleId, Object.freeze({ ...registration }));
    }
    if (!registrations.size) throw new TypeError("governed inference rule allowlist must not be empty");
    this.registrations = registrations;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private registration(ruleId: string): GovernedInferenceRuleRegistration {
    const registration = this.registrations.get(ruleId);
    if (!registration) throw new InferenceCandidateServiceError("invalid_input", "inference rule is not allowlisted");
    return registration;
  }

  private async loadRuleAtRoot(activeRoot: string, registration: GovernedInferenceRuleRegistration): Promise<LoadedRule> {
    const match = ARTIFACT_REF.exec(registration.artifactRef);
    if (!match) throw new InferenceCandidateServiceError("corrupt_data", "allowlisted inference rule artifact ref is invalid");
    const inspected = await inspectGovernedInferenceArtifactAtRoot({
      artifacts: this.options.artifacts,
      activeRoot,
      artifactRef: registration.artifactRef,
      registration,
    });
    if (!inspected.ok) throw new InferenceCandidateServiceError("corrupt_data", inspected.reason);
    const rule = inspected.rule;
    return { rule: deepFreeze(clone(rule)) as GovernedInferenceRuleArtifact, artifactHash: match[1]!, registration };
  }

  private async resolveAuthorityAtRoot(
    activeRoot: string,
    planId: string,
    currentFacts: readonly FactRecord[],
  ): Promise<InferencePlanAuthorityResolution> {
    return validatePlanAuthority(
      await this.options.planAuthority.resolveAtRoot(activeRoot, planId, deepFreeze(clone(currentFacts))),
      currentFacts,
    );
  }

  private async buildAtRoot(
    input: InferenceCandidateProposalInput,
    activeRoot: string,
    runtimeGeneration: number,
    createdAt: string,
    provenanceGeneration = runtimeGeneration,
    currentFactsOverride?: readonly Readonly<FactRecord>[],
    proposalApprovalRef?: `sha256:${string}`,
  ): Promise<FactInferenceCandidateRecord> {
    if (proposalApprovalRef !== undefined && !ARTIFACT_REF.test(proposalApprovalRef)) {
      throw new InferenceCandidateServiceError("invalid_input", "inference proposal approval artifact ref is invalid");
    }
    const registration = this.registration(input.ruleId);
    const loaded = await this.loadRuleAtRoot(activeRoot, registration);
    if (loaded.rule.targetFieldId !== input.target.fieldId) {
      throw new InferenceCandidateServiceError("invalid_input", "inference rule is not allowlisted for the requested target field");
    }
    const policy = factFieldPolicy(input.target.fieldId);
    if (!policy) throw new InferenceCandidateServiceError("invalid_input", "inference target field is not governed");
    const currentFacts = currentFactsOverride
      ? clone(currentFactsOverride) as FactRecord[]
      : await this.options.facts.listCurrentFactsAtRoot(activeRoot, runtimeGeneration);
    const authority = await this.resolveAuthorityAtRoot(activeRoot, input.planId, currentFacts);
    if (authority.planDraftRevision !== input.guard.planDraftRevision) {
      throw new InferenceCandidateServiceError("conflict", "inference plan draft revision changed");
    }
    const relevantIds = new Set(authority.relevantFactIds);
    const relevantFacts = currentFacts.filter(({ factId }) => relevantIds.has(factId));
    const rawExecution = await loaded.registration.execute(deepFreeze({
      planId: input.planId,
      target: clone(input.target),
      rule: clone(loaded.rule),
      currentFacts: clone(relevantFacts),
    }) as GovernedInferenceRuleExecutionContext);
    const { execution, inputFacts } = validateExecution(rawExecution, input, loaded.rule, relevantFacts, authority);
    const inputFactRefs = inputFacts.map(({ factId, contentHash }) => ({ factId, contentHash }))
      .sort((left, right) => left.factId.localeCompare(right.factId));
    const proposedFactId = `fact-inference-${sha256Json({
      schemaVersion: "fact-inference-output-identity-v1",
      planId: input.planId,
      target: input.target,
      ruleArtifactRef: loaded.registration.artifactRef,
      inputFactRefs,
      subject: execution.subject,
      scope: execution.scope,
      value: execution.value,
      ...(execution.unit === undefined ? {} : { unit: execution.unit }),
      outputRange: execution.outputRange,
    })}`;
    const trace = await createReplayableInferenceTrace({
      schemaVersion: "fact-inference-v1",
      inputFactRefs,
      outputFactIds: [proposedFactId],
      engine: "rule",
      ruleOrModelId: loaded.rule.ruleId,
      ruleOrModelVersion: loaded.rule.ruleVersion,
      ruleOrModelArtifactHash: loaded.artifactHash,
      assumptions: [...loaded.rule.assumptions],
      confidence: loaded.rule.confidence,
      outputRange: clone(execution.outputRange),
      invalidationConditions: [...loaded.rule.invalidationConditions],
      createdAt,
    });
    const proposedFact = await createFactRecord({
      schemaVersion: "fact-record-v1",
      factId: proposedFactId,
      subject: clone(execution.subject),
      field: input.target.fieldId,
      value: clone(execution.value),
      ...(execution.unit === undefined ? {} : { unit: execution.unit }),
      scope: execution.scope,
      authority: "agent_inference",
      safetyClass: policy.safetyClass,
      status: "active",
      evidenceRefs: [],
      derivedFromFactIds: inputFactRefs.map(({ factId }) => factId),
      inferenceTraceId: trace.inferenceTraceId,
      extractorOrRuleVersion: loaded.rule.ruleVersion,
      assumptions: [...loaded.rule.assumptions],
      confidence: loaded.rule.confidence,
      retrievedAt: createdAt,
    });
    if (validateFactRecord(proposedFact).length || proposedFact.safetyClass !== policy.safetyClass
      || trace.outputFactIds.length !== 1 || trace.outputFactIds[0] !== proposedFact.factId
      || (policy.safetyClass !== "normal" && canFactAloneSupportSafetyPass(proposedFact))) {
      throw new InferenceCandidateServiceError("corrupt_data", "generated inference fact did not close its governed field/trace/safety policy");
    }
    const candidateId = factInferenceCandidateIdRuntime({
      planId: input.planId,
      planDraftRevision: authority.planDraftRevision,
      ruleArtifactRef: loaded.registration.artifactRef,
      inferenceTraceId: trace.inferenceTraceId,
      proposedFactId: proposedFact.factId,
      ...(proposalApprovalRef === undefined ? {} : { proposalApprovalRef }),
    });
    if (!candidateId) throw new InferenceCandidateServiceError("corrupt_data", "generated inference candidate identity is invalid");
    const material = {
      schemaVersion: "fact-inference-candidate-v1" as const,
      candidateId,
      planId: input.planId,
      planConfigHash: authority.planConfigHash,
      planDraftRevision: authority.planDraftRevision,
      runtimeGeneration: provenanceGeneration,
      ...(proposalApprovalRef === undefined ? {} : { proposalApprovalRef }),
      ruleArtifactRef: loaded.registration.artifactRef,
      rule: clone(loaded.rule),
      target: clone(input.target),
      trace,
      proposedFact,
      candidateStatus: "pending_approval" as const,
      safetyDisposition: policy.safetyClass === "normal" ? "planning_only" as const : "blocked_requires_non_inference_evidence" as const,
      maySupportSafetyPass: false as const,
      createdAt,
    };
    const candidate: FactInferenceCandidateRecord = Object.freeze({ ...material, contentHash: sha256Json(material) });
    const errors = validateFactInferenceCandidateRuntime(candidate);
    if (errors.length) throw new InferenceCandidateServiceError("corrupt_data", errors.join("; "));
    return candidate;
  }

  private async proposeInternal(
    rawInput: unknown,
    proposalApprovalRef?: `sha256:${string}`,
  ): Promise<FactInferenceCandidateRecord> {
    const input = normalizedInput(rawInput);
    this.registration(input.ruleId);
    await this.options.coordinator.initialize();
    try {
      return (await this.options.coordinator.withWrite(async ({ activeRoot, state }: {
        activeRoot: string;
        state: { runtimeGeneration: number; revision: number };
      }) => {
        if (state.runtimeGeneration !== input.guard.runtimeGeneration) {
          throw new InferenceCandidateServiceError("fenced", "inference proposal belongs to a stale runtime generation");
        }
        if (state.revision !== input.guard.runtimeRevision) {
          throw new InferenceCandidateServiceError("conflict", "inference proposal runtime revision changed");
        }
        const createdAt = new Date(this.now()).toISOString();
        const candidate = await this.buildAtRoot(
          input,
          activeRoot,
          state.runtimeGeneration,
          createdAt,
          state.runtimeGeneration,
          undefined,
          proposalApprovalRef,
        );
        return this.options.candidates.putWithinWriter({ activeRoot, state }, candidate);
      }, { expectedRevision: input.guard.runtimeRevision })).result;
    } catch (error) {
      if (error instanceof InferenceCandidateServiceError) throw error;
      if (error instanceof InferenceCandidateRepositoryError) {
        throw new InferenceCandidateServiceError(error.code, error.message);
      }
      if (error instanceof Error && /expected revision conflict/i.test(error.message)) {
        throw new InferenceCandidateServiceError("conflict", "inference proposal runtime revision changed");
      }
      throw error;
    }
  }

  async propose(rawInput: unknown): Promise<FactInferenceCandidateRecord> {
    return this.proposeInternal(rawInput);
  }

  /** Production seam: stamps the exact server-issued Tool approval artifact into the immutable candidate. */
  async proposeWithApproval(
    rawInput: unknown,
    proposalApprovalRef: `sha256:${string}`,
  ): Promise<FactInferenceCandidateRecord> {
    if (!ARTIFACT_REF.test(proposalApprovalRef)) {
      throw new InferenceCandidateServiceError("invalid_input", "inference proposal approval artifact ref is invalid");
    }
    return this.proposeInternal(rawInput, proposalApprovalRef);
  }

  private async replayAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    candidate: FactInferenceCandidateRecord,
    planId: string,
    currentFactsOverride?: readonly Readonly<FactRecord>[],
  ): Promise<FactInferenceCandidateRecord> {
    if (candidate.planId !== planId) throw new InferenceCandidateServiceError("cross_plan", "inference candidate belongs to another plan");
    const registration = this.registrations.get(candidate.rule.ruleId);
    if (!registration || registration.artifactRef !== candidate.ruleArtifactRef
      || registration.implementationId !== candidate.rule.implementationId) {
      throw new InferenceCandidateServiceError("stale", "inference candidate rule is no longer allowlisted");
    }
    const currentFacts = currentFactsOverride
      ? clone(currentFactsOverride) as FactRecord[]
      : await this.options.facts.listCurrentFactsAtRoot(activeRoot, runtimeGeneration);
    const authority = await this.resolveAuthorityAtRoot(activeRoot, planId, currentFacts);
    if (authority.planDraftRevision !== candidate.planDraftRevision || authority.planConfigHash !== candidate.planConfigHash) {
      throw new InferenceCandidateServiceError("stale", "inference candidate plan authority changed");
    }
    const loaded = await this.loadRuleAtRoot(activeRoot, registration);
    if (!same(loaded.rule, candidate.rule)
      || !await inferenceTraceIsCurrent(candidate.trace, currentFacts, loaded.artifactHash)) {
      throw new InferenceCandidateServiceError("stale", "inference candidate input facts or rule artifact changed");
    }
    const replayInput: InferenceCandidateProposalInput = {
      planId,
      ruleId: candidate.rule.ruleId,
      target: clone(candidate.target),
      guard: {
        runtimeGeneration,
        runtimeRevision: 0,
        planDraftRevision: candidate.planDraftRevision,
      },
    };
    const replay = await this.buildAtRoot(
      replayInput,
      activeRoot,
      runtimeGeneration,
      candidate.createdAt,
      candidate.runtimeGeneration,
      currentFacts,
      candidate.proposalApprovalRef,
    );
    if (!same(replay, candidate)) throw new InferenceCandidateServiceError("stale", "inference candidate replay changed");
    return replay;
  }

  async get(candidateId: string): Promise<FactInferenceCandidateRecord | null> {
    return this.options.candidates.get(candidateId);
  }

  async replay(candidateId: string, planId: string): Promise<FactInferenceCandidateRecord> {
    if (!PLAN_ID.test(planId)) throw new InferenceCandidateServiceError("invalid_input", "inference replay plan ID is invalid");
    await this.options.coordinator.initialize();
    return (await this.options.coordinator.withConsistentSnapshot(async ({ activeRoot, state }: {
      activeRoot: string;
      state: { runtimeGeneration: number };
    }) => {
      const candidate = await this.options.candidates.getAtRoot(activeRoot, candidateId);
      if (!candidate) throw new InferenceCandidateServiceError("not_found", "inference candidate was not found");
      return this.replayAtRoot(activeRoot, state.runtimeGeneration, candidate, planId);
    })).result;
  }

  async assessCurrent(candidateId: string, planId: string): Promise<InferenceCandidateCurrentAssessment> {
    const candidate = await this.options.candidates.get(candidateId);
    if (!candidate) throw new InferenceCandidateServiceError("not_found", "inference candidate was not found");
    try {
      const replay = await this.replay(candidateId, planId);
      return Object.freeze({ status: "current", candidate: replay, reasons: Object.freeze([]) });
    } catch (error) {
      if (!(error instanceof InferenceCandidateServiceError) || !["stale", "cross_plan"].includes(error.code)) throw error;
      return Object.freeze({
        status: "stale",
        candidate,
        reasons: Object.freeze([error.code === "cross_plan" ? "cross_plan" : "authority_or_input_changed"]),
      });
    }
  }

  async resolveForApproval(candidateId: string, planId: string): Promise<ResolvedInferenceCandidateApproval> {
    const candidate = await this.replay(candidateId, planId);
    return this.approvalClosure(candidate);
  }

  /**
   * Server-only root-bound approval resolver. An outer coordinator writer can
   * re-evaluate candidate, plan, facts, and executable artifact at one root and
   * immediately call FactRepository.putInferenceCandidateApprovalAtRoot.
   */
  async resolveForApprovalAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    candidateId: string,
    planId: string,
  ): Promise<ResolvedInferenceCandidateApproval> {
    if (!PLAN_ID.test(planId) || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
      throw new InferenceCandidateServiceError("invalid_input", "root-bound inference approval authority is invalid");
    }
    const candidate = await this.options.candidates.getAtRoot(activeRoot, candidateId);
    if (!candidate) throw new InferenceCandidateServiceError("not_found", "inference candidate was not found");
    return this.approvalClosure(await this.replayAtRoot(activeRoot, runtimeGeneration, candidate, planId));
  }

  /**
   * Repository authority: neither plan identity nor trace/fact values come
   * from the caller. The immutable candidate owns its plan and is replayed
   * against the exact writer root before FactRepository may publish it.
   */
  async resolveForRepositoryApprovalAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    candidateId: string,
    expectedCandidateHash: string,
  ): Promise<ResolvedInferenceCandidateApproval> {
    if (!SHA256.test(expectedCandidateHash) || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
      throw new InferenceCandidateServiceError("invalid_input", "repository inference approval authority is invalid");
    }
    const candidate = await this.options.candidates.getAtRoot(activeRoot, candidateId);
    if (!candidate) throw new InferenceCandidateServiceError("not_found", "inference candidate was not found");
    if (candidate.contentHash !== expectedCandidateHash) {
      throw new InferenceCandidateServiceError("stale", "inference candidate content hash changed");
    }
    return this.approvalClosure(await this.replayAtRoot(
      activeRoot,
      runtimeGeneration,
      candidate,
      candidate.planId,
    ));
  }

  async resolveCurrentFactAtRoot(
    activeRoot: string,
    runtimeGeneration: number,
    candidateId: string,
    expectedCandidateHash: string,
    currentFacts: readonly Readonly<FactRecord>[],
  ): Promise<ResolvedInferenceCandidateApproval | null> {
    if (!SHA256.test(expectedCandidateHash) || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 1) {
      throw new InferenceCandidateServiceError("invalid_input", "current inference fact authority is invalid");
    }
    const candidate = await this.options.candidates.getAtRoot(activeRoot, candidateId);
    if (!candidate || candidate.contentHash !== expectedCandidateHash) return null;
    try {
      return this.approvalClosure(await this.replayAtRoot(
        activeRoot,
        runtimeGeneration,
        candidate,
        candidate.planId,
        currentFacts,
      ));
    } catch (error) {
      if (error instanceof InferenceCandidateServiceError
        && ["not_found", "cross_plan", "stale", "conflict"].includes(error.code)) return null;
      throw error;
    }
  }

  private approvalClosure(candidate: FactInferenceCandidateRecord): ResolvedInferenceCandidateApproval {
    if (candidate.proposedFact.authority !== "agent_inference"
      || candidate.trace.outputFactIds.length !== 1 || candidate.trace.outputFactIds[0] !== candidate.proposedFact.factId
      || candidate.proposedFact.field !== candidate.target.fieldId || candidate.maySupportSafetyPass !== false
      || (candidate.proposedFact.safetyClass !== "normal"
        && candidate.safetyDisposition !== "blocked_requires_non_inference_evidence")
      || (candidate.proposedFact.safetyClass !== "normal" && canFactAloneSupportSafetyPass(candidate.proposedFact))) {
      throw new InferenceCandidateServiceError("corrupt_data", "inference candidate approval closure is invalid");
    }
    return Object.freeze({
      candidate,
      trace: clone(candidate.trace),
      proposedFact: clone(candidate.proposedFact),
      ruleArtifactRef: candidate.ruleArtifactRef,
    });
  }
}

export function inferenceRuleArtifactInput(rule: GovernedInferenceRuleArtifact, createdAt: string): {
  bytes: Buffer;
  mediaType: typeof RULE_MEDIA_TYPE;
  privacyClass: "runtime_internal";
  kind: typeof RULE_ARTIFACT_KIND;
  createdAt: string;
  references: readonly [{ readonly ref: `sha256:${string}`; readonly necessity: "required_for_replay" }];
} {
  const errors = validateGovernedInferenceRuleArtifactRuntime(rule);
  if (errors.length) throw new TypeError(errors.join("; "));
  return Object.freeze({
    bytes: Buffer.from(JSON.stringify(rule), "utf8"),
    mediaType: RULE_MEDIA_TYPE,
    privacyClass: "runtime_internal",
    kind: RULE_ARTIFACT_KIND,
    createdAt,
    references: Object.freeze([Object.freeze({
      ref: `sha256:${rule.implementationHash}` as const,
      necessity: "required_for_replay" as const,
    })]) as readonly [{ readonly ref: `sha256:${string}`; readonly necessity: "required_for_replay" }],
  });
}

export function inferenceRuleImplementationArtifactInput(
  execute: GovernedInferenceRuleRegistration["execute"],
  createdAt: string,
): {
  bytes: Buffer;
  mediaType: typeof RULE_IMPLEMENTATION_MEDIA_TYPE;
  privacyClass: "runtime_internal";
  kind: typeof RULE_IMPLEMENTATION_ARTIFACT_KIND;
  createdAt: string;
  references: readonly never[];
} {
  if (typeof execute !== "function") throw new TypeError("governed inference implementation must be executable");
  return Object.freeze({
    bytes: Buffer.from(Function.prototype.toString.call(execute), "utf8"),
    mediaType: RULE_IMPLEMENTATION_MEDIA_TYPE,
    privacyClass: "runtime_internal",
    kind: RULE_IMPLEMENTATION_ARTIFACT_KIND,
    createdAt,
    references: Object.freeze([]),
  });
}

export const BUILTIN_INFERENCE_RULE_IDS = Object.freeze({
  GPU_LENGTH_CLEARANCE: "planning.gpu-length-clearance.v1",
} as const);

function builtinGpuLengthClearanceRule(implementationHash: string): GovernedInferenceRuleArtifact {
  return Object.freeze({
  schemaVersion: "governed-inference-rule-v1" as const,
  ruleId: BUILTIN_INFERENCE_RULE_IDS.GPU_LENGTH_CLEARANCE,
  ruleVersion: "1.0.0",
  implementationId: "builtin.gpu-length-clearance.v1",
  implementationHash,
  engine: "rule" as const,
  targetFieldId: "physical.clearance",
  inputFieldIds: Object.freeze(["case.gpu_max_length", "gpu.length"]),
  formula: "clearance_mm = case.gpu_max_length - gpu.length",
  parameters: Object.freeze({ placementId: "gpu-length-clearance", uncertaintyMm: 2 }),
  assumptions: Object.freeze([
    "case and GPU dimensions use the same millimetre reference datum",
    "no bracket or connector protrusion exceeds documented dimensions",
  ]),
  confidence: 0.7,
  invalidationConditions: Object.freeze([
    "input_fact_hash_changed",
    "plan_revision_changed",
    "rule_artifact_changed",
  ]),
  });
}

/** Pure production allowlist authority; no repository read or write is needed. */
export function builtinInferenceRuleRegistrations(): readonly GovernedInferenceRuleRegistration[] {
  const executableBytes = Buffer.from(Function.prototype.toString.call(executeGpuLengthClearanceV1), "utf8");
  const implementationHash = sha256Bytes(executableBytes);
  const rule = builtinGpuLengthClearanceRule(implementationHash);
  const artifactHash = sha256Bytes(Buffer.from(JSON.stringify(rule), "utf8"));
  return Object.freeze([Object.freeze({
    ruleId: rule.ruleId,
    implementationId: rule.implementationId,
    implementationHash,
    artifactRef: `sha256:${artifactHash}` as const,
    execute: executeGpuLengthClearanceV1 as GovernedInferenceRuleRegistration["execute"],
  })]);
}

/**
 * Installs immutable built-in rule bytes and returns the only executable
 * registrations production composition should place on its allowlist.
 */
export async function ensureBuiltinInferenceRuleRegistrations(
  artifacts: FileArtifactRepository,
  now: () => string = () => new Date().toISOString(),
): Promise<readonly GovernedInferenceRuleRegistration[]> {
  // Hash the exact function body this process will execute. This survives
  // source and bundled layouts without relying on a sidecar source file; a
  // production bundle change naturally produces a new governed artifact.
  const [registration] = builtinInferenceRuleRegistrations();
  if (!registration) throw new TypeError("built-in inference allowlist is empty");
  const implementation = await artifacts.put(inferenceRuleImplementationArtifactInput(registration.execute, now()));
  const implementationHash = implementation.record.sha256;
  const rule = builtinGpuLengthClearanceRule(implementationHash);
  const stored = await artifacts.put(inferenceRuleArtifactInput(rule, now()));
  if (implementation.record.ref !== `sha256:${registration.implementationHash}`
    || stored.record.ref !== registration.artifactRef) {
    throw new TypeError("persisted built-in inference artifacts differ from the production allowlist");
  }
  return Object.freeze([registration]);
}

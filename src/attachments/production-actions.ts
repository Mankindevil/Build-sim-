import type { AgentToolContext } from "../agent/contracts";
import { agentAuditHash } from "../agent/audit";
import { assertValidatedAgentWriteApprovalProof } from "../agent/write-approval-authority";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { FileEvidenceRepository } from "../evidence/repository.mjs";
import { EvidenceClaimRepository } from "../evidence/claim-repository";
import {
  OfficialClaimCandidateRepository,
  createFilePlanClaimCandidateAuthority,
} from "../evidence/claim-candidate-repository";
import { ThirdPartyClaimCandidateRepository } from "../evidence/third-party-claim-candidate-repository";
import { EvidenceBindingProposalRepository } from "../evidence/binding-proposal-repository";
import { FactRepository } from "../facts/repository";
import { InferenceCandidateRepository } from "../facts/inference-candidate-repository";
import {
  type InferenceCandidateService,
} from "../facts/inference-candidate-service";
import {
  ProductionInferenceRuleRegistry,
  createFilePlanInferenceAuthority,
} from "../facts/inference-production";
import { ObservationRepository } from "../observations/repository";
import type { ObservationSubjectRef } from "../observations/contracts";
import { resolveObservationProjectionContext } from "../observations/subject-resolution";
import { FilePlanAgentContextAuditStore } from "../plans/agent-context-audit";
import { hashPlanConfig } from "../plans/canonical";
import { FilePlanRepository } from "../plans/file-repository";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import type { GovernedEvidenceFactToolActions, GovernedInferenceToolActions } from "../server/domain-tools";
import { AgentAttachmentActions, AgentAttachmentActionError, type ResolvedAgentPlanScope } from "./agent-actions";
import { GovernedAgentProposalRepository } from "./governed-proposal-repository";
import { AttachmentRepository } from "./repository";
import { StagedAttachmentUploadRepository } from "./staged-upload-repository";
import type { AttachmentInspectionAdapters, AttachmentInspectionLimits } from "./security";
import { createProductionAttachmentInspectionAdapters } from "./production-inspection-adapters";

export class ProductionGovernedActionError extends Error {
  constructor(readonly code: "claim_not_found" | "claim_not_official" | "fact_not_found" | "conflict_not_found" | "conflict_invalid" | "proposal_not_found" | "proposal_invalid", message: string) {
    super(message);
    this.name = "ProductionGovernedActionError";
  }
}

export interface ProductionGovernedAgentActionsOptions {
  coordinator: RuntimeCoordinator;
  runtimeRoot: string;
  topologyV3Enabled?: boolean;
  stagedUploads?: StagedAttachmentUploadRepository;
  inspectionAdapters?: AttachmentInspectionAdapters;
  inspectionLimits?: Partial<AttachmentInspectionLimits>;
  environment?: Record<string, string | undefined>;
  now?: () => string;
}

export interface ProductionGovernedAgentActions {
  attachmentActions: AgentAttachmentActions;
  evidenceFactActions: GovernedEvidenceFactToolActions;
  stagedUploads: StagedAttachmentUploadRepository;
  attachments: AttachmentRepository;
  observations: ObservationRepository;
  proposals: GovernedAgentProposalRepository;
  claimCandidates: OfficialClaimCandidateRepository;
  thirdPartyClaimCandidates: ThirdPartyClaimCandidateRepository;
  bindingProposals: EvidenceBindingProposalRepository;
  facts: FactRepository;
  artifacts: FileArtifactRepository;
  inferenceCandidates: InferenceCandidateRepository;
  inferenceRegistry: ProductionInferenceRuleRegistry;
  inferenceEnabled: boolean;
  inferenceActions?: GovernedInferenceToolActions;
  initializeInference(): Promise<void>;
  resolvePlanScope(context: AgentToolContext): Promise<ResolvedAgentPlanScope>;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function inferenceApprovalRef(
  context: AgentToolContext,
  toolName: "propose_agent_inference" | "approve_agent_inference",
  input: unknown,
): `sha256:${string}` {
  const proof = context.writeApprovalProof;
  if (!proof) {
    throw new AgentAttachmentActionError("approval_authority_required", "inference write requires server-issued durable approval authority");
  }
  assertValidatedAgentWriteApprovalProof(proof, {
    toolName,
    toolDefinitionHash: proof.execution.toolDefinitionHash,
    sessionId: context.sessionId,
    runId: context.runId,
    inputHash: agentAuditHash(input),
    callId: proof.execution.callId,
  });
  if (!/^sha256:[a-f0-9]{64}$/.test(proof.authorityRef)) {
    throw new AgentAttachmentActionError("approval_authority_required", "inference approval artifact ref is invalid");
  }
  return proof.authorityRef as `sha256:${string}`;
}

function stagedUploadConsumerKey(context: AgentToolContext): string {
  if (!context.approval) {
    throw new AgentAttachmentActionError("approval_authority_required", "staged attachment claim requires dispatcher-bound approval authority");
  }
  return [
    "archive_user_attachment",
    context.sessionId,
    context.runId,
    context.approval.approvalId,
    context.approval.idempotencyKey,
  ].join("\0");
}

/**
 * Production composition for the eight U4 tools. Plan ownership comes from the
 * workspace-issued run audit, never Tool or message transport fields.
 */
export function createProductionGovernedAgentActions(options: ProductionGovernedAgentActionsOptions): ProductionGovernedAgentActions {
  const now = options.now ?? (() => new Date().toISOString());
  const plans = new FilePlanRepository({
    coordinator: options.coordinator,
    runtimeRoot: options.runtimeRoot,
    topologyV3Enabled: options.topologyV3Enabled === true,
    // Every read performed under the coordinator barrier resolves the exact
    // merged catalog from that same active generation. Bundled defaults must
    // not reject a valid overlay-backed plan or drift across restore.
    getCatalogAtRoot: (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }),
  });
  const planAudits = new FilePlanAgentContextAuditStore({ coordinator: options.coordinator });
  const attachments = new AttachmentRepository({ coordinator: options.coordinator, runtimeRoot: options.runtimeRoot, now });
  const observations = new ObservationRepository({
    coordinator: options.coordinator,
    runtimeRoot: options.runtimeRoot,
    attachments,
    now,
    projectionContextForObservation: async (observation) => {
      const plan = await plans.get(observation.planId);
      return resolveObservationProjectionContext(observation.planId, plan.draft.config, observation.subjectRef);
    },
  });
  const evidence = new FileEvidenceRepository({ coordinator: options.coordinator, runtimeRoot: options.runtimeRoot });
  const claims = new EvidenceClaimRepository({ coordinator: options.coordinator, runtimeRoot: options.runtimeRoot, evidence });
  const artifacts = new FileArtifactRepository({ coordinator: options.coordinator, now });
  const inferenceCandidates = new InferenceCandidateRepository(options.coordinator);
  const inferenceRegistry = new ProductionInferenceRuleRegistry(options.environment ?? {});
  const inferenceApprovalCapability = Object.freeze({ kind: "production-agent-inference-approval" });
  let resolveInferenceApprovalAtRoot: InferenceCandidateService["resolveForRepositoryApprovalAtRoot"] | null = null;
  const facts = new FactRepository({
    coordinator: options.coordinator,
    runtimeRoot: options.runtimeRoot,
    evidenceClaims: claims,
    observations,
    currentInferenceArtifactHash: inferenceRegistry.currentArtifactHash,
    requireCandidateApprovalForInference: true,
    inferenceCandidateApprovalAuthority: {
      approvalCapability: inferenceApprovalCapability,
      async resolveForApprovalAtRoot(activeRoot, runtimeGeneration, candidateId, expectedCandidateHash) {
        if (!inferenceRegistry.enabled || !resolveInferenceApprovalAtRoot) {
          throw new ProductionGovernedActionError("proposal_invalid", "agent inference approval authority is disabled");
        }
        return resolveInferenceApprovalAtRoot(activeRoot, runtimeGeneration, candidateId, expectedCandidateHash);
      },
      async resolveCurrentFactAtRoot(
        activeRoot,
        runtimeGeneration,
        candidateId,
        expectedCandidateHash,
        currentFacts,
      ) {
        if (!inferenceRegistry.enabled || !inferenceServicePromise) return null;
        const service = await inferenceServicePromise;
        return service.resolveCurrentFactAtRoot(
          activeRoot,
          runtimeGeneration,
          candidateId,
          expectedCandidateHash,
          currentFacts,
        );
      },
    },
    now,
  });
  const proposals = new GovernedAgentProposalRepository(options.coordinator, now);
  const claimCandidatePlanAuthority = createFilePlanClaimCandidateAuthority({
    ...(options.topologyV3Enabled === undefined ? {} : { topologyV3Enabled: options.topologyV3Enabled }),
  });
  const claimCandidates = new OfficialClaimCandidateRepository({
    coordinator: options.coordinator,
    runtimeRoot: options.runtimeRoot,
    now,
    planAuthority: claimCandidatePlanAuthority,
  });
  const thirdPartyClaimCandidates = new ThirdPartyClaimCandidateRepository({
    coordinator: options.coordinator,
    runtimeRoot: options.runtimeRoot,
    now,
    planAuthority: claimCandidatePlanAuthority,
  });
  const bindingProposals = new EvidenceBindingProposalRepository({
    coordinator: options.coordinator,
    runtimeRoot: options.runtimeRoot,
    now,
    planAuthority: claimCandidatePlanAuthority,
  });
  const stagedUploads = options.stagedUploads ?? new StagedAttachmentUploadRepository({ coordinator: options.coordinator, now });
  const inspectionAdapters = options.inspectionAdapters ?? createProductionAttachmentInspectionAdapters();
  const inferencePlanAuthority = createFilePlanInferenceAuthority({
    ...(options.topologyV3Enabled === undefined ? {} : { topologyV3Enabled: options.topologyV3Enabled }),
  });

  let inferenceServicePromise: Promise<InferenceCandidateService> | null = null;
  let inferenceInitializationPromise: Promise<void> | null = null;
  const inferenceService = (): Promise<InferenceCandidateService> => {
    if (!inferenceRegistry.enabled) {
      return Promise.reject(new ProductionGovernedActionError(
        "proposal_invalid",
        "agent inference writes are disabled",
      ));
    }
    inferenceServicePromise ??= inferenceRegistry.createService(artifacts, {
      coordinator: options.coordinator,
      facts,
      candidates: inferenceCandidates,
      planAuthority: inferencePlanAuthority,
      now,
    }, now).then((service) => {
      resolveInferenceApprovalAtRoot = service.resolveForRepositoryApprovalAtRoot.bind(service);
      return service;
    });
    return inferenceServicePromise;
  };

  const initializeInference = async (): Promise<void> => {
    if (!inferenceRegistry.enabled) return;
    if (!inferenceInitializationPromise) {
      inferenceInitializationPromise = inferenceService()
        .then(async () => { await facts.recoverPendingInferenceApprovals(); })
        .catch((error: unknown) => {
          inferenceInitializationPromise = null;
          throw error;
        });
    }
    await inferenceInitializationPromise;
  };

  const resolvePlanScope = async (context: AgentToolContext): Promise<ResolvedAgentPlanScope> => {
    const audit = await planAudits.get(context.runId);
    if (!audit || audit.sessionId !== context.sessionId) {
      throw new AgentAttachmentActionError("plan_authority_invalid", "workspace-issued Agent run plan authority is unavailable");
    }
    const plan = await plans.get(audit.planId);
    const currentConfigHash = await hashPlanConfig(plan.draft.config);
    if (currentConfigHash !== audit.configHash || plan.draftRevision !== audit.draftRevision || plan.activeVersionId !== audit.planVersionId) {
      throw new AgentAttachmentActionError("plan_authority_invalid", "workspace-issued Agent run plan authority is stale");
    }
    return {
      planId: plan.id,
      configHash: currentConfigHash,
      async resolveSubjectRevision(subjectRef: ObservationSubjectRef) {
        const projection = await resolveObservationProjectionContext(plan.id, plan.draft.config, subjectRef);
        return { exists: projection.subjectExists, subjectRevisionHash: projection.currentSubjectRevisionHash };
      },
    };
  };

  const attachmentActions = new AgentAttachmentActions({
    attachments,
    observations,
    resolvePlanScope,
    resolveStagedUpload: (uploadId, context) => stagedUploads.claim(
      uploadId,
      context.sessionId,
      stagedUploadConsumerKey(context),
    ),
    consumeStagedUpload: (uploadId, context, attachmentId) => stagedUploads.consume(
      uploadId,
      context.sessionId,
      stagedUploadConsumerKey(context),
      attachmentId,
    ),
    inspectionAdapters,
    ...(options.inspectionLimits ? { inspectionLimits: options.inspectionLimits } : {}),
    now,
  });

  const evidenceFactActions: GovernedEvidenceFactToolActions = {
    async archiveOfficialEvidence(input, context) {
      if (!context.writeApprovalProof) {
        throw new ProductionGovernedActionError("proposal_invalid", "server-issued durable write approval proof is required");
      }
      const scope = await resolvePlanScope(context);
      const promoted = await claimCandidates.promoteOfficial(input.candidateId, scope.planId, {
        proof: context.writeApprovalProof,
        approvedInput: input,
      })
        .catch((error: unknown) => {
          if (error instanceof Error) throw error;
          throw new ProductionGovernedActionError("claim_not_found", "official evidence candidate was not found");
        });
      const claim = promoted.claim;
      return proposals.put({
        action: "archive_official_evidence",
        planId: scope.planId,
        context,
        payload: {
          candidateId: promoted.candidate.candidateId,
          candidateHash: promoted.candidate.contentHash,
          activeClaimId: claim.claimId,
          activeClaimHash: claim.contentHash,
          authority: claim.authority,
          scope: claim.scope,
          subject: claim.subject,
          documentId: claim.source.documentId,
          documentSha256: claim.source.documentSha256,
          captureId: claim.source.captureId,
          originalCaptureId: promoted.originalCaptureId,
          promotionConfirmationId: promoted.candidate.promotion.confirmationId,
          exactIdentityRecheckedByClaimRepository: true,
        },
      });
    },

    async proposeFactUpdate(input, context) {
      if (!context.writeApprovalProof) {
        throw new ProductionGovernedActionError("proposal_invalid", "server-issued durable write approval proof is required");
      }
      const scope = await resolvePlanScope(context);
      if ((input.intent === "create") === (input.targetFactId !== undefined)) {
        throw new ProductionGovernedActionError(
          "proposal_invalid",
          input.intent === "create"
            ? "a create proposal cannot replace a caller-selected target fact"
            : "replace/withdraw proposals require an existing target fact",
        );
      }
      const activated = input.claimCandidateId.startsWith("third-party-claim-candidate-sha256-")
        ? await thirdPartyClaimCandidates.activateThirdParty(input.claimCandidateId, scope.planId, {
          proof: context.writeApprovalProof,
          approvedInput: input,
        })
        : null;
      const claim = activated?.claim ?? await claims.getClaim(input.claimCandidateId).catch(() => null);
      if (!claim || claim.status !== "active") throw new ProductionGovernedActionError("claim_not_found", "active evidence claim candidate was not found");
      const target = input.targetFactId ? await facts.getFact(input.targetFactId).catch(() => null) : null;
      if (input.targetFactId && !target) throw new ProductionGovernedActionError("fact_not_found", "target fact was not found");
      if (target && (target.field !== claim.fieldId || target.subject.kind !== "product" || !same({
        skuId: target.subject.skuId,
        familyId: target.subject.familyId,
        modelId: target.subject.modelId,
        variantId: target.subject.variantId,
        revision: target.subject.revision,
        region: target.subject.region,
      }, {
        skuId: claim.subject.skuId,
        familyId: claim.subject.familyId,
        modelId: claim.subject.modelId,
        variantId: claim.subject.variantId,
        revision: claim.subject.revision,
        region: claim.subject.region,
      }))) throw new ProductionGovernedActionError("proposal_invalid", "target fact does not share the claim's governed subject and field");
      return proposals.put({
        action: "propose_fact_update",
        planId: scope.planId,
        context,
        payload: {
          claimCandidateId: claim.claimId,
          claimCandidateHash: claim.contentHash,
          claimAuthority: claim.authority,
          claimFieldId: claim.fieldId,
          claimSubject: claim.subject,
          ...(activated ? {
            sourceCandidateId: activated.candidate.candidateId,
            sourceCandidateHash: activated.candidate.contentHash,
          } : {}),
          intent: input.intent,
          ...(target ? { targetFactId: target.factId, targetFactHash: target.contentHash } : {}),
        },
      });
    },

    async bindFactEvidence(input, context) {
      const scope = await resolvePlanScope(context);
      const binding = await bindingProposals.getForPlan(input.bindingProposalId, scope.planId);
      const source = await proposals.get(input.factUpdateProposalId).catch(() => null);
      if (!source) throw new ProductionGovernedActionError("proposal_not_found", "fact update proposal was not found");
      if (source.action !== "propose_fact_update" || source.planId !== scope.planId) {
        throw new ProductionGovernedActionError("proposal_invalid", "fact update proposal is cross-plan or has the wrong action");
      }
      const claim = await claims.getClaim(input.evidenceClaimId).catch(() => null);
      if (!claim || claim.status !== "active") throw new ProductionGovernedActionError("claim_not_found", "active evidence claim was not found");
      const sourceClaimId = (source.payload as { claimCandidateId?: unknown }).claimCandidateId;
      if (sourceClaimId !== claim.claimId) throw new ProductionGovernedActionError("proposal_invalid", "evidence claim does not own the fact update proposal");
      const sourceCandidateId = (source.payload as { sourceCandidateId?: unknown }).sourceCandidateId;
      let bindingOwnsClaim = typeof sourceCandidateId === "string" && binding.proposal.claimCandidateIds.includes(sourceCandidateId);
      if (!bindingOwnsClaim) {
        const activeMaterial = structuredClone(claim) as unknown as Record<string, unknown> & { source: Record<string, unknown> };
        delete activeMaterial.claimId;
        delete activeMaterial.contentHash;
        for (const candidateId of binding.proposal.claimCandidateIds.filter((candidateId) => candidateId.startsWith("claim-candidate-sha256-"))) {
          const candidate = await claimCandidates.get(candidateId).catch(() => null);
          if (!candidate || candidate.planId !== scope.planId) continue;
          const candidateMaterial = structuredClone(candidate.claim) as unknown as Record<string, unknown> & { source: Record<string, unknown> };
          candidateMaterial.source.captureId = claim.source.captureId;
          delete candidateMaterial.claimId;
          delete candidateMaterial.contentHash;
          if (same(candidateMaterial, activeMaterial)) { bindingOwnsClaim = true; break; }
        }
      }
      if (!bindingOwnsClaim) throw new ProductionGovernedActionError("proposal_invalid", "durable binding proposal does not own this evidence claim candidate");
      return proposals.put({
        action: "bind_fact_evidence",
        planId: scope.planId,
        context,
        payload: {
          factUpdateProposalId: source.proposalId,
          factUpdateProposalHash: source.contentHash,
          evidenceClaimId: claim.claimId,
          evidenceClaimHash: claim.contentHash,
          bindingProposalId: binding.proposal.bindingProposalId,
          bindingProposalHash: binding.proposal.contentHash,
        },
      });
    },

    async resolveFactConflict(input, context) {
      const scope = await resolvePlanScope(context);
      const conflict = await facts.getConflict(input.conflictSetId).catch(() => null);
      if (!conflict) throw new ProductionGovernedActionError("conflict_not_found", "fact conflict set was not found");
      if (conflict.status !== "open") throw new ProductionGovernedActionError("conflict_invalid", "only an open fact conflict can receive a resolution proposal");
      const selected = input.selectedFactId ? await facts.getFact(input.selectedFactId).catch(() => null) : null;
      if (input.resolution === "select_existing" && (!selected || !conflict.factIds.includes(selected.factId))) {
        throw new ProductionGovernedActionError("conflict_invalid", "selected fact is not a member of the conflict set");
      }
      return proposals.put({
        action: "resolve_fact_conflict",
        planId: scope.planId,
        context,
        payload: {
          conflictSetId: conflict.conflictSetId,
          conflictSetHash: conflict.contentHash,
          resolution: input.resolution,
          ...(selected ? { selectedFactId: selected.factId, selectedFactHash: selected.contentHash } : {}),
        },
      });
    },
  };

  const inferenceActions: GovernedInferenceToolActions | undefined = inferenceRegistry.enabled ? {
    async proposeAgentInference(input, context) {
      const approvalAuthorityRef = inferenceApprovalRef(context, "propose_agent_inference", input);
      await initializeInference();
      const scope = await resolvePlanScope(context);
      const plan = await plans.get(scope.planId);
      if (plan.draftRevision !== input.guard.planDraftRevision) {
        throw new ProductionGovernedActionError("proposal_invalid", "inference proposal plan draft revision changed");
      }
      const state = await options.coordinator.readState();
      return (await inferenceService()).proposeWithApproval({
        planId: scope.planId,
        ruleId: input.ruleId,
        target: input.target,
        guard: {
          runtimeGeneration: state.runtimeGeneration,
          runtimeRevision: state.revision,
          planDraftRevision: plan.draftRevision,
        },
      }, approvalAuthorityRef);
    },

    async approveAgentInference(input, context) {
      const approvalAuthorityRef = inferenceApprovalRef(context, "approve_agent_inference", input);
      await initializeInference();
      const scope = await resolvePlanScope(context);
      const service = await inferenceService();
      return (await options.coordinator.withWrite(async ({ activeRoot, state }: {
        activeRoot: string;
        state: { runtimeGeneration: number };
      }) => {
        const resolved = await service.resolveForApprovalAtRoot(
          activeRoot,
          state.runtimeGeneration,
          input.candidateId,
          scope.planId,
        );
        const committed = await facts.putInferenceCandidateApprovalAtRoot(activeRoot, state.runtimeGeneration, {
          candidateId: resolved.candidate.candidateId,
          expectedCandidateHash: resolved.candidate.contentHash,
          approvalCapability: inferenceApprovalCapability,
          approvalAuthorityRef,
        });
        return {
          schemaVersion: "agent-inference-approval-result-v1" as const,
          status: "fact_activated" as const,
          candidateId: resolved.candidate.candidateId,
          candidateHash: resolved.candidate.contentHash,
          ruleArtifactRef: resolved.ruleArtifactRef,
          transactionId: committed.transactionId,
          trace: committed.trace,
          fact: committed.fact,
          authorityEffects: {
            claimActivated: false as const,
            factActivated: true as const,
          },
          maySupportSafetyPass: false as const,
        };
      })).result;
    },
  } : undefined;

  return {
    attachmentActions,
    evidenceFactActions,
    stagedUploads,
    attachments,
    observations,
    proposals,
    claimCandidates,
    thirdPartyClaimCandidates,
    bindingProposals,
    facts,
    artifacts,
    inferenceCandidates,
    inferenceRegistry,
    inferenceEnabled: inferenceRegistry.enabled,
    ...(inferenceActions ? { inferenceActions } : {}),
    initializeInference,
    resolvePlanScope,
  };
}

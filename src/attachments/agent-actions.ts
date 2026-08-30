import { createHash } from "node:crypto";
import type { AgentToolContext } from "../agent/contracts";
import { OBSERVATION_FIELD_REGISTRY, UNIT_REGISTRY, type ObservationFieldId, type UnitId } from "../contracts/registries";
import {
  validateObservationSubjectRef,
  validateUserObservation,
  type ObservationSubjectRef,
  type ObservationUncertainty,
  type UserObservation,
} from "../observations/contracts";
import type { ObservationRepository } from "../observations/repository";
import { canonicalJson } from "../plans/canonical";
import type { AttachmentRepository } from "./repository";
import {
  inspectAttachmentBytes,
  toPublicAttachmentInspection,
  type AttachmentInspectionAdapters,
  type AttachmentInspectionLimits,
  type PublicAttachmentInspection,
} from "./security";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const AGENT_OBSERVATION_METHODS = ["measurement", "photo", "label", "visual_confirmation", "user_assertion"] as const;
export const AGENT_OBSERVATION_FIELD_IDS = Object.freeze(Object.keys(OBSERVATION_FIELD_REGISTRY)) as readonly ObservationFieldId[];
export const AGENT_OBSERVATION_UNIT_IDS = Object.freeze(Object.keys(UNIT_REGISTRY)) as readonly UnitId[];

export class AgentAttachmentActionError extends Error {
  constructor(
    readonly code:
      | "approval_authority_required"
      | "plan_authority_invalid"
      | "subject_not_found"
      | "upload_not_found"
      | "attachment_not_found"
      | "cross_plan_attachment"
      | "observation_not_found"
      | "observation_not_proposed"
      | "observation_invalid",
    message: string,
  ) {
    super(message);
    this.name = "AgentAttachmentActionError";
  }
}

export interface ResolvedAgentPlanScope {
  planId: string;
  configHash: string;
  resolveSubjectRevision(subjectRef: ObservationSubjectRef): Promise<{ exists: boolean; subjectRevisionHash: string }>;
}

export type AgentPlanScopeResolver = (context: AgentToolContext) => Promise<ResolvedAgentPlanScope>;

export interface StagedAttachmentUpload {
  bytes: Buffer | Uint8Array | ArrayBuffer;
  declaredMediaType: string;
  /** Display-only, untrusted metadata. It is never used as a path. */
  originalFileName?: string;
}

export type StagedAttachmentUploadResolver = (uploadId: string, context: AgentToolContext) => Promise<StagedAttachmentUpload | null>;
export type StagedAttachmentUploadConsumer = (
  uploadId: string,
  context: AgentToolContext,
  attachmentId: string,
) => Promise<void>;

export interface ArchiveUserAttachmentInput {
  uploadId: string;
  deletionPolicy: "retain_until_user_deletes" | "delete_after_extraction";
}

export interface InspectArchivedAttachmentInput {
  attachmentId: string;
  extractText?: boolean;
}

export interface ProposeUserObservationInput {
  subjectRef: ObservationSubjectRef;
  fieldId: ObservationFieldId;
  value: unknown;
  unit?: UnitId;
  uncertainty?: ObservationUncertainty;
  method: typeof AGENT_OBSERVATION_METHODS[number];
  attachmentIds?: string[];
}

export interface BindObservationAttachmentInput {
  observationProposalId: string;
  attachmentId: string;
}

export interface ArchivedUserAttachmentResult {
  schemaVersion: "agent-user-attachment-archive-v1";
  status: "archived_private_plan_attachment";
  attachmentId: string;
  planId: string;
  originalContentHash: string;
  inspection: PublicAttachmentInspection;
  contentTrust: "untrusted_user_attachment";
  scope: "plan_only";
  mayPromoteOfficialFact: false;
  observationActivationRequiresSeparateApproval: true;
}

export interface UserObservationProposalResult {
  schemaVersion: "agent-user-observation-proposal-v1";
  proposal: UserObservation;
  status: "proposed";
  scope: "plan_only";
  evidenceTrust: "untrusted_user_attachment_or_user_assertion";
  mayPromoteOfficialFact: false;
  activation: { required: true; automatic: false; requiresCurrentPlanAndSubjectRevision: true };
}

export interface ObservationAttachmentBindingProposalResult {
  schemaVersion: "agent-observation-attachment-binding-proposal-v1";
  proposalId: string;
  status: "proposed";
  planId: string;
  sourceObservationProposalId: string;
  boundObservationProposalId: string;
  attachmentId: string;
  contentHash: string;
  scope: "plan_only";
  mayPromoteOfficialFact: false;
  activation: { required: true; automatic: false };
}

export interface AgentAttachmentActionsOptions {
  attachments: Pick<AttachmentRepository, "put" | "get" | "readBlob" | "hasAvailable">;
  observations: Pick<ObservationRepository, "put" | "get">;
  resolvePlanScope: AgentPlanScopeResolver;
  resolveStagedUpload: StagedAttachmentUploadResolver;
  /** Commits the exact staged claim only after the immutable raw-byte write succeeds. */
  consumeStagedUpload?: StagedAttachmentUploadConsumer;
  inspectionAdapters?: AttachmentInspectionAdapters;
  inspectionLimits?: Partial<AttachmentInspectionLimits>;
  now?: () => string;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function observationHash(observation: Omit<UserObservation, "contentHash">): string {
  return digest(canonicalJson(observation));
}

function deterministicId(prefix: string, context: AgentToolContext, suffix = ""): string {
  if (!context.approval) throw new AgentAttachmentActionError("approval_authority_required", "attachment/observation write requires dispatcher-bound approval authority");
  const hash = digest(`${context.sessionId}\0${context.approval.idempotencyKey}\0${suffix}`);
  return `${prefix}-${hash.slice(0, 40)}`;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new AgentAttachmentActionError("observation_invalid", `${label} is invalid`);
}

function assertScope(scope: ResolvedAgentPlanScope): void {
  if (!SAFE_ID.test(scope.planId) || !SHA256.test(scope.configHash) || typeof scope.resolveSubjectRevision !== "function") {
    throw new AgentAttachmentActionError("plan_authority_invalid", "server-resolved plan scope is invalid");
  }
}

/**
 * Implements the private attachment and UserObservation side of Agent tools.
 * It never keeps an in-process authority map: upload bytes, plan bindings and
 * proposal records all come from injected durable/server-owned boundaries.
 */
export class AgentAttachmentActions {
  private readonly attachments: AgentAttachmentActionsOptions["attachments"];
  private readonly observations: AgentAttachmentActionsOptions["observations"];
  private readonly resolvePlanScope: AgentPlanScopeResolver;
  private readonly resolveStagedUpload: StagedAttachmentUploadResolver;
  private readonly consumeStagedUpload: StagedAttachmentUploadConsumer | undefined;
  private readonly inspectionAdapters: AttachmentInspectionAdapters | undefined;
  private readonly inspectionLimits: Partial<AttachmentInspectionLimits> | undefined;
  private readonly now: () => string;

  constructor(options: AgentAttachmentActionsOptions) {
    this.attachments = options.attachments;
    this.observations = options.observations;
    this.resolvePlanScope = options.resolvePlanScope;
    this.resolveStagedUpload = options.resolveStagedUpload;
    this.consumeStagedUpload = options.consumeStagedUpload;
    this.inspectionAdapters = options.inspectionAdapters;
    this.inspectionLimits = options.inspectionLimits;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async scope(context: AgentToolContext): Promise<ResolvedAgentPlanScope> {
    const scope = await this.resolvePlanScope(context);
    assertScope(scope);
    return scope;
  }

  private async inspectStored(attachmentId: string, scope: ResolvedAgentPlanScope, context: AgentToolContext, extractText = false) {
    assertSafeId(attachmentId, "attachmentId");
    let record: Awaited<ReturnType<AgentAttachmentActionsOptions["attachments"]["get"]>>;
    try { record = await this.attachments.get(attachmentId); }
    catch { throw new AgentAttachmentActionError("attachment_not_found", "attachment is unavailable"); }
    if (record.planId !== scope.planId) throw new AgentAttachmentActionError("cross_plan_attachment", "attachment belongs to a different plan");
    if (record.status !== "available") throw new AgentAttachmentActionError("attachment_not_found", "attachment body is unavailable");
    const bytes = await this.attachments.readBlob(attachmentId).catch(() => {
      throw new AgentAttachmentActionError("attachment_not_found", "attachment body is unavailable");
    });
    const inspected = await inspectAttachmentBytes({
      bytes,
      declaredMediaType: record.mediaType,
      extractText,
      signal: context.signal,
      ...(this.inspectionLimits ? { limits: this.inspectionLimits } : {}),
      ...(this.inspectionAdapters ? { adapters: this.inspectionAdapters } : {}),
    });
    if (inspected.originalContentHash !== record.contentHash) {
      throw new AgentAttachmentActionError("attachment_not_found", "attachment raw-byte authority does not match repository metadata");
    }
    return inspected;
  }

  async archiveUserAttachment(input: ArchiveUserAttachmentInput, context: AgentToolContext): Promise<ArchivedUserAttachmentResult> {
    const scope = await this.scope(context);
    const upload = await this.resolveStagedUpload(input.uploadId, context);
    if (!upload) throw new AgentAttachmentActionError("upload_not_found", "server-owned staged upload was not found");
    const inspection = await inspectAttachmentBytes({
      bytes: upload.bytes,
      declaredMediaType: upload.declaredMediaType,
      signal: context.signal,
      ...(this.inspectionLimits ? { limits: this.inspectionLimits } : {}),
      ...(this.inspectionAdapters ? { adapters: this.inspectionAdapters } : {}),
    });
    const attachmentId = deterministicId("attachment", context, input.uploadId);
    const saved = await this.attachments.put({
      attachmentId,
      planId: scope.planId,
      content: Buffer.isBuffer(upload.bytes)
        ? Buffer.from(upload.bytes)
        : upload.bytes instanceof ArrayBuffer
          ? Buffer.from(upload.bytes)
          : Buffer.from(upload.bytes.buffer, upload.bytes.byteOffset, upload.bytes.byteLength),
      mediaType: inspection.mediaType,
      deletionPolicy: input.deletionPolicy,
    });
    if (saved.contentHash !== inspection.originalContentHash) {
      throw new AgentAttachmentActionError("attachment_not_found", "repository changed the original attachment byte authority");
    }
    // The AttachmentRepository write is content-addressed and deterministic.
    // A crash before this commit is therefore safe: the same approved Tool
    // execution can claim the same staged bytes, replay the same attachment
    // write, and then finish this consumed transition.
    await this.consumeStagedUpload?.(input.uploadId, context, saved.attachmentId);
    return {
      schemaVersion: "agent-user-attachment-archive-v1",
      status: "archived_private_plan_attachment",
      attachmentId: saved.attachmentId,
      planId: scope.planId,
      originalContentHash: saved.contentHash,
      inspection: toPublicAttachmentInspection(inspection),
      contentTrust: "untrusted_user_attachment",
      scope: "plan_only",
      mayPromoteOfficialFact: false,
      observationActivationRequiresSeparateApproval: true,
    };
  }

  async inspectAttachment(input: InspectArchivedAttachmentInput, context: AgentToolContext): Promise<PublicAttachmentInspection & { attachmentId: string; planId: string }> {
    const scope = await this.scope(context);
    const inspection = await this.inspectStored(input.attachmentId, scope, context, input.extractText === true);
    return { attachmentId: input.attachmentId, planId: scope.planId, ...toPublicAttachmentInspection(inspection) };
  }

  async proposeUserObservation(input: ProposeUserObservationInput, context: AgentToolContext): Promise<UserObservationProposalResult> {
    const scope = await this.scope(context);
    const subjectErrors = validateObservationSubjectRef(input.subjectRef);
    if (subjectErrors.length) throw new AgentAttachmentActionError("observation_invalid", subjectErrors.join("; "));
    const subject = await scope.resolveSubjectRevision(structuredClone(input.subjectRef));
    if (!subject.exists) throw new AgentAttachmentActionError("subject_not_found", "observation subject does not exist in the active plan");
    if (!SHA256.test(subject.subjectRevisionHash)) throw new AgentAttachmentActionError("plan_authority_invalid", "server-resolved subject revision is invalid");
    const attachmentRefs = [...new Set(input.attachmentIds ?? [])];
    if (attachmentRefs.length !== (input.attachmentIds ?? []).length || attachmentRefs.length > 8) {
      throw new AgentAttachmentActionError("observation_invalid", "observation attachment references are duplicate or exceed the bounded limit");
    }
    for (const attachmentId of attachmentRefs) await this.inspectStored(attachmentId, scope, context);
    const withoutHash: Omit<UserObservation, "contentHash"> = {
      observationId: deterministicId("observation", context),
      planId: scope.planId,
      subjectRef: structuredClone(input.subjectRef),
      fieldId: input.fieldId,
      value: structuredClone(input.value),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.uncertainty !== undefined ? { uncertainty: structuredClone(input.uncertainty) } : {}),
      method: input.method,
      attachmentRefs,
      confirmedByUser: false,
      observedAgainstConfigHash: scope.configHash,
      subjectRevisionHash: subject.subjectRevisionHash,
      capturedAt: this.now(),
      status: "proposed",
    };
    const observation: UserObservation = { ...withoutHash, contentHash: observationHash(withoutHash) };
    const errors = validateUserObservation(observation);
    if (errors.length) throw new AgentAttachmentActionError("observation_invalid", errors.join("; "));
    const saved = await this.observations.put({ observation });
    return {
      schemaVersion: "agent-user-observation-proposal-v1",
      proposal: saved,
      status: "proposed",
      scope: "plan_only",
      evidenceTrust: "untrusted_user_attachment_or_user_assertion",
      mayPromoteOfficialFact: false,
      activation: { required: true, automatic: false, requiresCurrentPlanAndSubjectRevision: true },
    };
  }

  async bindObservationAttachment(input: BindObservationAttachmentInput, context: AgentToolContext): Promise<ObservationAttachmentBindingProposalResult> {
    const scope = await this.scope(context);
    assertSafeId(input.observationProposalId, "observationProposalId");
    await this.inspectStored(input.attachmentId, scope, context);
    let source: UserObservation;
    try { source = await this.observations.get(scope.planId, input.observationProposalId); }
    catch { throw new AgentAttachmentActionError("observation_not_found", "observation proposal was not found in the active plan"); }
    if (source.planId !== scope.planId) throw new AgentAttachmentActionError("observation_not_found", "observation proposal was not found in the active plan");
    if (source.status !== "proposed" || source.confirmedByUser) {
      throw new AgentAttachmentActionError("observation_not_proposed", "attachments can only be bound to an unconfirmed observation proposal");
    }
    const attachmentRefs = [...new Set([...source.attachmentRefs, input.attachmentId])];
    const { contentHash: _sourceHash, observationId: _sourceId, ...domain } = source;
    const withoutHash: Omit<UserObservation, "contentHash"> = {
      ...structuredClone(domain),
      observationId: deterministicId("observation", context, `bind:${source.observationId}:${input.attachmentId}`),
      attachmentRefs,
      confirmedByUser: false,
      status: "proposed",
    };
    const bound: UserObservation = { ...withoutHash, contentHash: observationHash(withoutHash) };
    const errors = validateUserObservation(bound);
    if (errors.length) throw new AgentAttachmentActionError("observation_invalid", errors.join("; "));
    const saved = await this.observations.put({ observation: bound });
    const proposalBase = {
      schemaVersion: "agent-observation-attachment-binding-proposal-v1" as const,
      proposalId: deterministicId("observation-binding", context, `${source.observationId}:${input.attachmentId}`),
      status: "proposed" as const,
      planId: scope.planId,
      sourceObservationProposalId: source.observationId,
      boundObservationProposalId: saved.observationId,
      attachmentId: input.attachmentId,
      scope: "plan_only" as const,
      mayPromoteOfficialFact: false as const,
      activation: { required: true as const, automatic: false as const },
    };
    return { ...proposalBase, contentHash: digest(canonicalJson(proposalBase)) };
  }
}

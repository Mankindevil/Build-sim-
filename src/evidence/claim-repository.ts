import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json, withDirectoryLock } from "../runtime/fs.mjs";
import { validateEvidenceClaim, type EvidenceCapture, type EvidenceClaim, type EvidenceDocument } from "./contracts";
import { verifyEvidenceClaim } from "./claims";
import { evidenceIdentityMatchesClaimSubjectRuntime } from "./claim-runtime.mjs";
import { validateOfficialClaimCandidateEnvelopeRuntime } from "./claim-candidate-runtime.mjs";
import {
  validateOfficialClaimPromotionRuntime,
  type OfficialClaimPromotionRecord,
} from "./official-promotion-runtime.mjs";
import { validateThirdPartyClaimCandidateEnvelopeRuntime } from "./third-party-claim-candidate-runtime.mjs";
import {
  validateThirdPartyClaimPromotionRuntime,
  type ThirdPartyClaimPromotionRecord,
} from "./third-party-promotion-runtime.mjs";
import {
  assertClaimPromotionApprovalAtRoot,
  type ClaimPromotionAuthorization,
} from "./claim-promotion-approval";

const CLAIM_ID = /^claim-sha256-([a-f0-9]{64})$/;

interface EvidenceAuthorityLookup {
  getDocument(id: string): Promise<EvidenceDocument | null>;
  getCapture(id: string): Promise<EvidenceCapture | null>;
  getDocumentAtRoot?(activeRoot: string, id: string): Promise<EvidenceDocument | null>;
  getCaptureAtRoot?(activeRoot: string, id: string): Promise<EvidenceCapture | null>;
}

interface ClaimEnvelope {
  schemaVersion: "evidence-claim-envelope-v1";
  kind: "evidence-claim";
  checksum: string;
  payload: EvidenceClaim;
  officialPromotion?: OfficialClaimPromotionRecord;
  thirdPartyPromotion?: ThirdPartyClaimPromotionRecord;
  authorityChecksum?: string;
}

/** Explicit maintenance-only bridge for pre-U4 fixtures/importers. */
export const LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY = "evidence-official-legacy-import-v1" as const;

export class EvidenceClaimRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input", message: string) {
    super(message);
    this.name = "EvidenceClaimRepositoryError";
  }
}

export interface EvidenceClaimRepositoryOptions {
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  evidence: EvidenceAuthorityLookup;
}

export class EvidenceClaimRepository {
  private readonly root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly evidence: EvidenceAuthorityLookup;

  constructor(options: EvidenceClaimRepositoryOptions) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? options.coordinator?.root ?? path.join(process.cwd(), "runtime"));
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, "evidence"));
    this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot });
    this.evidence = options.evidence;
  }

  private claimFile(evidenceRoot: string, claimId: string): string {
    const match = CLAIM_ID.exec(claimId);
    if (!match) throw new EvidenceClaimRepositoryError("invalid_input", "evidence claim ID invalid");
    return confined(evidenceRoot, "claims", match[1]!.slice(0, 2), `${claimId}.json`);
  }

  private async boundary<T>(
    write: boolean,
    operation: (evidenceRoot: string, activeRoot?: string) => Promise<T>,
    maintenanceLeaseToken?: string,
  ): Promise<T> {
    if (this.coordinator) {
      await this.coordinator.initialize();
      if (write) return (await this.coordinator.withWrite(
        ({ activeRoot }: { activeRoot: string }) => operation(confined(activeRoot, "evidence"), activeRoot),
        { maintenanceLeaseToken },
      )).result as T;
      return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => operation(confined(activeRoot, "evidence"), activeRoot))).result as T;
    }
    return withDirectoryLock(confined(this.root, ".locks", "claim-repository"), () => operation(this.root));
  }

  private async readAt(evidenceRoot: string, claimId: string, optional = false): Promise<EvidenceClaim | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.claimFile(evidenceRoot, claimId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (optional) return null;
        throw new EvidenceClaimRepositoryError("not_found", "evidence claim was not found");
      }
      throw new EvidenceClaimRepositoryError("corrupt_data", "evidence claim cannot be read");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new EvidenceClaimRepositoryError("corrupt_data", "evidence claim envelope invalid");
    const envelope = parsed as Partial<ClaimEnvelope>;
    if (envelope.schemaVersion !== "evidence-claim-envelope-v1" || envelope.kind !== "evidence-claim" || !("payload" in envelope)
      || envelope.checksum !== sha256Json(envelope.payload) || validateEvidenceClaim(envelope.payload).length
      || !await verifyEvidenceClaim(envelope.payload) || envelope.payload.claimId !== claimId) {
      throw new EvidenceClaimRepositoryError("corrupt_data", "evidence claim authority integrity invalid");
    }
    const keys = Object.keys(envelope).sort().join(",");
    if (envelope.payload.authority === "third_party") {
      if (keys !== "authorityChecksum,checksum,kind,payload,schemaVersion,thirdPartyPromotion"
        || !envelope.thirdPartyPromotion || validateThirdPartyClaimPromotionRuntime(envelope.thirdPartyPromotion).length
        || envelope.authorityChecksum !== sha256Json({ claim: envelope.payload, promotion: envelope.thirdPartyPromotion })) {
        throw new EvidenceClaimRepositoryError("corrupt_data", "third-party claim promotion authority integrity invalid");
      }
      await this.thirdPartyPromotionClosure(evidenceRoot, envelope.payload, envelope.thirdPartyPromotion);
    } else if (envelope.officialPromotion !== undefined) {
      if (keys !== "authorityChecksum,checksum,kind,officialPromotion,payload,schemaVersion"
        || validateOfficialClaimPromotionRuntime(envelope.officialPromotion).length
        || envelope.authorityChecksum !== sha256Json({ claim: envelope.payload, promotion: envelope.officialPromotion })) {
        throw new EvidenceClaimRepositoryError("corrupt_data", "official claim promotion authority integrity invalid");
      }
      await this.officialPromotionClosure(evidenceRoot, envelope.payload, envelope.officialPromotion);
    } else if (keys !== "checksum,kind,payload,schemaVersion") {
      throw new EvidenceClaimRepositoryError("corrupt_data", "evidence claim envelope contains unknown authority fields");
    }
    return structuredClone(envelope.payload);
  }

  private async officialPromotionClosure(
    evidenceRoot: string,
    claim: EvidenceClaim,
    promotion: OfficialClaimPromotionRecord,
  ): Promise<void> {
    if (claim.authority !== "official" || promotion.activeClaimId !== claim.claimId
      || promotion.activeClaimHash !== claim.contentHash || promotion.promotedCaptureId !== claim.source.captureId) {
      throw new EvidenceClaimRepositoryError("invalid_input", "official claim promotion does not own the active claim");
    }
    const candidateHash = promotion.candidateId.slice("claim-candidate-sha256-".length);
    const file = confined(evidenceRoot, "claim-candidates", candidateHash.slice(0, 2), `${promotion.candidateId}.json`);
    let envelope: unknown;
    try { envelope = JSON.parse(await readFile(file, "utf8")); }
    catch { throw new EvidenceClaimRepositoryError("invalid_input", "official claim promotion candidate authority is unavailable"); }
    const errors = validateOfficialClaimCandidateEnvelopeRuntime(envelope, promotion.candidateId);
    if (errors.length) throw new EvidenceClaimRepositoryError("invalid_input", "official claim promotion candidate authority is invalid");
    const candidate = (envelope as { payload: {
      contentHash: string; planId: string; originalCaptureId: string;
      claim: EvidenceClaim;
      promotionInput: { confirmation: { confirmationId: string; contentHash: string } };
      promotion: { confirmationId: string };
    } }).payload;
    const candidateMaterial = structuredClone(candidate.claim) as unknown as Record<string, unknown> & { source: Record<string, unknown> };
    candidateMaterial.source.captureId = claim.source.captureId;
    delete candidateMaterial.claimId;
    delete candidateMaterial.contentHash;
    const activeMaterial = structuredClone(claim) as unknown as Record<string, unknown>;
    delete activeMaterial.claimId;
    delete activeMaterial.contentHash;
    if (candidate.contentHash !== promotion.candidateHash || candidate.planId !== promotion.planId
      || candidate.originalCaptureId !== promotion.originalCaptureId
      || candidate.promotion.confirmationId !== promotion.confirmationId
      || candidate.promotionInput.confirmation.confirmationId !== promotion.confirmationId
      || candidate.promotionInput.confirmation.contentHash !== promotion.confirmationHash
      || sha256Json(candidateMaterial) !== sha256Json(activeMaterial)) {
      throw new EvidenceClaimRepositoryError("invalid_input", "official claim promotion candidate/confirmation/claim closure is invalid");
    }
  }

  private async thirdPartyPromotionClosure(
    evidenceRoot: string,
    claim: EvidenceClaim,
    promotion: ThirdPartyClaimPromotionRecord,
  ): Promise<void> {
    if (promotion.activeClaimId !== claim.claimId || promotion.activeClaimHash !== claim.contentHash
      || promotion.promotedCaptureId !== claim.source.captureId) {
      throw new EvidenceClaimRepositoryError("invalid_input", "third-party claim promotion does not own the active claim");
    }
    const candidateHash = promotion.candidateId.slice("third-party-claim-candidate-sha256-".length);
    const file = confined(evidenceRoot, "third-party-claim-candidates", candidateHash.slice(0, 2), `${promotion.candidateId}.json`);
    let envelope: unknown;
    try { envelope = JSON.parse(await readFile(file, "utf8")); }
    catch { throw new EvidenceClaimRepositoryError("invalid_input", "third-party claim promotion candidate authority is unavailable"); }
    const errors = validateThirdPartyClaimCandidateEnvelopeRuntime(envelope, promotion.candidateId);
    if (errors.length) throw new EvidenceClaimRepositoryError("invalid_input", "third-party claim promotion candidate authority is invalid");
    const candidate = (envelope as { payload: {
      contentHash: string; planId: string; originalCaptureId: string;
      assessment: { assessmentId: string; contentHash: string };
      claim: EvidenceClaim;
    } }).payload;
    const candidateMaterial = structuredClone(candidate.claim) as unknown as Record<string, unknown> & { source: Record<string, unknown> };
    candidateMaterial.source.captureId = claim.source.captureId;
    delete candidateMaterial.claimId;
    delete candidateMaterial.contentHash;
    const activeMaterial = structuredClone(claim) as unknown as Record<string, unknown>;
    delete activeMaterial.claimId;
    delete activeMaterial.contentHash;
    if (candidate.contentHash !== promotion.candidateHash || candidate.planId !== promotion.planId
      || candidate.originalCaptureId !== promotion.originalCaptureId
      || candidate.assessment.assessmentId !== promotion.assessmentId
      || candidate.assessment.contentHash !== promotion.assessmentHash
      || sha256Json(candidateMaterial) !== sha256Json(activeMaterial)) {
      throw new EvidenceClaimRepositoryError("invalid_input", "third-party claim promotion candidate/assessment/claim closure is invalid");
    }
  }

  private async evidenceClosure(activeRoot: string | undefined, claim: EvidenceClaim): Promise<void> {
    if (activeRoot && (!this.evidence.getDocumentAtRoot || !this.evidence.getCaptureAtRoot)) {
      throw new EvidenceClaimRepositoryError("invalid_input", "coordinated evidence authority lookup is unavailable");
    }
    const document = activeRoot
      ? await this.evidence.getDocumentAtRoot!(activeRoot, claim.source.documentId)
      : await this.evidence.getDocument(claim.source.documentId);
    const capture = activeRoot
      ? await this.evidence.getCaptureAtRoot!(activeRoot, claim.source.captureId)
      : await this.evidence.getCapture(claim.source.captureId);
    if (!document || !capture || document.id !== claim.source.documentId || document.sha256 !== claim.source.documentSha256
      || capture.id !== claim.source.captureId || capture.documentId !== document.id) {
      throw new EvidenceClaimRepositoryError("invalid_input", "evidence claim document/capture closure invalid");
    }
    const identity = capture.productIdentities.find((item) => evidenceIdentityMatchesClaimSubjectRuntime(item, claim.subject, claim.scope));
    if (!identity) throw new EvidenceClaimRepositoryError("invalid_input", "evidence claim scoped product identity is not asserted by its capture");
    if (claim.authority === "official" && identity.basis !== "official-document-explicit") {
      throw new EvidenceClaimRepositoryError("invalid_input", "official evidence claim requires an explicit official product identity");
    }
    if (claim.authority === "third_party" && identity.basis !== "third-party-document-explicit") {
      throw new EvidenceClaimRepositoryError("invalid_input", "third-party evidence claim requires an approved explicit third-party product identity");
    }
  }

  private async putValidatedClaim(
    value: EvidenceClaim,
    promotion?: { readonly kind: "official"; readonly value: OfficialClaimPromotionRecord }
      | { readonly kind: "third_party"; readonly value: ThirdPartyClaimPromotionRecord },
    legacyOfficial = false,
    maintenanceLeaseToken?: string,
  ): Promise<EvidenceClaim> {
    const claim = structuredClone(value);
    const errors = validateEvidenceClaim(claim);
    if (errors.length || !await verifyEvidenceClaim(claim)) throw new EvidenceClaimRepositoryError("invalid_input", errors.length ? errors.join("; ") : "evidence claim content hash mismatch");
    if (claim.authority === "third_party" && promotion?.kind !== "third_party") {
      throw new EvidenceClaimRepositoryError("invalid_input", "third-party claims require an atomic reviewed promotion authority");
    }
    if (claim.authority === "official" && promotion?.kind !== "official" && !legacyOfficial) {
      throw new EvidenceClaimRepositoryError("invalid_input", "official claims require an atomic reviewed promotion authority");
    }
    if (promotion && promotion.kind !== claim.authority) throw new EvidenceClaimRepositoryError("invalid_input", "claim promotion authority kind is invalid");
    return this.boundary(true, async (evidenceRoot, activeRoot) => {
      await this.evidenceClosure(activeRoot, claim);
      if (promotion?.kind === "third_party") await this.thirdPartyPromotionClosure(evidenceRoot, claim, promotion.value);
      if (promotion?.kind === "official") await this.officialPromotionClosure(evidenceRoot, claim, promotion.value);
      if (claim.supersedesClaimId) {
        const old = await this.readAt(evidenceRoot, claim.supersedesClaimId);
        if (!old || old.contentHash !== claim.supersededClaimHash || old.status !== "active"
          || old.fieldId !== claim.fieldId || old.scope !== claim.scope || sha256Json(old.subject) !== sha256Json(claim.subject)) {
          throw new EvidenceClaimRepositoryError("conflict", "evidence claim replacement closure invalid");
        }
        const claims = await this.listAt(evidenceRoot);
        if (claims.some((item) => item.supersedesClaimId === old.claimId)) throw new EvidenceClaimRepositoryError("conflict", "evidence claim already has a replacement");
      }
      const existing = await this.readAt(evidenceRoot, claim.claimId, true);
      if (existing) {
        if (existing.contentHash !== claim.contentHash || sha256Json(existing) !== sha256Json(claim)) throw new EvidenceClaimRepositoryError("conflict", "immutable evidence claim ID collision");
        const existingEnvelope = JSON.parse(await readFile(this.claimFile(evidenceRoot, claim.claimId), "utf8")) as ClaimEnvelope;
        if (promotion?.kind === "official") {
          if (!existingEnvelope.officialPromotion
            || sha256Json(existingEnvelope.officialPromotion) !== sha256Json(promotion.value)
            || existingEnvelope.authorityChecksum !== sha256Json({ claim, promotion: promotion.value })) {
            throw new EvidenceClaimRepositoryError("conflict", "official claim already belongs to a different reviewed approval");
          }
        } else if (promotion?.kind === "third_party") {
          if (!existingEnvelope.thirdPartyPromotion
            || sha256Json(existingEnvelope.thirdPartyPromotion) !== sha256Json(promotion.value)
            || existingEnvelope.authorityChecksum !== sha256Json({ claim, promotion: promotion.value })) {
            throw new EvidenceClaimRepositoryError("conflict", "third-party claim already belongs to a different reviewed approval");
          }
        }
        return existing;
      }
      const envelope: ClaimEnvelope = {
        schemaVersion: "evidence-claim-envelope-v1",
        kind: "evidence-claim",
        checksum: sha256Json(claim),
        payload: claim,
        ...(promotion === undefined ? {} : {
          ...(promotion.kind === "official"
            ? { officialPromotion: structuredClone(promotion.value) }
            : { thirdPartyPromotion: structuredClone(promotion.value) }),
          authorityChecksum: sha256Json({ claim, promotion: promotion.value }),
        }),
      };
      await atomicWriteJson(this.claimFile(evidenceRoot, claim.claimId), envelope);
      return structuredClone(claim);
    }, maintenanceLeaseToken);
  }

  async putClaim(value: EvidenceClaim): Promise<EvidenceClaim> {
    return this.putValidatedClaim(value);
  }

  async putLegacyOfficialClaim(input: {
    readonly claim: EvidenceClaim;
    readonly legacyImportCapability: typeof LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY;
    readonly maintenanceLeaseToken: string;
  }): Promise<EvidenceClaim> {
    if (input.legacyImportCapability !== LEGACY_OFFICIAL_CLAIM_IMPORT_CAPABILITY || input.claim.authority !== "official"
      || !this.coordinator || !input.maintenanceLeaseToken) {
      throw new EvidenceClaimRepositoryError("invalid_input", "legacy official claim import capability is invalid");
    }
    await this.coordinator.assertMaintenanceLease(input.maintenanceLeaseToken)
      .catch(() => { throw new EvidenceClaimRepositoryError("invalid_input", "legacy official claim import maintenance lease is invalid"); });
    return this.putValidatedClaim(input.claim, undefined, true, input.maintenanceLeaseToken);
  }

  async putOfficialPromotedClaimAtRoot(
    activeRoot: string,
    value: EvidenceClaim,
    promotion: OfficialClaimPromotionRecord,
    authorization: ClaimPromotionAuthorization,
  ): Promise<EvidenceClaim> {
    if (this.coordinator || this.root !== path.resolve(confined(activeRoot, "evidence"))) {
      throw new EvidenceClaimRepositoryError("invalid_input", "official promotion writer is not bound to the supplied active root");
    }
    const candidateHash = promotion.candidateId.slice("claim-candidate-sha256-".length);
    const candidateFile = confined(activeRoot, "evidence", "claim-candidates", candidateHash.slice(0, 2), `${promotion.candidateId}.json`);
    const candidateEnvelope = JSON.parse(await readFile(candidateFile, "utf8")) as { payload?: {
      planId?: string; planConfigHash?: string; planDraftRevision?: number;
    } };
    const candidate = candidateEnvelope.payload;
    if (candidate?.planId !== promotion.planId || typeof candidate.planConfigHash !== "string"
      || !Number.isSafeInteger(candidate.planDraftRevision)) {
      throw new EvidenceClaimRepositoryError("invalid_input", "official promotion candidate plan authority is invalid");
    }
    const approval = await assertClaimPromotionApprovalAtRoot({
      activeRoot,
      authorization,
      kind: "official",
      candidateId: promotion.candidateId,
      planId: promotion.planId,
      planConfigHash: candidate.planConfigHash,
      planDraftRevision: candidate.planDraftRevision!,
    }).catch((error: unknown) => {
      throw new EvidenceClaimRepositoryError("invalid_input", error instanceof Error ? error.message : "official claim promotion approval is invalid");
    });
    if (sha256Json(approval) !== sha256Json(promotion.approval)) {
      throw new EvidenceClaimRepositoryError("invalid_input", "official claim promotion durable approval binding changed before commit");
    }
    return this.putValidatedClaim(value, { kind: "official", value: structuredClone(promotion) });
  }

  async putThirdPartyPromotedClaimAtRoot(
    activeRoot: string,
    value: EvidenceClaim,
    promotion: ThirdPartyClaimPromotionRecord,
    authorization: ClaimPromotionAuthorization,
  ): Promise<EvidenceClaim> {
    if (this.coordinator || this.root !== path.resolve(confined(activeRoot, "evidence"))) {
      throw new EvidenceClaimRepositoryError("invalid_input", "third-party promotion writer is not bound to the supplied active root");
    }
    const candidateHash = promotion.candidateId.slice("third-party-claim-candidate-sha256-".length);
    const candidateFile = confined(activeRoot, "evidence", "third-party-claim-candidates", candidateHash.slice(0, 2), `${promotion.candidateId}.json`);
    const candidateEnvelope = JSON.parse(await readFile(candidateFile, "utf8")) as { payload?: {
      planId?: string; planConfigHash?: string; planDraftRevision?: number;
    } };
    const candidate = candidateEnvelope.payload;
    if (candidate?.planId !== promotion.planId || typeof candidate.planConfigHash !== "string"
      || !Number.isSafeInteger(candidate.planDraftRevision)) {
      throw new EvidenceClaimRepositoryError("invalid_input", "third-party promotion candidate plan authority is invalid");
    }
    const approval = await assertClaimPromotionApprovalAtRoot({
      activeRoot,
      authorization,
      kind: "third_party",
      candidateId: promotion.candidateId,
      planId: promotion.planId,
      planConfigHash: candidate.planConfigHash,
      planDraftRevision: candidate.planDraftRevision!,
    }).catch((error: unknown) => {
      throw new EvidenceClaimRepositoryError("invalid_input", error instanceof Error ? error.message : "third-party claim promotion approval is invalid");
    });
    if (sha256Json(approval) !== sha256Json(promotion.approval)) {
      throw new EvidenceClaimRepositoryError("invalid_input", "third-party claim promotion durable approval binding changed before commit");
    }
    return this.putValidatedClaim(value, { kind: "third_party", value: structuredClone(promotion) });
  }

  async getClaim(claimId: string): Promise<EvidenceClaim | null> {
    return this.boundary(false, (evidenceRoot) => this.readAt(evidenceRoot, claimId, true));
  }

  async getClaimAtRoot(activeRoot: string, claimId: string): Promise<EvidenceClaim | null> {
    return this.readAt(confined(activeRoot, "evidence"), claimId, true);
  }

  private async listAt(evidenceRoot: string): Promise<EvidenceClaim[]> {
    const directory = confined(evidenceRoot, "claims");
    let buckets: import("node:fs").Dirent[];
    try { buckets = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (buckets.some((entry) => entry.isSymbolicLink() || !entry.isDirectory() || !/^[a-f0-9]{2}$/.test(entry.name))) throw new EvidenceClaimRepositoryError("corrupt_data", "evidence claims contain an unknown authority path");
    const claims: EvidenceClaim[] = [];
    for (const bucket of buckets.sort((left, right) => left.name.localeCompare(right.name))) {
      const files = await readdir(confined(directory, bucket.name), { withFileTypes: true });
      if (files.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !/^claim-sha256-[a-f0-9]{64}\.json$/.test(entry.name))) throw new EvidenceClaimRepositoryError("corrupt_data", "evidence claim bucket contains an unknown authority path");
      for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) claims.push((await this.readAt(evidenceRoot, file.name.slice(0, -5)))!);
    }
    return claims;
  }

  async listClaims(): Promise<EvidenceClaim[]> {
    return this.boundary(false, (evidenceRoot) => this.listAt(evidenceRoot));
  }

  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "evidence-claims";
    revision: number;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const claims = await this.listAt(confined(activeRoot, "evidence"));
    return {
      providerId: "evidence-claims",
      revision: claims.length,
      manifestHash: sha256Json(claims.map((claim) => ({ claimId: claim.claimId, contentHash: claim.contentHash }))),
      snapshotPointers: [],
      nodes: claims.map((claim) => `evidence-claim:${claim.claimId}`).sort(),
      edges: claims.flatMap((claim) => [
        { fromRef: `evidence-claim:${claim.claimId}`, toRef: `evidence-document:${claim.source.documentId}`, necessity: "required_for_replay" as const },
        { fromRef: `evidence-claim:${claim.claimId}`, toRef: `evidence-capture:${claim.source.captureId}`, necessity: "required_for_replay" as const },
      ]).sort((left, right) => sha256Json(left).localeCompare(sha256Json(right))),
    };
  }
}

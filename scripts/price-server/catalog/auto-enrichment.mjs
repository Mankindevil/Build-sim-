import { OFFICIAL_REGISTRY_VERSION } from "./registry.mjs";
import { catalogCandidateInputHash } from "./contracts.mjs";
import { findCandidate } from "./service.mjs";
import { acceptOfficial, createDraft } from "./write.mjs";

export async function runAutoEnrichment(candidateId, options = {}) {
  const candidate = options.candidate ?? findCandidate(candidateId);
  if (!candidate) return { status: "blocked", candidateId, reasons: ["candidate not found"] };
  const inputHash = catalogCandidateInputHash(candidate);
  if (options.expectedHash && options.expectedHash !== inputHash) return { status: "blocked", candidateId, inputHash, reasons: ["candidate expected hash mismatch"] };
  const evidence = { inputHash, registryVersion: OFFICIAL_REGISTRY_VERSION, extractorVersion: candidate.extraction?.adapter, contentHash: candidate.extraction?.contentHash };
  if (!options.autoEnrichTrustedOfficial) return { status: "candidate", candidateId, ...evidence, changedFields: [], conflicts: candidate.conflicts ?? [] };
  if (candidate.identity?.verdict === "conflict") {
    return { status: "blocked", candidateId, ...evidence, changedFields: [], conflicts: candidate.identity.criticalConflicts ?? [], reasons: candidate.identity.reasons ?? ["critical product identity conflict"] };
  }
  if (candidate.identity && candidate.identity.verdict !== "exact") {
    return { status: "candidate", candidateId, ...evidence, changedFields: [], conflicts: candidate.conflicts ?? [], reasons: [...(candidate.identity.reasons ?? []), "exact product identity is required before creating a catalog draft"] };
  }
  if (candidate.official && !["product", "spec", "datasheet", "support"].includes(candidate.official.pageKind)) {
    return { status: "candidate", candidateId, ...evidence, changedFields: [], conflicts: candidate.conflicts ?? [], reasons: [`official page kind is ${candidate.official.pageKind}; a product/specification artifact is required before creating a catalog draft`] };
  }
  const exactMpn = candidate.match?.kind === "exact-mpn";
  if (options.autoAcceptExactMpn && exactMpn && options.catalogWriteEnabled) {
    const accepted = await acceptOfficial(candidateId, { ...options, candidate });
    if (accepted.status === "accepted") return { ...accepted, ...evidence, conflicts: [] };
  }
  const draft = await createDraft(candidateId, {}, { ...options, candidate });
  return { status: draft.status, candidateId, draftId: draft.draftId, ...evidence, changedFields: [], conflicts: draft.conflicts ?? [], reasons: candidate.extraction?.status === "ok" ? [options.autoAcceptExactMpn ? "acceptance gate blocked" : "automatic exact-MPN acceptance disabled"] : [`extraction status is ${candidate.extraction?.status ?? "unknown"}`] };
}

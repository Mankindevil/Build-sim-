import { OFFICIAL_REGISTRY_VERSION } from "./registry.mjs";
import { catalogCandidateInputHash } from "./contracts.mjs";
import { findCandidate } from "./service.mjs";
import { createDraft, validateGovernedCandidate } from "./write.mjs";

export async function runAutoEnrichment(candidateId, options = {}) {
  const candidate = options.candidate ?? findCandidate(candidateId);
  if (!candidate) return { status: "blocked", candidateId, reasons: ["candidate not found"] };
  const inputHash = catalogCandidateInputHash(candidate);
  const writeEnabled = Boolean(options.catalogWriteEnabled);
  const evidence = { candidateInputHash: inputHash, registryVersion: OFFICIAL_REGISTRY_VERSION, extractorVersion: candidate.extraction?.adapter, contentHash: candidate.extraction?.contentHash, writeEnabled };
  if (!options.expectedHash) return { status: "blocked", candidateId, ...evidence, reasons: ["candidate expected hash is required"] };
  if (options.expectedHash !== inputHash) return { status: "blocked", candidateId, ...evidence, reasons: ["candidate expected hash mismatch"] };
  if (!options.autoEnrichTrustedOfficial) return { status: "candidate", candidateId, ...evidence, expectedHash: inputHash, changedFields: [], conflicts: candidate.conflicts ?? [], reasons: ["trusted official auto enrichment is disabled"] };
  const governed = validateGovernedCandidate(candidate, options.expectedHash, { requireExpectedHash: true });
  if (!governed.ok) return { status: "blocked", candidateId, ...evidence, expectedHash: inputHash, changedFields: [], conflicts: candidate.conflicts ?? [], missing: governed.missing, reasons: governed.errors };
  const draft = await createDraft(candidateId, {}, { ...options, candidate, expectedHash: inputHash, registryVersion: OFFICIAL_REGISTRY_VERSION });
  if (draft.status !== "draft") return { ...draft, candidateId, ...evidence };
  return {
    ...draft,
    candidateId,
    ...evidence,
    expectedHash: draft.inputHash,
    changedFields: draft.changedFields ?? [],
    reasons: writeEnabled ? ["governed draft is ready for review"] : ["governed draft is ready for review; catalog write is disabled"],
  };
}

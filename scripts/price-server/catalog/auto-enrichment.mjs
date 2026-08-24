import crypto from "node:crypto";
import { OFFICIAL_REGISTRY_VERSION } from "./registry.mjs";
import { findCandidate } from "./service.mjs";
import { acceptOfficial, createDraft } from "./write.mjs";

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
export async function runAutoEnrichment(candidateId, options = {}) {
  const candidate = options.candidate ?? findCandidate(candidateId);
  if (!candidate) return { status: "blocked", candidateId, reasons: ["candidate not found"] };
  const inputHash = sha256(JSON.stringify({ candidateId, canonicalUrl: candidate.canonicalUrl, source: candidate.source, extraction: candidate.extraction, fields: candidate.fields, conflicts: candidate.conflicts ?? [] }));
  const evidence = { inputHash, registryVersion: OFFICIAL_REGISTRY_VERSION, extractorVersion: candidate.extraction?.adapter, contentHash: candidate.extraction?.contentHash };
  if (!options.autoEnrichTrustedOfficial) return { status: "candidate", candidateId, ...evidence, changedFields: [], conflicts: candidate.conflicts ?? [] };
  const exactMpn = candidate.match?.kind === "exact-mpn";
  if (options.autoAcceptExactMpn && exactMpn && options.catalogWriteEnabled) {
    const accepted = await acceptOfficial(candidateId, { ...options, candidate });
    if (accepted.status === "accepted") return { ...accepted, ...evidence, conflicts: [] };
  }
  const draft = await createDraft(candidateId, {}, { ...options, candidate });
  return { status: draft.status, candidateId, draftId: draft.draftId, ...evidence, changedFields: [], conflicts: draft.conflicts ?? [], reasons: candidate.extraction?.status === "ok" ? [options.autoAcceptExactMpn ? "acceptance gate blocked" : "automatic exact-MPN acceptance disabled"] : [`extraction status is ${candidate.extraction?.status ?? "unknown"}`] };
}

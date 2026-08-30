import { hashContent } from "../hash";
import {
  validateEvidenceClaim,
  type EvidenceClaim,
  type EvidenceClaimId,
} from "./contracts";

export type EvidenceClaimInput = Omit<EvidenceClaim, "claimId" | "contentHash">;

const HASH_CONTRACT = Object.freeze({
  domain: "evidence-claim",
  schemaVersion: "evidence-claim-v1",
  canonicalizationPolicyId: "evidence-claim-content-v1",
} as const);

export async function evidenceClaimContentHash(value: EvidenceClaimInput | EvidenceClaim): Promise<string> {
  return hashContent(value, HASH_CONTRACT);
}

export async function createEvidenceClaim(input: EvidenceClaimInput): Promise<EvidenceClaim> {
  const material = structuredClone(input);
  const contentHash = await evidenceClaimContentHash(material);
  const claim: EvidenceClaim = Object.freeze({
    ...material,
    claimId: `claim-sha256-${contentHash}` as EvidenceClaimId,
    contentHash,
  });
  const errors = validateEvidenceClaim(claim);
  if (errors.length) throw new TypeError(`Invalid EvidenceClaim: ${errors.join("; ")}`);
  return claim;
}

export async function verifyEvidenceClaim(value: unknown): Promise<boolean> {
  if (validateEvidenceClaim(value).length) return false;
  const claim = value as EvidenceClaim;
  return claim.contentHash === await evidenceClaimContentHash(claim)
    && claim.claimId === `claim-sha256-${claim.contentHash}`;
}

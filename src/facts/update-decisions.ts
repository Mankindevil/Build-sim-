import { hashContent } from "../hash";
import { validateUpdateDecision, type UpdateDecision } from "./contracts";

export type UpdateDecisionInput = Omit<UpdateDecision, "updateDecisionId" | "contentHash">;

const CONTRACT = Object.freeze({
  domain: "fact-update-decision",
  schemaVersion: "fact-update-decision-v1",
  canonicalizationPolicyId: "fact-update-decision-content-v1",
} as const);

export async function updateDecisionContentHash(value: UpdateDecisionInput | UpdateDecision): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createUpdateDecision(input: UpdateDecisionInput): Promise<UpdateDecision> {
  const material = structuredClone(input);
  const contentHash = await updateDecisionContentHash(material);
  const decision: UpdateDecision = Object.freeze({ ...material, updateDecisionId: `update-decision-sha256-${contentHash}`, contentHash });
  const errors = validateUpdateDecision(decision);
  if (errors.length) throw new TypeError(`Invalid UpdateDecision: ${errors.join("; ")}`);
  return decision;
}

export async function verifyUpdateDecision(value: unknown): Promise<boolean> {
  if (validateUpdateDecision(value).length) return false;
  const decision = value as UpdateDecision;
  const hash = await updateDecisionContentHash(decision);
  return decision.contentHash === hash && decision.updateDecisionId === `update-decision-sha256-${hash}`;
}

export function selectedFactSnapshotRef(decision: UpdateDecision): UpdateDecision["oldSnapshotRef"] {
  return structuredClone(decision.decision === "accept" ? decision.newSnapshotRef : decision.oldSnapshotRef);
}

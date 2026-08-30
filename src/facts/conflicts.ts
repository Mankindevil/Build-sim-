import { hashContent } from "../hash";
import { validateConflictSet, type ConflictSet } from "./contracts";

export type ConflictSetInput = Omit<ConflictSet, "contentHash">;

const CONTRACT = Object.freeze({
  domain: "fact-conflict",
  schemaVersion: "fact-conflict-v1",
  canonicalizationPolicyId: "fact-conflict-content-v1",
} as const);

export async function conflictSetContentHash(value: ConflictSetInput | ConflictSet): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createConflictSet(input: ConflictSetInput): Promise<ConflictSet> {
  const material = structuredClone(input);
  const conflict: ConflictSet = Object.freeze({ ...material, contentHash: await conflictSetContentHash(material) });
  const errors = validateConflictSet(conflict);
  if (errors.length) throw new TypeError(`Invalid ConflictSet: ${errors.join("; ")}`);
  return conflict;
}

export async function verifyConflictSet(value: unknown): Promise<boolean> {
  if (validateConflictSet(value).length) return false;
  const conflict = value as ConflictSet;
  return conflict.contentHash === await conflictSetContentHash(conflict);
}

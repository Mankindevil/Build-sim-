import { hashContent } from "../hash";
import { validateFactSnapshot, type FactConflictRef, type FactSnapshot, type FactSnapshotRef } from "./contracts";

export type FactSnapshotInput = Omit<FactSnapshot, "snapshotId" | "contentHash">;

const CONTRACT = Object.freeze({
  domain: "fact-snapshot",
  schemaVersion: "fact-snapshot-v2",
  canonicalizationPolicyId: "fact-snapshot-content-v2",
} as const);

function sortedFactRefs(refs: readonly FactSnapshotRef[]): FactSnapshotRef[] {
  return [...refs].map((ref) => structuredClone(ref)).sort((left, right) => left.factId.localeCompare(right.factId));
}

function sortedConflictRefs(refs: readonly FactConflictRef[]): FactConflictRef[] {
  return [...refs].map((ref) => structuredClone(ref)).sort((left, right) => left.conflictSetId.localeCompare(right.conflictSetId));
}

export async function factSnapshotContentHash(value: FactSnapshotInput | FactSnapshot): Promise<string> {
  return hashContent(value, CONTRACT);
}

export async function createFactSnapshot(input: FactSnapshotInput): Promise<FactSnapshot> {
  const material: FactSnapshotInput = {
    schemaVersion: "fact-snapshot-v2",
    factRefs: sortedFactRefs(input.factRefs),
    conflictRefs: sortedConflictRefs(input.conflictRefs),
    createdAt: input.createdAt,
  };
  const contentHash = await factSnapshotContentHash(material);
  const snapshot: FactSnapshot = Object.freeze({
    ...material,
    snapshotId: `fact-snapshot-sha256-${contentHash}`,
    contentHash,
  });
  const errors = validateFactSnapshot(snapshot);
  if (errors.length) throw new TypeError(`Invalid FactSnapshot: ${errors.join("; ")}`);
  return snapshot;
}

export async function verifyFactSnapshot(value: unknown): Promise<boolean> {
  if (validateFactSnapshot(value).length) return false;
  const snapshot = value as FactSnapshot;
  const hash = await factSnapshotContentHash(snapshot);
  return hash === snapshot.contentHash && snapshot.snapshotId === `fact-snapshot-sha256-${hash}`;
}

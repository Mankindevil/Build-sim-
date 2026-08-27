import { reachableReferenceSet, verifyReferenceGraph } from "./reference-graph.mjs";

const ALWAYS_PROTECTED_KINDS = new Set(["active_snapshot", "audit", "backup", "export"]);

export async function planArtifactGc(options) {
  const { repository, referenceGraph } = options ?? {};
  if (!repository) throw new TypeError("artifact GC requires a repository");
  const graphErrors = verifyReferenceGraph(referenceGraph);
  if (graphErrors.length) throw new Error(`artifact GC refuses an invalid reference graph: ${graphErrors.join("; ")}`);
  const { manifest, records } = await repository.list();
  const nowMs = Date.parse((options.now ?? (() => new Date().toISOString()))());
  const retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  const quotaBytes = options.quotaBytes ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0 || quotaBytes < 0) throw new TypeError("artifact GC time/quota policy is invalid");
  const roots = new Set([...(referenceGraph.requiredRoots ?? []), ...(referenceGraph.snapshotPointers ?? []), ...(options.protectedRefs ?? [])]);
  for (const record of records) if (ALWAYS_PROTECTED_KINDS.has(record.kind)) roots.add(record.ref);
  const marked = reachableReferenceSet(referenceGraph, roots);
  const eligible = records.filter((record) => !marked.has(record.ref) && nowMs - Date.parse(record.createdAt) >= retentionMs)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.ref.localeCompare(right.ref));
  let projectedBytes = records.reduce((total, record) => total + record.byteLength, 0);
  const candidates = [];
  for (const record of eligible) {
    if (options.enforceRetention !== false || projectedBytes > quotaBytes) {
      candidates.push({ ref: record.ref, byteLength: record.byteLength, createdAt: record.createdAt, reason: projectedBytes > quotaBytes ? "quota-and-retention" : "retention" });
      projectedBytes -= record.byteLength;
    }
  }
  return {
    schemaVersion: "artifact-gc-plan-v1", manifestHash: manifest.contentHash, graphHash: referenceGraph.graphHash,
    dryRunDefault: true, totalBytes: records.reduce((total, record) => total + record.byteLength, 0), projectedBytes,
    quotaBytes: Number.isFinite(quotaBytes) ? quotaBytes : null, retentionMs, markedRefs: [...marked].sort(), candidates,
    quotaSatisfied: projectedBytes <= quotaBytes,
  };
}

export async function runArtifactGc(options) {
  const plan = options.plan ?? await planArtifactGc(options);
  const dryRun = options.dryRun !== false;
  if (dryRun) return { dryRun: true, plan, quarantined: [] };
  if (!options.referenceGraph || verifyReferenceGraph(options.referenceGraph).length || plan.graphHash !== options.referenceGraph.graphHash) {
    throw new Error("artifact GC apply requires the exact verified reference graph used by its plan");
  }
  const coordinator = options.repository.coordinator;
  let lease;
  if (coordinator) {
    lease = await coordinator.acquireMaintenanceLease("artifact-gc", { ttlMs: options.leaseTtlMs ?? 300_000 });
    const state = await coordinator.readState();
    if (options.referenceGraph && (state.runtimeGeneration !== options.referenceGraph.runtimeGeneration || state.revision !== options.referenceGraph.runtimeRevision)) {
      await coordinator.releaseMaintenanceLease(lease.token);
      throw new Error("artifact GC reference graph is stale");
    }
  }
  const quarantined = [];
  try {
    for (const candidate of plan.candidates) {
      const result = await options.repository.quarantine(candidate.ref, { reason: candidate.reason, maintenanceLeaseToken: lease?.token });
      quarantined.push({ ref: candidate.ref, ...result });
    }
    return { dryRun: false, plan, quarantined };
  } finally {
    if (lease) await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined);
  }
}

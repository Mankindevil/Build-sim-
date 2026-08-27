import { createHash } from "node:crypto";
import { canonicalJson } from "./fs.mjs";

const HASH_PREFIX = "buildsim\0hash-spec-v1\0portable-reference-graph\0portable-reference-graph-v1\0";
const NECESSITY = new Set(["required_for_replay", "optional_for_audit"]);

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function edgeKey(edge) { return canonicalJson(edge); }
function uniqueSorted(values) { return [...new Set(values)].sort(compare); }

export function portableReferenceGraphHash(graph) {
  const payload = {
    ...graph,
    graphHash: undefined,
    nodes: uniqueSorted(graph.nodes ?? []),
    edges: [...(graph.edges ?? [])].sort((left, right) => compare(edgeKey(left), edgeKey(right))),
  };
  return createHash("sha256").update(`${HASH_PREFIX}${canonicalJson(payload).normalize("NFC")}`, "utf8").digest("hex");
}

export function verifyReferenceGraph(graph) {
  const errors = [];
  if (!graph || graph.graphVersion !== "portable-reference-graph-v1" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return ["reference graph structure invalid"];
  }
  const nodes = new Set(graph.nodes);
  if (nodes.size !== graph.nodes.length || [...nodes].some((node) => typeof node !== "string" || !node)) errors.push("reference graph nodes invalid");
  if (!Number.isInteger(graph.runtimeGeneration) || graph.runtimeGeneration < 1 || !Number.isInteger(graph.runtimeRevision) || graph.runtimeRevision < 0) errors.push("reference graph runtime binding invalid");
  if (!Array.isArray(graph.requiredRoots) || new Set(graph.requiredRoots).size !== graph.requiredRoots.length || graph.requiredRoots.some((root) => !nodes.has(root))) errors.push("reference graph required roots invalid");
  if (!Array.isArray(graph.snapshotPointers) || new Set(graph.snapshotPointers).size !== graph.snapshotPointers.length || graph.snapshotPointers.some((ref) => typeof ref !== "string" || !ref)) errors.push("reference graph snapshot pointers invalid");
  if (!Array.isArray(graph.providerSnapshots) || new Set(graph.providerSnapshots.map((snapshot) => snapshot?.providerId)).size !== graph.providerSnapshots.length
    || graph.providerSnapshots.some((snapshot) => typeof snapshot?.providerId !== "string" || !snapshot.providerId || !Number.isInteger(snapshot.revision) || snapshot.revision < 0 || !/^[a-f0-9]{64}$/.test(String(snapshot.manifestHash ?? "")))) errors.push("reference graph provider snapshots invalid");
  const edges = new Set();
  for (const [index, edge] of graph.edges.entries()) {
    if (!edge || typeof edge.fromRef !== "string" || typeof edge.toRef !== "string" || edge.fromRef === edge.toRef
      || !NECESSITY.has(edge.necessity) || !nodes.has(edge.fromRef) || !nodes.has(edge.toRef)) {
      errors.push(`reference graph edge ${index} invalid or dangling`);
      continue;
    }
    const key = `${edge.fromRef}\0${edge.toRef}\0${edge.necessity}`;
    if (edges.has(key)) errors.push("reference graph edges must be unique");
    edges.add(key);
  }
  if (typeof graph.graphHash !== "string" || graph.graphHash !== portableReferenceGraphHash(graph)) errors.push("reference graph hash invalid");
  return errors;
}

function graphFromSnapshots({ state, snapshots, requiredRoots = [], now }) {
  if (!state || !Number.isInteger(state.runtimeGeneration) || state.runtimeGeneration < 1
    || !Number.isInteger(state.revision) || state.revision < 0) throw new TypeError("reference graph snapshot state is invalid");
  const providerIds = snapshots.map((snapshot) => snapshot?.providerId);
  if (providerIds.some((providerId) => typeof providerId !== "string" || !providerId)
    || new Set(providerIds).size !== providerIds.length) throw new Error("reference graph providers are invalid or duplicated");
  for (const snapshot of snapshots) {
    if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0
      || !/^[a-f0-9]{64}$/.test(String(snapshot.manifestHash ?? ""))
      || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.snapshotPointers)) {
      throw new Error(`reference graph provider snapshot is invalid: ${snapshot.providerId}`);
    }
  }
  const nodes = uniqueSorted([...requiredRoots, ...snapshots.flatMap((snapshot) => snapshot.nodes)]);
  const edges = snapshots.flatMap((snapshot) => snapshot.edges)
    .sort((left, right) => compare(edgeKey(left), edgeKey(right)));
  const snapshotPointers = uniqueSorted(snapshots.flatMap((snapshot) => snapshot.snapshotPointers));
  const providerSnapshots = snapshots.map((snapshot) => ({
    providerId: snapshot.providerId,
    revision: snapshot.revision,
    manifestHash: snapshot.manifestHash,
  })).sort((left, right) => compare(left.providerId, right.providerId));
  const base = {
    graphVersion: "portable-reference-graph-v1",
    runtimeGeneration: state.runtimeGeneration,
    runtimeRevision: state.revision,
    createdAt: now(),
    nodes,
    edges,
    requiredRoots: uniqueSorted(requiredRoots),
    snapshotPointers,
    providerSnapshots,
  };
  const graph = { ...base, graphHash: portableReferenceGraphHash(base) };
  const errors = verifyReferenceGraph(graph);
  if (errors.length) throw new Error(errors.join("; "));
  return graph;
}

/**
 * Builds a graph for a caller that already owns RuntimeCoordinator's read
 * barrier.  This is intentionally separate from createConsistentReferenceGraph
 * so backup/Doctor can bind their bytes and graph to one exact revision.
 */
export async function createReferenceGraphAtSnapshot(options) {
  const { state, activeRoot, providers, requiredRoots = [], now = () => new Date().toISOString() } = options ?? {};
  if (typeof activeRoot !== "string" || !Array.isArray(providers)
    || providers.some((provider) => typeof provider?.snapshotReferences !== "function")) {
    throw new TypeError("snapshot reference graph requires state, activeRoot, and snapshot providers");
  }
  const snapshots = [];
  for (const provider of providers) snapshots.push(await provider.snapshotReferences(activeRoot));
  return graphFromSnapshots({ state, snapshots, requiredRoots, now });
}

/**
 * Takes one coordinator barrier and asks each repository provider for its
 * read-only snapshot. Providers must not acquire the coordinator lock again.
 */
/** @param {{ coordinator: any, providers: Array<{ snapshotReferences(activeRoot: string): Promise<any> }>, requiredRoots?: string[], now?: () => string }} options */
export async function createConsistentReferenceGraph(options) {
  const { coordinator, providers, requiredRoots = [], now = () => new Date().toISOString() } = options;
  if (!coordinator || !Array.isArray(providers) || providers.some((provider) => typeof provider?.snapshotReferences !== "function")) {
    throw new TypeError("consistent reference graph requires a coordinator and snapshot providers");
  }
  return (await coordinator.withConsistentSnapshot(({ state, activeRoot }) => createReferenceGraphAtSnapshot({ state, activeRoot, providers, requiredRoots, now }))).result;
}

export function reachableReferenceSet(graph, roots) {
  const errors = verifyReferenceGraph(graph);
  if (errors.length) throw new Error(errors.join("; "));
  const marked = new Set(roots);
  const queue = [...marked];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of graph.edges) if (edge.fromRef === current && !marked.has(edge.toRef)) {
      marked.add(edge.toRef);
      queue.push(edge.toRef);
    }
  }
  return marked;
}

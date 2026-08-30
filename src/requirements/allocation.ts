import {
  governedFacetSatisfiesRuntime,
  validateGovernedFacetValueRuntime,
} from "../contracts/governed-facet-runtime.mjs";
import {
  projectBundleItemsForOwner,
  verifyInstanceSupply,
  type BundleProjectionInput,
  type InstanceSupply,
  type ResourceFacet,
} from "../assembly/resources";
import {
  validateSafetyCheckpointRecord,
  type RequirementAllocation,
  type RequirementKind,
  type RequirementNode,
  type RequirementSatisfaction,
  type SafetyCheckpointContext,
  type SafetyCheckpointRecord,
} from "./contracts";
import {
  requirementArtifactContentHashRuntime,
  validateRequirementAllocationResultRuntime,
  validateRequirementNodeRuntime,
  validateRequirementReadinessRuntime,
} from "./runtime.mjs";
import type { FacetId, UnitId } from "../contracts/registries";

export interface RequirementSupplyFacet {
  facetId: FacetId;
  value: number | string | boolean | readonly string[];
  unitId?: UnitId;
}

export interface PackageSupplyAuthorityRef {
  manifestHash: string;
  instanceSupplyId: string;
  instanceSupplyHash: string;
  bundleItemHash: string;
  ownerSkuId: string;
}

interface AllocatableRequirementSupplyBase {
  refId: string;
  kind: RequirementKind;
  facets: RequirementSupplyFacet[];
  quantity: number;
  availability: RequirementAllocation["availability"];
  verificationStatus: RequirementAllocation["verificationStatus"];
  satisfiesBefore?: RequirementAllocation["satisfiesBefore"];
  evidenceRefs: string[];
  observationRefs: string[];
}

/** Package and user inventory are concrete, owner-scoped physical supplies. */
export type AllocatableRequirementSupply = AllocatableRequirementSupplyBase & (
  | {
    source: "package_content";
    ownerInstanceId: string;
    /** Graph replay resolves this to the owner's locked adapter manifest. */
    packageAuthorityRef: PackageSupplyAuthorityRef;
  }
  | { source: "user_resource"; ownerInstanceId: string; packageAuthorityRef?: never }
  | { source: "component" | "purchase"; ownerInstanceId?: string; packageAuthorityRef?: never }
);

export interface PackageInstanceAvailabilityAssertion {
  availability: RequirementAllocation["availability"];
  verificationStatus: RequirementAllocation["verificationStatus"];
  satisfiesBefore?: RequirementAllocation["satisfiesBefore"];
  observationRefs: string[];
}

export interface PackageInstanceSupplyProjectionInput extends BundleProjectionInput {
  manifestHash: string;
  availabilityAssertions?: Readonly<Record<string, PackageInstanceAvailabilityAssertion>>;
}

export interface AuthoritativeRequirementCheckpoint {
  checkpoint: SafetyCheckpointRecord;
  context: SafetyCheckpointContext;
}

export interface RequirementAllocationOptions {
  safetyCheckpoints?: readonly AuthoritativeRequirementCheckpoint[];
  /** Compatibility alias for composition roots that already index checkpoints. */
  checkpointByRequirement?: ReadonlyMap<string, AuthoritativeRequirementCheckpoint>;
  blockedRequirementIds?: readonly string[];
}

interface RemainingRequirementSupplyBase {
  refId: string;
  quantity: number;
}

export type RemainingRequirementSupply = RemainingRequirementSupplyBase & (
  | { source: "package_content" | "user_resource"; ownerInstanceId: string }
  | { source: "component" | "purchase"; ownerInstanceId?: string }
);

export interface RequirementAllocationResult {
  schemaVersion: "requirement-allocation-v1";
  requirements: RequirementNode[];
  supplies: AllocatableRequirementSupply[];
  satisfactions: RequirementSatisfaction[];
  remainingSupplies: RemainingRequirementSupply[];
  blockedRequirementIds: string[];
  checkpointRefs: SafetyCheckpointRecord[];
  contentHash: string;
}

export interface RequirementReadiness {
  schemaVersion: "requirement-readiness-v1";
  sourceAllocationHash: string;
  assemblyReady: boolean;
  powerReady: boolean;
  firstBootReady: boolean;
  osInstallReady: boolean;
  assemblyBlockerRequirementIds: string[];
  powerBlockerRequirementIds: string[];
  firstBootBlockerRequirementIds: string[];
  osInstallBlockerRequirementIds: string[];
  contentHash: string;
}

const STAGE_ORDER: Record<NonNullable<RequirementNode["requiredBefore"]>, number> = {
  assembly: 0,
  pre_power: 1,
  first_boot: 2,
  os_install: 3,
};

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function supplyKey(value: Pick<AllocatableRequirementSupply, "source" | "refId" | "ownerInstanceId">): string {
  return `${value.source}\0${value.ownerInstanceId ?? ""}\0${value.refId}`;
}

function normalizeStrings(values: readonly string[]): string[] {
  return [...values].map((value) => value.normalize("NFC")).sort(compare);
}

function normalizeRequirement(requirement: RequirementNode): RequirementNode {
  return {
    ...structuredClone(requirement),
    predicates: [...requirement.predicates].sort((left, right) => compare(
      `${left.facetId}\0${left.operator}\0${JSON.stringify(left.value)}\0${left.unitId ?? ""}`,
      `${right.facetId}\0${right.operator}\0${JSON.stringify(right.value)}\0${right.unitId ?? ""}`,
    )),
    producedBy: { ...requirement.producedBy, instanceIds: normalizeStrings(requirement.producedBy.instanceIds) },
    evidenceRefs: normalizeStrings(requirement.evidenceRefs),
  };
}

function normalizeSupply(supply: AllocatableRequirementSupply): AllocatableRequirementSupply {
  return {
    source: supply.source,
    refId: supply.refId.normalize("NFC"),
    ...(supply.ownerInstanceId !== undefined ? { ownerInstanceId: supply.ownerInstanceId.normalize("NFC") } : {}),
    ...(supply.packageAuthorityRef !== undefined ? { packageAuthorityRef: structuredClone(supply.packageAuthorityRef) } : {}),
    kind: supply.kind,
    facets: structuredClone(supply.facets).map((facet) => ({
      ...facet,
      ...(Array.isArray(facet.value) ? { value: [...facet.value].sort(compare) } : {}),
    })).sort((left, right) => compare(left.facetId, right.facetId)),
    quantity: supply.quantity,
    availability: supply.availability,
    verificationStatus: supply.verificationStatus,
    ...(supply.satisfiesBefore !== undefined ? { satisfiesBefore: supply.satisfiesBefore } : {}),
    evidenceRefs: normalizeStrings(supply.evidenceRefs),
    observationRefs: normalizeStrings(supply.observationRefs),
  } as AllocatableRequirementSupply;
}

function isGated(requirement: RequirementNode): boolean {
  return requirement.criticality === "boot" || requirement.criticality === "safety"
    || requirement.requiredBefore !== undefined;
}

function supplyMatchesRequirement(
  supply: AllocatableRequirementSupply,
  requirement: RequirementNode,
  checkpointRequirementIds: ReadonlySet<string>,
): boolean {
  if (supply.kind !== requirement.kind) return false;
  if ((supply.source === "package_content" || supply.source === "user_resource")
    && !requirement.producedBy.instanceIds.includes(supply.ownerInstanceId)) return false;
  if (requirement.requiredBefore !== undefined && supply.satisfiesBefore !== undefined
    && STAGE_ORDER[supply.satisfiesBefore] > STAGE_ORDER[requirement.requiredBefore]) return false;
  if (isGated(requirement) && !checkpointRequirementIds.has(requirement.requirementId)
    && (supply.availability !== "present_verified" || supply.verificationStatus !== "verified")) return false;
  return requirement.predicates.every((predicate) => supply.facets.some((facet) => governedFacetSatisfiesRuntime(facet, predicate)));
}

function packageKind(kind: InstanceSupply["kind"]): RequirementKind {
  if (kind === "cable" || kind === "fastener" || kind === "tool" || kind === "consumable") return kind;
  return "accessory";
}

function governedPackageFacet(facet: ResourceFacet): RequirementSupplyFacet {
  return {
    facetId: facet.facetId,
    value: Array.isArray(facet.value) ? [...facet.value].sort(compare) : facet.value,
    ...(facet.facetId === "fastener.length_mm" ? { unitId: "mm" } : {}),
  } as RequirementSupplyFacet;
}

/**
 * An official package claim is only a planned/unverified supply until a
 * plan-scoped observation asserts the item is physically present.
 */
export async function packageInstanceSupplyToAllocatableSupply(
  supply: InstanceSupply,
  assertion?: PackageInstanceAvailabilityAssertion,
  manifestHash?: string,
): Promise<AllocatableRequirementSupply> {
  if (!await verifyInstanceSupply(supply)) throw new TypeError("instance supply invalid or content hash mismatch");
  if (typeof manifestHash !== "string" || !/^[a-f0-9]{64}$/u.test(manifestHash)) throw new TypeError("locked adapter manifest hash is required");
  if (assertion !== undefined) {
    const allowed = ["availability", "verificationStatus", "satisfiesBefore", "observationRefs"];
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)
      || Object.keys(assertion).some((key) => !allowed.includes(key))
      || !["planned", "ordered", "present_verified"].includes(assertion.availability)
      || !["unverified", "verified"].includes(assertion.verificationStatus)
      || (assertion.availability === "present_verified" && assertion.verificationStatus !== "verified")
      || !Array.isArray(assertion.observationRefs)
      || (assertion.availability === "present_verified" && assertion.observationRefs.length === 0)
      || assertion.observationRefs.some((ref) => typeof ref !== "string"
        || !/^observation:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(ref))
      || new Set(assertion.observationRefs).size !== assertion.observationRefs.length) {
      throw new TypeError("package availability assertion invalid");
    }
  }
  const result = normalizeSupply({
    source: "package_content",
    refId: supply.bundleItemId,
    ownerInstanceId: supply.ownerInstanceId,
    packageAuthorityRef: {
      manifestHash,
      instanceSupplyId: supply.supplyId,
      instanceSupplyHash: supply.contentHash,
      bundleItemHash: supply.bundleItemHash,
      ownerSkuId: supply.ownerSkuId,
    },
    kind: packageKind(supply.kind),
    facets: supply.specification.map(governedPackageFacet),
    quantity: supply.quantity,
    availability: assertion?.availability ?? "planned",
    verificationStatus: assertion?.verificationStatus ?? "unverified",
    ...(assertion?.satisfiesBefore !== undefined ? { satisfiesBefore: assertion.satisfiesBefore } : {}),
    evidenceRefs: supply.evidenceFactIds,
    observationRefs: assertion?.observationRefs ?? [],
  });
  for (const facet of result.facets) {
    const errors = validateGovernedFacetValueRuntime(facet);
    if (errors.length) throw new TypeError(`package supply facet invalid: ${errors.join("; ")}`);
  }
  return result;
}

/** Project locked bundle items and preserve ownerInstanceId + bundleItemId identity. */
export async function projectPackageInstanceSupplies(
  input: PackageInstanceSupplyProjectionInput,
): Promise<AllocatableRequirementSupply[]> {
  const allowed = ["ownerInstanceId", "ownerSkuId", "manifestHash", "bundleItems", "region", "revision", "availabilityAssertions"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new TypeError("package instance supply projection contains unknown fields");
  }
  if (input.availabilityAssertions !== undefined
    && (!input.availabilityAssertions || typeof input.availabilityAssertions !== "object" || Array.isArray(input.availabilityAssertions))) {
    throw new TypeError("package availability assertions must be a record");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.manifestHash)) throw new TypeError("locked adapter manifest hash is required");
  const supplies = await projectBundleItemsForOwner({
    ownerInstanceId: input.ownerInstanceId,
    ownerSkuId: input.ownerSkuId,
    bundleItems: input.bundleItems,
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
  });
  const availableIds = new Set(supplies.map((supply) => supply.bundleItemId));
  for (const bundleItemId of Object.keys(input.availabilityAssertions ?? {})) {
    if (!availableIds.has(bundleItemId)) throw new TypeError(`availability assertion references an unprojected bundle item: ${bundleItemId}`);
  }
  return Promise.all(supplies.map((supply) => packageInstanceSupplyToAllocatableSupply(
    supply,
    input.availabilityAssertions?.[supply.bundleItemId],
    input.manifestHash,
  )));
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
  initialCapacity: number;
}

function addFlowEdge(graph: FlowEdge[][], from: number, to: number, capacity: number): FlowEdge {
  const forward: FlowEdge = { to, reverse: graph[to]!.length, capacity, initialCapacity: capacity };
  const reverse: FlowEdge = { to: from, reverse: graph[from]!.length, capacity: 0, initialCapacity: 0 };
  graph[from]!.push(forward);
  graph[to]!.push(reverse);
  return forward;
}

function maxFlow(graph: FlowEdge[][], source: number, sink: number): number {
  let total = 0;
  while (true) {
    const parent: Array<{ node: number; edgeIndex: number } | undefined> = new Array(graph.length);
    const queue = [source];
    parent[source] = { node: source, edgeIndex: -1 };
    for (let cursor = 0; cursor < queue.length && parent[sink] === undefined; cursor += 1) {
      const node = queue[cursor]!;
      for (const [edgeIndex, edge] of graph[node]!.entries()) {
        if (edge.capacity <= 0 || parent[edge.to] !== undefined) continue;
        parent[edge.to] = { node, edgeIndex };
        queue.push(edge.to);
        if (edge.to === sink) break;
      }
    }
    if (parent[sink] === undefined) return total;
    let amount = Number.MAX_SAFE_INTEGER;
    for (let node = sink; node !== source;) {
      const step = parent[node]!;
      const edge = graph[step.node]![step.edgeIndex]!;
      amount = Math.min(amount, edge.capacity);
      node = step.node;
    }
    for (let node = sink; node !== source;) {
      const step = parent[node]!;
      const edge = graph[step.node]![step.edgeIndex]!;
      edge.capacity -= amount;
      graph[node]![edge.reverse]!.capacity += amount;
      node = step.node;
    }
    total += amount;
  }
}

function validCheckpoints(
  requirements: readonly RequirementNode[],
  options: RequirementAllocationOptions,
): SafetyCheckpointRecord[] {
  const byId = new Map(requirements.map((requirement) => [requirement.requirementId, requirement]));
  const candidates = [
    ...(options.safetyCheckpoints ?? []),
    ...(options.checkpointByRequirement === undefined ? [] : [...options.checkpointByRequirement.values()]),
  ];
  const valid = new Map<string, SafetyCheckpointRecord>();
  const provenanceByKey = new Map<string, string>();
  for (const candidate of candidates) {
    const requirement = byId.get(candidate.checkpoint.requirementId);
    if (!requirement || validateSafetyCheckpointRecord(candidate.checkpoint, requirement, candidate.context).length > 0) continue;
    const key = candidate.checkpoint.checkpointId;
    const provenance = requirementArtifactContentHashRuntime(
      { checkpoint: candidate.checkpoint, context: candidate.context },
      "safety-checkpoint-authority-v1",
    );
    if (provenance === null) throw new TypeError("safety checkpoint provenance cannot be hashed");
    const previous = provenanceByKey.get(key);
    if (previous !== undefined && previous !== provenance) {
      throw new TypeError(`conflicting safety checkpoint authority: ${candidate.checkpoint.checkpointId}`);
    }
    provenanceByKey.set(key, provenance);
    valid.set(key, structuredClone(candidate.checkpoint));
  }
  return [...valid.values()].sort((left, right) => compare(
    `${left.requirementId}\0${left.checkpointId}`,
    `${right.requirementId}\0${right.checkpointId}`,
  ));
}

/** Allocate non-shareable physical supplies with a deterministic max-flow. */
export function allocateRequirementSupplies(
  requirementsInput: readonly RequirementNode[],
  suppliesInput: readonly AllocatableRequirementSupply[],
  options: RequirementAllocationOptions = {},
): RequirementAllocationResult {
  if (!Array.isArray(requirementsInput) || !Array.isArray(suppliesInput)) throw new TypeError("requirement allocation inputs must be arrays");
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["safetyCheckpoints", "checkpointByRequirement", "blockedRequirementIds"].includes(key))) {
    throw new TypeError("requirement allocation options contain unknown fields");
  }
  const requirements = requirementsInput.map(normalizeRequirement)
    .sort((left, right) => compare(left.requirementId, right.requirementId));
  for (const requirement of requirements) {
    const errors = validateRequirementNodeRuntime(requirement);
    if (errors.length) throw new TypeError(`Invalid requirement: ${errors.join("; ")}`);
  }
  if (new Set(requirements.map(({ requirementId }) => requirementId)).size !== requirements.length) throw new TypeError("requirement IDs must be unique");
  const supplies = suppliesInput.map(normalizeSupply).sort((left, right) => compare(supplyKey(left), supplyKey(right)));
  if (new Set(supplies.map(supplyKey)).size !== supplies.length) throw new TypeError("supplies must be unique by source + ownerInstanceId + refId");
  for (const supply of supplies) {
    if (!Number.isSafeInteger(supply.quantity) || supply.quantity <= 0
      || ((supply.source === "package_content" || supply.source === "user_resource") && supply.ownerInstanceId === undefined)
      || (supply.availability === "present_verified" && supply.verificationStatus !== "verified")
      || (supply.availability === "present_verified" && supply.observationRefs.length === 0)
      || supply.facets.some((facet) => validateGovernedFacetValueRuntime(facet).length > 0)) {
      throw new TypeError(`Invalid requirement supply: ${supplyKey(supply)}`);
    }
  }
  const checkpointRefs = validCheckpoints(requirements, options);
  const checkpointRequirementIds = new Set(checkpointRefs.map(({ requirementId }) => requirementId));
  const blocked = new Set(options.blockedRequirementIds ?? []);
  if ([...blocked].some((requirementId) => !requirements.some((candidate) => candidate.requirementId === requirementId))) {
    throw new TypeError("blocked requirement reference missing");
  }

  const orderedRequirements = [...requirements].sort((left, right) => {
    const priority = (value: RequirementNode): number => value.criticality === "safety" ? 0 : value.criticality === "boot" ? 1 : 2;
    return priority(left) - priority(right) || right.predicates.length - left.predicates.length || compare(left.requirementId, right.requirementId);
  });
  const source = 0;
  const supplyOffset = 1;
  const requirementOffset = supplyOffset + supplies.length;
  const sink = requirementOffset + orderedRequirements.length;
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  supplies.forEach((supply, index) => addFlowEdge(graph, source, supplyOffset + index, supply.quantity));
  orderedRequirements.forEach((requirement, index) => addFlowEdge(graph, requirementOffset + index, sink, requirement.quantity));
  const matchEdges: Array<{ supplyIndex: number; requirementIndex: number; edge: FlowEdge }> = [];
  supplies.forEach((supply, supplyIndex) => orderedRequirements.forEach((requirement, requirementIndex) => {
    // A closure-level block (cycle or incomplete fixed point) is authority,
    // not an inventory shortage. Physical stock cannot make it executable.
    if (blocked.has(requirement.requirementId)) return;
    if (!supplyMatchesRequirement(supply, requirement, checkpointRequirementIds)) return;
    const edge = addFlowEdge(graph, supplyOffset + supplyIndex, requirementOffset + requirementIndex, Math.min(supply.quantity, requirement.quantity));
    matchEdges.push({ supplyIndex, requirementIndex, edge });
  }));
  maxFlow(graph, source, sink);

  const allocationsByRequirement = new Map<string, RequirementAllocation[]>();
  const consumed = new Map<string, number>();
  for (const { supplyIndex, requirementIndex, edge } of matchEdges) {
    const quantity = edge.initialCapacity - edge.capacity;
    if (quantity <= 0) continue;
    const supply = supplies[supplyIndex]!;
    const requirement = orderedRequirements[requirementIndex]!;
    const allocation = {
      source: supply.source,
      refId: supply.refId,
      ...(supply.ownerInstanceId !== undefined ? { ownerInstanceId: supply.ownerInstanceId } : {}),
      quantity,
      availability: supply.availability,
      verificationStatus: supply.verificationStatus,
      ...(supply.satisfiesBefore !== undefined ? { satisfiesBefore: supply.satisfiesBefore } : {}),
      evidenceRefs: [...supply.evidenceRefs],
      observationRefs: [...supply.observationRefs],
    } as RequirementAllocation;
    allocationsByRequirement.set(requirement.requirementId, [...(allocationsByRequirement.get(requirement.requirementId) ?? []), allocation]);
    consumed.set(supplyKey(supply), (consumed.get(supplyKey(supply)) ?? 0) + quantity);
  }

  const satisfactions: RequirementSatisfaction[] = requirements.map((requirement) => {
    const allocations = (allocationsByRequirement.get(requirement.requirementId) ?? []).sort((left, right) => compare(supplyKey(left), supplyKey(right)));
    const allocated = allocations.reduce((total, allocation) => total + allocation.quantity, 0);
    const residualQuantity = requirement.quantity - allocated;
    return {
      requirementId: requirement.requirementId,
      status: blocked.has(requirement.requirementId) ? "blocked" : residualQuantity === 0 ? "satisfied" : "open",
      allocations,
      residualQuantity,
    };
  });
  const remainingSupplies: RemainingRequirementSupply[] = supplies.map((supply) => ({
    source: supply.source,
    refId: supply.refId,
    ...(supply.ownerInstanceId !== undefined ? { ownerInstanceId: supply.ownerInstanceId } : {}),
    quantity: supply.quantity - (consumed.get(supplyKey(supply)) ?? 0),
  } as RemainingRequirementSupply));
  const material = {
    schemaVersion: "requirement-allocation-v1" as const,
    requirements,
    supplies,
    satisfactions,
    remainingSupplies,
    blockedRequirementIds: [...blocked].sort(compare),
    checkpointRefs,
  };
  const contentHash = requirementArtifactContentHashRuntime(material, material.schemaVersion);
  if (contentHash === null) throw new TypeError("requirement allocation content hash could not be computed");
  const result: RequirementAllocationResult = { ...material, contentHash };
  const errors = validateRequirementAllocationResultRuntime(result);
  if (errors.length) throw new TypeError(`Invalid requirement allocation result: ${errors.join("; ")}`);
  return result;
}

export const allocateRequirements = allocateRequirementSupplies;

/**
 * Readiness is a projection of one validated allocation artifact. It never
 * accepts caller-authored booleans and therefore cannot be greened by an
 * ordered/included/unverified safety supply.
 */
export function deriveRequirementReadiness(allocation: RequirementAllocationResult): RequirementReadiness {
  const errors = validateRequirementAllocationResultRuntime(allocation);
  if (errors.length) throw new TypeError(`Invalid requirement allocation authority: ${errors.join("; ")}`);
  const satisfactionById = new Map(allocation.satisfactions.map((satisfaction) => [satisfaction.requirementId, satisfaction]));
  const unsatisfied = (requirement: RequirementNode): boolean => satisfactionById.get(requirement.requirementId)?.status !== "satisfied";
  const assemblyBlockers = allocation.requirements.filter((requirement) => requirement.requiredBefore === "assembly" && unsatisfied(requirement));
  const powerSpecific = allocation.requirements.filter((requirement) => (
    requirement.requiredBefore === "pre_power"
      || requirement.criticality === "safety"
      || (requirement.requiredBefore === undefined && requirement.criticality === "boot")
  ) && unsatisfied(requirement));
  const firstBootSpecific = allocation.requirements.filter((requirement) => (
    requirement.requiredBefore === "first_boot" || requirement.criticality === "boot"
  ) && unsatisfied(requirement));
  const osSpecific = allocation.requirements.filter((requirement) => requirement.requiredBefore === "os_install" && unsatisfied(requirement));
  const ids = (requirements: readonly RequirementNode[]): string[] => [...new Set(requirements.map(({ requirementId }) => requirementId))].sort(compare);
  const assemblyBlockerRequirementIds = ids(assemblyBlockers);
  const powerBlockerRequirementIds = ids([...assemblyBlockers, ...powerSpecific]);
  const firstBootBlockerRequirementIds = ids([
    ...assemblyBlockers,
    ...powerSpecific,
    ...firstBootSpecific,
  ]);
  const osInstallBlockerRequirementIds = ids([
    ...assemblyBlockers,
    ...powerSpecific,
    ...firstBootSpecific,
    ...osSpecific,
  ]);
  const material = {
    schemaVersion: "requirement-readiness-v1" as const,
    sourceAllocationHash: allocation.contentHash,
    assemblyReady: assemblyBlockerRequirementIds.length === 0,
    powerReady: powerBlockerRequirementIds.length === 0,
    firstBootReady: firstBootBlockerRequirementIds.length === 0,
    osInstallReady: osInstallBlockerRequirementIds.length === 0,
    assemblyBlockerRequirementIds,
    powerBlockerRequirementIds,
    firstBootBlockerRequirementIds,
    osInstallBlockerRequirementIds,
  };
  const contentHash = requirementArtifactContentHashRuntime(material, material.schemaVersion);
  if (contentHash === null) throw new TypeError("requirement readiness content hash could not be computed");
  const result: RequirementReadiness = { ...material, contentHash };
  const readinessErrors = validateRequirementReadinessRuntime(result, allocation);
  if (readinessErrors.length) throw new TypeError(`Invalid requirement readiness: ${readinessErrors.join("; ")}`);
  return result;
}

export const deriveReadiness = deriveRequirementReadiness;

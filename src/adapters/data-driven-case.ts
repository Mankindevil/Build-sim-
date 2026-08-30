import { CAPABILITY_FACET_REGISTRY } from "../contracts/registries";
import { canonicalize } from "../hash";
import { createFactRecord, verifyFactRecord } from "../facts/hash";
import { createFactSnapshot, verifyFactSnapshot } from "../facts/snapshots";
import { verifyConflictSet } from "../facts/conflicts";
import { createEvidenceClaim, verifyEvidenceClaim } from "../evidence/claims";
import { createCapabilityRecord, type CapabilityRecord } from "../capabilities/facets";
import {
  compareCanonical,
  containsNonNfcText,
  deepFreeze,
  hasExactKeys,
  safeRecord,
} from "../capabilities/validation";
import {
  createCaseAdapterManifest,
  verifyCaseAdapterManifest,
  type CaseAdapterFactClosure,
  type CaseAdapterManifest,
  type CaseAdapterSeed,
  type CaseAssemblyConstraint,
  type CaseGeometryManifest,
  type CaseMount,
  type CasePortAnchor,
  type CaseRoutingZone,
} from "./contracts";
import type { AssemblyResourcePattern, BundleItem } from "../assembly/resources";

// Kept local because timestamps are persisted protocol, not Date parser input.
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export interface CaseAdapterProjection {
  schemaVersion: "case-adapter-projection-v1";
  adapterId: string;
  adapterVersion: string;
  manifestHash: string;
  capabilityRecord: CapabilityRecord;
  geometry: CaseGeometryManifest;
  mounts: CaseMount[];
  ports: CasePortAnchor[];
  routing: { zones: CaseRoutingZone[] };
  assembly: {
    constraints: CaseAssemblyConstraint[];
    bundleItems: BundleItem[];
    resourcePatterns: AssemblyResourcePattern[];
  };
  provenance: string[];
}

export interface MaterializedCaseAdapterSeed {
  manifest: CaseAdapterManifest;
  factClosure: CaseAdapterFactClosure;
  projection: CaseAdapterProjection;
}

/**
 * Production trust seam. The implementation is owned by the runtime's active
 * FactRepository root and MUST verify the snapshot plus EvidenceDocument,
 * EvidenceCapture, immutable bytes, claim locators, and exact product identity
 * before returning. Raw callers and bundled seeds are not this authority.
 */
export interface RootBoundCaseAdapterFactAuthority {
  readonly authorityKind: "fact-repository-root-bound-v1";
  resolveExactCaseAdapterFactClosureAtRoot(
    activeRoot: string,
    identity: CaseAdapterManifest["identity"],
    manifestHash: string,
  ): Promise<CaseAdapterFactClosure>;
}

function validateSeed(value: unknown): string[] {
  const seed = safeRecord(value);
  if (!seed) return ["case adapter seed must be an object"];
  const errors: string[] = [];
  if (!hasExactKeys(seed, ["schemaVersion", "manifest", "factInputs", "evidenceSources", "snapshotCreatedAt"])) errors.push("case adapter seed contains unknown or missing fields");
  if (containsNonNfcText(seed)) errors.push("case adapter seed contains non-NFC text");
  if (seed.schemaVersion !== "case-adapter-seed-v1") errors.push("case adapter seed schemaVersion invalid");
  if (!Array.isArray(seed.factInputs) || seed.factInputs.length === 0) errors.push("case adapter seed factInputs invalid");
  if (!Array.isArray(seed.evidenceSources) || seed.evidenceSources.length === 0) errors.push("case adapter seed evidenceSources invalid");
  else {
    const sourceIds = new Set<string>();
    const locatedFactIds = new Set<string>();
    seed.evidenceSources.forEach((source, index) => {
      const record = safeRecord(source);
      if (!record || !hasExactKeys(record, ["evidenceSourceId", "authority", "subject", "documentId", "documentSha256", "captureId", "retrievedAt", "factLocators"])) {
        errors.push(`case adapter evidenceSources.${index} shape invalid`);
        return;
      }
      if (typeof record.evidenceSourceId !== "string" || sourceIds.has(record.evidenceSourceId)) errors.push(`case adapter evidenceSources.${index} identity invalid`);
      else sourceIds.add(record.evidenceSourceId);
      if (!Array.isArray(record.factLocators) || record.factLocators.length === 0) errors.push(`case adapter evidenceSources.${index} factLocators invalid`);
      else for (const locator of record.factLocators) {
        const locatorRecord = safeRecord(locator);
        const factId = locatorRecord?.factId;
        if (!locatorRecord || !hasExactKeys(locatorRecord, ["factId", "locator"]) || typeof factId !== "string" || locatedFactIds.has(factId)) {
          errors.push(`case adapter evidenceSources.${index} fact locator invalid or duplicate`);
        } else locatedFactIds.add(factId);
      }
    });
    if (Array.isArray(seed.factInputs)) {
      const factIds = seed.factInputs.map((input) => safeRecord(input)?.factId).filter((id): id is string => typeof id === "string");
      if (factIds.length !== locatedFactIds.size || factIds.some((id) => !locatedFactIds.has(id))) errors.push("case adapter evidence sources must locate every fact exactly once");
    }
  }
  if (!isIsoTimestamp(seed.snapshotCreatedAt)) errors.push("case adapter seed snapshotCreatedAt invalid");
  return errors;
}

async function verifyFactClosure(closure: CaseAdapterFactClosure): Promise<void> {
  const record = safeRecord(closure);
  if (!record || !hasExactKeys(record, ["snapshot", "facts", "conflicts", "evidenceClaims"])) throw new TypeError("case adapter fact closure shape invalid");
  if (!await verifyFactSnapshot(closure.snapshot)) throw new TypeError("case adapter fact closure snapshot hash invalid");
  if (!Array.isArray(closure.facts) || !Array.isArray(closure.conflicts) || !Array.isArray(closure.evidenceClaims)) throw new TypeError("case adapter fact closure arrays invalid");
  if (closure.facts.length !== closure.snapshot.factRefs.length || closure.conflicts.length !== closure.snapshot.conflictRefs.length) {
    throw new TypeError("case adapter fact closure does not exactly match snapshot refs");
  }
  const facts = new Map<string, string>();
  for (const fact of closure.facts) {
    if (!await verifyFactRecord(fact)) throw new TypeError("case adapter fact closure contains invalid fact content hash");
    if (facts.has(fact.factId)) throw new TypeError("case adapter fact closure contains duplicate fact IDs");
    facts.set(fact.factId, fact.contentHash);
  }
  for (const ref of closure.snapshot.factRefs) {
    if (facts.get(ref.factId) !== ref.contentHash) throw new TypeError("case adapter fact closure has dangling or mismatched fact ref");
  }
  const conflicts = new Map<string, string>();
  for (const conflict of closure.conflicts) {
    if (!await verifyConflictSet(conflict)) throw new TypeError("case adapter fact closure contains invalid conflict content hash");
    if (conflicts.has(conflict.conflictSetId)) throw new TypeError("case adapter fact closure contains duplicate conflict IDs");
    conflicts.set(conflict.conflictSetId, conflict.contentHash);
  }
  for (const ref of closure.snapshot.conflictRefs) {
    if (conflicts.get(ref.conflictSetId) !== ref.contentHash) throw new TypeError("case adapter fact closure has dangling or mismatched conflict ref");
  }
  const claims = new Map<string, CaseAdapterFactClosure["evidenceClaims"][number]>();
  for (const claim of closure.evidenceClaims) {
    if (!await verifyEvidenceClaim(claim) || claim.status !== "active") throw new TypeError("case adapter evidence claim closure contains invalid or inactive claim");
    if (claims.has(claim.claimId)) throw new TypeError("case adapter evidence claim closure contains duplicate claim IDs");
    claims.set(claim.claimId, claim);
  }
  const referencedClaimIds = new Set<string>();
  for (const fact of closure.facts) {
    if ((fact.authority === "official" || fact.authority === "third_party") && fact.evidenceRefs.length === 0) {
      throw new TypeError("case adapter source fact has no evidence claim closure");
    }
    for (const claimId of fact.evidenceRefs) {
      referencedClaimIds.add(claimId);
      const claim = claims.get(claimId);
      if (!claim) throw new TypeError("case adapter source fact references an unverified evidence claim");
      if (fact.subject.kind !== "product" || claim.scope !== "revision"
        || claim.subject.skuId !== fact.subject.skuId || claim.subject.revision !== fact.subject.revision || claim.subject.region !== fact.subject.region
        || claim.fieldId !== fact.field || canonicalize(claim.value) !== canonicalize(fact.value) || claim.unit !== fact.unit
        || claim.authority !== fact.authority || Date.parse(claim.retrievedAt) > Date.parse(fact.retrievedAt)) {
        throw new TypeError("case adapter evidence claim does not close exact fact identity/value/authority");
      }
    }
  }
  if (referencedClaimIds.size !== claims.size || [...claims.keys()].some((claimId) => !referencedClaimIds.has(claimId))) {
    throw new TypeError("case adapter evidence claim closure contains unreferenced claims");
  }
}

function allManifestSourceFactIds(manifest: CaseAdapterManifest): Set<string> {
  const result = new Set<string>(manifest.identity.identityFactIds);
  const add = (ids: readonly string[]) => ids.forEach((id) => result.add(id));
  manifest.capabilityBindings.forEach((binding) => add(binding.sourceFactIds));
  const geometryNodes = [
    manifest.geometry.envelope,
    ...manifest.geometry.interiorSpaces,
    ...manifest.geometry.forbiddenZones,
    ...manifest.geometry.serviceCorridors,
  ];
  geometryNodes.forEach((node) => add(node.binding.sourceFactIds));
  manifest.mounts.forEach((mount) => add(mount.binding.sourceFactIds));
  manifest.ports.forEach((port) => add(port.binding.sourceFactIds));
  manifest.routingZones.forEach((zone) => add(zone.binding.sourceFactIds));
  manifest.assemblyConstraints.forEach((constraint) => add(constraint.binding.sourceFactIds));
  manifest.bundleItems.forEach((item) => { add(item.variantScopeFactIds); add(item.evidenceFactIds); });
  manifest.resourcePatterns.forEach((pattern) => add(pattern.evidenceFactIds));
  return result;
}

function assertExactManifestFactAuthority(manifest: CaseAdapterManifest, closure: CaseAdapterFactClosure): Map<string, CaseAdapterFactClosure["facts"][number]> {
  const factMap = new Map(closure.facts.map((fact) => [fact.factId, fact]));
  const snapshotIds = new Set(closure.snapshot.factRefs.map((ref) => ref.factId));
  const openConflictFactIds = new Set(closure.conflicts.filter((conflict) => conflict.status === "open").flatMap((conflict) => conflict.factIds));
  for (const factId of allManifestSourceFactIds(manifest)) {
    const fact = factMap.get(factId);
    if (!fact || !snapshotIds.has(factId)) throw new TypeError(`manifest source fact ${factId} is outside the exact fact snapshot`);
    if (fact.status !== "active" || openConflictFactIds.has(factId)) throw new TypeError(`manifest source fact ${factId} is not active and conflict-free`);
    if (fact.subject.kind !== "product"
      || fact.subject.skuId !== manifest.identity.skuId
      || fact.subject.region !== manifest.identity.region
      || fact.subject.revision !== manifest.identity.revision
      || fact.scope !== "revision") throw new TypeError(`manifest source fact ${factId} does not match exact adapter identity`);
  }
  const identityFacts = manifest.identity.identityFactIds.map((id) => factMap.get(id));
  if (identityFacts.some((fact) => !fact || !fact.field.startsWith("identity."))
    || !identityFacts.some((fact) => fact?.field === "identity.revision" && fact.value === manifest.identity.revision)) {
    throw new TypeError("case adapter exact revision identity is not closed by governed identity facts");
  }
  return factMap;
}

function assertVerifiedBindingsAreOfficial(manifest: CaseAdapterManifest, factMap: Map<string, CaseAdapterFactClosure["facts"][number]>): void {
  const bindings = [
    manifest.geometry.envelope.binding,
    ...manifest.geometry.interiorSpaces.map((node) => node.binding),
    ...manifest.geometry.forbiddenZones.map((node) => node.binding),
    ...manifest.geometry.serviceCorridors.map((node) => node.binding),
    ...manifest.mounts.map((mount) => mount.binding),
    ...manifest.ports.map((port) => port.binding),
    ...manifest.routingZones.map((zone) => zone.binding),
    ...manifest.assemblyConstraints.map((constraint) => constraint.binding),
  ];
  for (const binding of bindings) {
    if (binding.status === "verified" && binding.sourceFactIds.some((id) => factMap.get(id)?.authority !== "official")) {
      throw new TypeError("verified adapter binding requires official exact facts");
    }
  }
}

async function projectCapabilities(manifest: CaseAdapterManifest, closure: CaseAdapterFactClosure, facts: Map<string, CaseAdapterFactClosure["facts"][number]>): Promise<CapabilityRecord> {
  const facets = manifest.capabilityBindings.map((binding) => {
    const sources = binding.sourceFactIds.map((id) => facts.get(id)!);
    if (sources.some((fact) => fact.field !== binding.facetId)) throw new TypeError(`capability ${binding.facetId} is bound to a different fact field`);
    const value = canonicalize(sources[0]!.value);
    const unit = sources[0]!.unit;
    if (sources.some((fact) => canonicalize(fact.value) !== value || fact.unit !== unit)) throw new TypeError(`capability ${binding.facetId} source facts disagree`);
    const contract = CAPABILITY_FACET_REGISTRY[binding.facetId];
    return {
      facetId: binding.facetId,
      value: structuredClone(sources[0]!.value) as number | string | boolean | readonly string[],
      ...(unit !== undefined ? { unitId: unit as never } : {}),
      sourceFactIds: [...binding.sourceFactIds].sort(compareCanonical),
      safetyClass: contract.safetyClass,
    };
  });
  return createCapabilityRecord({
    schemaVersion: "capability-record-v1",
    subjectSkuId: manifest.identity.skuId,
    componentKindId: "case",
    factSnapshotRef: { snapshotId: closure.snapshot.snapshotId, contentHash: closure.snapshot.contentHash },
    facets,
    providerRefs: [`${manifest.adapterId}@${manifest.adapterVersion}`],
  });
}

async function projectResolvedCaseAdapter(manifest: CaseAdapterManifest, closure: CaseAdapterFactClosure): Promise<CaseAdapterProjection> {
  if (!await verifyCaseAdapterManifest(manifest)) throw new TypeError("case adapter manifest invalid or content hash mismatch");
  await verifyFactClosure(closure);
  const facts = assertExactManifestFactAuthority(manifest, closure);
  assertVerifiedBindingsAreOfficial(manifest, facts);
  const projection: CaseAdapterProjection = {
    schemaVersion: "case-adapter-projection-v1",
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    manifestHash: manifest.contentHash,
    capabilityRecord: await projectCapabilities(manifest, closure, facts),
    geometry: structuredClone(manifest.geometry),
    mounts: structuredClone(manifest.mounts),
    ports: structuredClone(manifest.ports),
    routing: { zones: structuredClone(manifest.routingZones) },
    assembly: {
      constraints: structuredClone(manifest.assemblyConstraints),
      bundleItems: structuredClone(manifest.bundleItems),
      resourcePatterns: structuredClone(manifest.resourcePatterns),
    },
    provenance: [...manifest.sourceRefs],
  };
  return deepFreeze(projection) as CaseAdapterProjection;
}

/**
 * Production entry point. There is deliberately no overload accepting a raw
 * closure: the active-root repository authority must resolve it server-side.
 */
export async function projectCaseAdapterAtRoot(
  manifest: CaseAdapterManifest,
  activeRoot: string,
  authority: RootBoundCaseAdapterFactAuthority,
): Promise<CaseAdapterProjection> {
  if (typeof activeRoot !== "string" || !activeRoot.startsWith("/") || activeRoot.includes("\0")) throw new TypeError("case adapter active root invalid");
  if (!authority || authority.authorityKind !== "fact-repository-root-bound-v1"
    || typeof authority.resolveExactCaseAdapterFactClosureAtRoot !== "function") {
    throw new TypeError("root-bound FactRepository authority is required for case adapter projection");
  }
  const closure = await authority.resolveExactCaseAdapterFactClosureAtRoot(
    activeRoot,
    structuredClone(manifest.identity),
    manifest.contentHash,
  );
  return projectResolvedCaseAdapter(manifest, closure);
}

/**
 * Fixture/import migration helper only. Its output proves deterministic schema
 * and hash behaviour but is not a production evidence authority. Production
 * callers must use projectCaseAdapterAtRoot.
 */
export async function materializeCaseAdapterFixtureSeed(seed: CaseAdapterSeed): Promise<MaterializedCaseAdapterSeed> {
  const errors = validateSeed(seed);
  if (errors.length) throw new TypeError(`Invalid case adapter seed: ${errors.join("; ")}`);
  const manifest = await createCaseAdapterManifest(seed.manifest);
  const sourceByFactId = new Map(seed.evidenceSources.flatMap((source) => source.factLocators.map((entry) => [entry.factId, { source, locator: entry.locator }] as const)));
  const evidenceClaims = [] as CaseAdapterFactClosure["evidenceClaims"];
  const facts = await Promise.all(seed.factInputs.map(async (input) => {
    const located = sourceByFactId.get(input.factId);
    if (!located) throw new TypeError(`case adapter fact ${input.factId} has no evidence source`);
    const { source, locator } = located;
    if (source.subject.skuId !== manifest.identity.skuId || source.subject.revision !== manifest.identity.revision || source.subject.region !== manifest.identity.region) {
      throw new TypeError(`case adapter evidence source for ${input.factId} crosses exact identity`);
    }
    const claim = await createEvidenceClaim({
      schemaVersion: "evidence-claim-v1",
      subject: structuredClone(source.subject),
      scope: "revision",
      fieldId: input.field,
      value: structuredClone(input.value),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      authority: source.authority,
      source: {
        documentId: source.documentId,
        documentSha256: source.documentSha256,
        captureId: source.captureId,
        locator: structuredClone(locator),
      },
      retrievedAt: source.retrievedAt,
      status: "active",
    });
    evidenceClaims.push(claim);
    return createFactRecord({
      ...structuredClone(input),
      authority: claim.authority,
      evidenceRefs: [claim.claimId],
      retrievedAt: claim.retrievedAt,
    });
  }));
  facts.sort((left, right) => compareCanonical(left.factId, right.factId));
  evidenceClaims.sort((left, right) => compareCanonical(left.claimId, right.claimId));
  const snapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: facts.map((fact) => ({ factId: fact.factId, contentHash: fact.contentHash })),
    conflictRefs: [],
    createdAt: seed.snapshotCreatedAt,
  });
  const factClosure: CaseAdapterFactClosure = deepFreeze({ snapshot, facts, conflicts: [], evidenceClaims }) as CaseAdapterFactClosure;
  return { manifest, factClosure, projection: await projectResolvedCaseAdapter(manifest, factClosure) };
}

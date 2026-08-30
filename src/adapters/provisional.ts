import { createHash } from "node:crypto";
import { canonicalize } from "../hash";
import { agentAuditHash } from "../agent/audit";
import { stableAgentJson } from "../agent/evaluation-contract";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import { CAPABILITY_FACET_REGISTRY } from "../contracts/registries";
import { verifyEvidenceClaim } from "../evidence/claims";
import type { EvidenceClaim } from "../evidence/contracts";
import type { EvidenceCapture, EvidenceDocument } from "../evidence/contracts";
import type { EvidencePipelineSubject } from "../evidence/jobs/contracts";
import type { ComponentInstance } from "../topology/contracts";
import {
  evidenceIdentityMatchesClaimSubjectRuntime,
  validateEvidenceCaptureRuntime,
  validateEvidenceDocumentRuntime,
} from "../evidence/claim-runtime.mjs";
import { verifyConflictSet } from "../facts/conflicts";
import type { FactRecord } from "../facts/contracts";
import { verifyFactRecord } from "../facts/hash";
import { verifyFactSnapshot } from "../facts/snapshots";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, readJson, sha256Json } from "../runtime/fs.mjs";
import {
  compareCanonical,
  deepFreeze,
  hasExactKeys,
  isPortableId,
  isSha256,
  safeRecord,
} from "../capabilities/validation";
import {
  createCaseAdapterManifest,
  verifyCaseAdapterManifest,
  type CaseAdapterFactClosure,
  type CaseAdapterIdentity,
  type CaseAdapterManifest,
  type CaseManifestBinding,
  type Vec3Mm,
} from "./contracts";

const CANDIDATE_ID = /^provisional-case-adapter-sha256-([a-f0-9]{64})$/;
const CANDIDATE_HASH_DOMAIN = "buildsim.provisional-case-adapter-candidate-v1";
const GENERATION_AUTHORITY_KIND = "case-adapter-generation-root-bound-v1" as const;

export type ProvisionalCaseAdapterDomain = "electronics" | "geometry" | "routing" | "assembly";

export interface ProvisionalCaseAdapterDomainResult {
  status: "ready" | "blocked";
  reason: string;
}

export interface ProvisionalCaseAdapterNextEvidenceAction {
  fieldId: string;
  preferredAuthority: "official";
  action: "acquire_product_page_or_manual" | "acquire_dimensioned_drawing" | "acquire_port_or_routing_view";
  reason: string;
}

export interface ProvisionalCaseAdapterPlanContext {
  planId: string;
  caseComponentInstanceId: string;
  planRevision: number;
  configHash: string;
}

export interface ProvisionalCaseAdapterAuthorityRefs {
  generationJobId: `job-${string}`;
  generationJobResultRef: `sha256:${string}`;
  planContextArtifactRef: `sha256:${string}`;
  evidenceClaimIds: string[];
  evidenceDocumentIds: string[];
  evidenceCaptureIds: string[];
  evidenceLocatorArtifactRefs: `sha256:${string}`[];
}

export interface ProvisionalCaseAdapterRegistryGuard {
  expectedPriorRegistrationHash: string | null;
  expectedPriorRegistryRef: `sha256:${string}` | null;
}

export interface ProvisionalCaseAdapterCandidate {
  schemaVersion: "provisional-case-adapter-candidate-v1";
  candidateId: `provisional-case-adapter-sha256-${string}`;
  status: "ready_for_review" | "partial";
  runtimeGeneration: number;
  planContext: ProvisionalCaseAdapterPlanContext;
  registryGuard: ProvisionalCaseAdapterRegistryGuard;
  authorityRefs: ProvisionalCaseAdapterAuthorityRefs;
  catalogIdentity: EvidencePipelineSubject;
  identity: CaseAdapterIdentity;
  factSnapshotRef: { snapshotId: string; contentHash: string };
  sourceAuthorities: Array<"official" | "third_party">;
  domains: Record<ProvisionalCaseAdapterDomain, ProvisionalCaseAdapterDomainResult>;
  missingFields: string[];
  nextEvidenceActions: ProvisionalCaseAdapterNextEvidenceAction[];
  manifest: CaseAdapterManifest | null;
  createdAt: string;
  contentHash: string;
}

export interface GenerateProvisionalCaseAdapterRequest {
  /** The plan and component are lookup keys, not an asserted product identity. */
  planId: string;
  caseComponentInstanceId: string;
  expectedRuntimeGeneration: number;
  expectedRuntimeRevision: number;
}

export interface ResolveProvisionalCaseAdapterContextRequest {
  planId: string;
  caseComponentInstanceId: string;
  runtimeGeneration: number;
  runtimeRevision: number;
}

export interface ResolvedProvisionalCaseAdapterContext {
  schemaVersion: "resolved-provisional-case-adapter-context-v1";
  planContext: ProvisionalCaseAdapterPlanContext;
  /** Exact V3 component projection resolved from the governed plan draft. */
  planComponent: ComponentInstance;
  /** Immutable server-resolved plan/config/component projection for audit replay. */
  planAuthority: { artifactRef: `sha256:${string}`; artifactBytes: Uint8Array };
  registryGuard: ProvisionalCaseAdapterRegistryGuard;
  generationJob: { jobId: `job-${string}`; resultRef: `sha256:${string}`; attemptStartedAt: string };
  catalogIdentity: EvidencePipelineSubject;
  identity: CaseAdapterIdentity;
  factClosure: CaseAdapterFactClosure;
  evidenceSources: CaseAdapterEvidenceSourceClosure[];
}

interface ProvisionalCaseAdapterPlanAuthorityArtifact {
  schemaVersion: "provisional-case-adapter-plan-authority-v1";
  planContext: ProvisionalCaseAdapterPlanContext;
  planComponent: ComponentInstance;
  catalogIdentity: EvidencePipelineSubject;
  identity: CaseAdapterIdentity;
}

export interface CaseAdapterEvidenceSourceClosure {
  document: EvidenceDocument;
  capture: EvidenceCapture;
  /** Exact immutable source bytes; their SHA-256 must equal document.sha256. */
  bytes: Uint8Array;
  /** Content-addressed parse/OCR artifact whose JSON pages close claim locators. */
  locatorArtifactRef: `sha256:${string}`;
  locatorArtifactBytes: Uint8Array;
}

/**
 * Production authority seam. Implementations resolve the exact plan component,
 * immutable FactSnapshot, EvidenceClaim/Document/Capture closure and source
 * bytes from the supplied active root. No raw caller manifest, anchor, hash or
 * evidence closure crosses this seam.
 */
export interface RootBoundProvisionalCaseAdapterAuthority {
  readonly authorityKind: typeof GENERATION_AUTHORITY_KIND;
  resolveProvisionalCaseAdapterContextAtRoot(
    activeRoot: string,
    request: ResolveProvisionalCaseAdapterContextRequest,
  ): Promise<ResolvedProvisionalCaseAdapterContext>;
}

interface RuntimeStateView {
  runtimeGeneration: number;
  revision: number;
}

interface RuntimeOperationContext {
  state: RuntimeStateView;
  activeRoot: string;
}

function candidateMaterial(candidate: Omit<ProvisionalCaseAdapterCandidate, "candidateId" | "contentHash">): unknown {
  return { domain: CANDIDATE_HASH_DOMAIN, candidate };
}

function candidateContentHash(candidate: Omit<ProvisionalCaseAdapterCandidate, "candidateId" | "contentHash">): string {
  return agentAuditHash(candidateMaterial(candidate));
}

function exactIdentity(value: unknown): value is CaseAdapterIdentity {
  const identity = safeRecord(value);
  return Boolean(identity
    && hasExactKeys(identity, ["skuId", "region", "revision", "identityFactIds"])
    && isPortableId(identity.skuId) && isPortableId(identity.region) && isPortableId(identity.revision)
    && Array.isArray(identity.identityFactIds) && identity.identityFactIds.length > 0
    && identity.identityFactIds.every(isPortableId)
    && new Set(identity.identityFactIds).size === identity.identityFactIds.length);
}

function exactCatalogIdentity(value: unknown, identity: CaseAdapterIdentity): value is EvidencePipelineSubject {
  const subject = safeRecord(value);
  return Boolean(subject
    && hasExactKeys(subject, ["brand", "category", "skuId", "familyId", "modelId", "variantId", "revision", "region"])
    && typeof subject.brand === "string" && subject.brand.length > 0 && subject.brand === subject.brand.normalize("NFC")
    && subject.category === "case"
    && [subject.skuId, subject.familyId, subject.modelId, subject.variantId, subject.revision, subject.region].every(isPortableId)
    && subject.skuId === identity.skuId && subject.revision === identity.revision && subject.region === identity.region);
}

function exactRegistryGuard(value: unknown): value is ProvisionalCaseAdapterRegistryGuard {
  const guard = safeRecord(value);
  if (!guard || !hasExactKeys(guard, ["expectedPriorRegistrationHash", "expectedPriorRegistryRef"])) return false;
  return (guard.expectedPriorRegistrationHash === null || isSha256(guard.expectedPriorRegistrationHash))
    && (guard.expectedPriorRegistryRef === null
      ? guard.expectedPriorRegistrationHash === null
      : typeof guard.expectedPriorRegistryRef === "string" && /^sha256:[a-f0-9]{64}$/u.test(guard.expectedPriorRegistryRef));
}

function sameProductIdentity(fact: FactRecord, identity: CaseAdapterIdentity): boolean {
  return fact.subject.kind === "product"
    && fact.subject.skuId === identity.skuId
    && fact.subject.region === identity.region
    && fact.subject.revision === identity.revision
    && fact.scope === "revision";
}

function claimClosesFact(claim: EvidenceClaim, fact: FactRecord): boolean {
  return fact.subject.kind === "product"
    && claim.scope === "revision"
    && claim.subject.skuId === fact.subject.skuId
    && claim.subject.region === fact.subject.region
    && claim.subject.revision === fact.subject.revision
    && claim.fieldId === fact.field
    && canonicalize(claim.value) === canonicalize(fact.value)
    && claim.unit === fact.unit
    && claim.authority === fact.authority
    && Date.parse(claim.retrievedAt) <= Date.parse(fact.retrievedAt);
}

function claimMatchesCatalogIdentity(claim: EvidenceClaim, identity: EvidencePipelineSubject): boolean {
  return claim.subject.skuId === identity.skuId
    && claim.subject.familyId === identity.familyId
    && claim.subject.modelId === identity.modelId
    && claim.subject.variantId === identity.variantId
    && claim.subject.revision === identity.revision
    && claim.subject.region === identity.region;
}

interface LocatorArtifactPage {
  page: number;
  text: string;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function provisionalCaseAdapterPlanAuthorityArtifact(
  planContext: ProvisionalCaseAdapterPlanContext,
  planComponent: ComponentInstance,
  catalogIdentity: EvidencePipelineSubject,
  identity: CaseAdapterIdentity,
): { artifactRef: `sha256:${string}`; artifactBytes: Uint8Array } {
  const material: ProvisionalCaseAdapterPlanAuthorityArtifact = {
    schemaVersion: "provisional-case-adapter-plan-authority-v1",
    planContext: structuredClone(planContext),
    planComponent: structuredClone(planComponent),
    catalogIdentity: structuredClone(catalogIdentity),
    identity: structuredClone(identity),
  };
  const artifactBytes = Buffer.from(stableAgentJson(material), "utf8");
  return Object.freeze({ artifactRef: `sha256:${sha256Bytes(artifactBytes)}` as const, artifactBytes });
}

function assertPlanAuthorityArtifact(context: ResolvedProvisionalCaseAdapterContext): void {
  const authority = safeRecord(context.planAuthority);
  if (!authority || !hasExactKeys(authority, ["artifactRef", "artifactBytes"])
    || typeof authority.artifactRef !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(authority.artifactRef)
    || !(authority.artifactBytes instanceof Uint8Array)
    || authority.artifactRef !== `sha256:${sha256Bytes(authority.artifactBytes)}`) {
    throw new TypeError("resolved provisional adapter immutable plan authority is invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(authority.artifactBytes).toString("utf8")); }
  catch { throw new TypeError("resolved provisional adapter plan authority JSON is invalid"); }
  const material = safeRecord(parsed);
  if (!material || !hasExactKeys(material, ["schemaVersion", "planContext", "planComponent", "catalogIdentity", "identity"])
    || material.schemaVersion !== "provisional-case-adapter-plan-authority-v1"
    || canonicalize(material.planContext) !== canonicalize(context.planContext)
    || canonicalize(material.planComponent) !== canonicalize(context.planComponent)
    || canonicalize(material.catalogIdentity) !== canonicalize(context.catalogIdentity)
    || canonicalize(material.identity) !== canonicalize(context.identity)
    || stableAgentJson(material) !== Buffer.from(authority.artifactBytes).toString("utf8")) {
    throw new TypeError("resolved provisional adapter plan authority projection is mismatched or non-canonical");
  }
}

function exactPlanComponent(value: unknown, context: ResolvedProvisionalCaseAdapterContext): value is ComponentInstance {
  const component = safeRecord(value);
  const componentIdentity = safeRecord(component?.identity);
  return Boolean(component && hasExactKeys(component, ["instanceId", "kind", "role", "state", "identity", "source"])
    && component.instanceId === context.planContext.caseComponentInstanceId
    && component.kind === "case" && isPortableId(component.role)
    && (component.state === "planned" || component.state === "ordered")
    && (component.source === "user" || component.source === "agent" || component.source === "migration")
    && componentIdentity && hasExactKeys(componentIdentity, ["status", "skuId", "identityClaimIds"])
    && componentIdentity.status === "resolved" && componentIdentity.skuId === context.catalogIdentity.skuId
    && Array.isArray(componentIdentity.identityClaimIds) && componentIdentity.identityClaimIds.length > 0
    && componentIdentity.identityClaimIds.every(isPortableId)
    && new Set(componentIdentity.identityClaimIds).size === componentIdentity.identityClaimIds.length);
}

function parseLocatorArtifact(
  source: CaseAdapterEvidenceSourceClosure,
): { documentId: string; documentSha256: string; sourceByteLength: number; pages: LocatorArtifactPage[] } {
  if (!(source.locatorArtifactBytes instanceof Uint8Array) || source.locatorArtifactBytes.byteLength < 1
    || source.locatorArtifactBytes.byteLength > 4 * 1024 * 1024
    || source.locatorArtifactRef !== `sha256:${sha256Bytes(source.locatorArtifactBytes)}`) {
    throw new TypeError("provisional adapter locator artifact bytes/ref are invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(source.locatorArtifactBytes).toString("utf8")); }
  catch { throw new TypeError("provisional adapter locator artifact JSON is invalid"); }
  const artifact = safeRecord(parsed);
  if (!artifact || !hasExactKeys(artifact, ["schemaVersion", "documentId", "documentSha256", "sourceByteLength", "pages"])
    || artifact.schemaVersion !== "case-adapter-locator-artifact-v1"
    || artifact.documentId !== source.document.id || artifact.documentSha256 !== source.document.sha256
    || artifact.sourceByteLength !== source.document.byteLength || !Array.isArray(artifact.pages)
    || artifact.pages.length < 1 || artifact.pages.length > 2_048) {
    throw new TypeError("provisional adapter locator artifact source binding is invalid");
  }
  const pages: LocatorArtifactPage[] = [];
  for (const candidate of artifact.pages) {
    const page = safeRecord(candidate);
    if (!page || !hasExactKeys(page, ["page", "text"]) || !Number.isSafeInteger(page.page) || Number(page.page) < 1
      || typeof page.text !== "string" || page.text.length < 1 || page.text !== page.text.normalize("NFC")
      || Buffer.byteLength(page.text, "utf8") > 256 * 1024) {
      throw new TypeError("provisional adapter locator artifact page is invalid");
    }
    pages.push({ page: Number(page.page), text: page.text });
  }
  if (new Set(pages.map((page) => page.page)).size !== pages.length) throw new TypeError("provisional adapter locator artifact pages are duplicated");
  return {
    documentId: artifact.documentId as string,
    documentSha256: artifact.documentSha256 as string,
    sourceByteLength: Number(artifact.sourceByteLength),
    pages,
  };
}

async function assertEvidenceSourceClosure(
  sources: readonly CaseAdapterEvidenceSourceClosure[],
  claims: readonly EvidenceClaim[],
  catalogIdentity: EvidencePipelineSubject,
): Promise<void> {
  if (!Array.isArray(sources) || sources.length < 1) throw new TypeError("provisional adapter evidence source closure is missing");
  const byCapture = new Map<string, { source: CaseAdapterEvidenceSourceClosure; pages: LocatorArtifactPage[] }>();
  for (const source of sources) {
    const record = safeRecord(source);
    if (!record || !hasExactKeys(record, ["document", "capture", "bytes", "locatorArtifactRef", "locatorArtifactBytes"])) {
      throw new TypeError("provisional adapter evidence source closure shape invalid");
    }
    if (validateEvidenceDocumentRuntime(source.document).length || validateEvidenceCaptureRuntime(source.capture).length) {
      throw new TypeError("provisional adapter EvidenceDocument/Capture metadata is invalid");
    }
    if (!(source.bytes instanceof Uint8Array) || source.bytes.byteLength !== source.document.byteLength
      || sha256Bytes(source.bytes) !== source.document.sha256 || source.document.id !== `doc-sha256-${source.document.sha256}`
      || source.capture.documentId !== source.document.id) {
      throw new TypeError("provisional adapter EvidenceDocument immutable bytes closure is invalid");
    }
    if (byCapture.has(source.capture.id)) throw new TypeError("provisional adapter evidence source closure contains duplicate captures");
    const locator = parseLocatorArtifact(source);
    byCapture.set(source.capture.id, { source, pages: locator.pages });
  }

  const referencedCaptures = new Set<string>();
  for (const claim of claims) {
    if (!claimMatchesCatalogIdentity(claim, catalogIdentity)) {
      throw new TypeError("provisional adapter claim crosses exact family/model/variant/revision identity");
    }
    const closed = byCapture.get(claim.source.captureId);
    if (!closed || closed.source.document.id !== claim.source.documentId
      || closed.source.document.sha256 !== claim.source.documentSha256
      || closed.source.capture.documentId !== claim.source.documentId
      || Date.parse(closed.source.capture.retrievedAt) > Date.parse(claim.retrievedAt)) {
      throw new TypeError("provisional adapter claim has dangling document/capture authority");
    }
    const expectedBasis = claim.authority === "official" ? "official-document-explicit" : "third-party-document-explicit";
    const matchingCaptureIdentity = closed.source.capture.productIdentities.some((candidate) => candidate.basis === expectedBasis
      && evidenceIdentityMatchesClaimSubjectRuntime(candidate, claim.subject, claim.scope));
    if (!matchingCaptureIdentity) throw new TypeError("provisional adapter capture does not establish the claim's exact catalog identity");
    const snippet = claim.source.locator.snippet;
    if (typeof snippet !== "string" || !snippet.length) throw new TypeError("provisional adapter claim locator requires a bounded source snippet");
    const pages = claim.source.locator.page === undefined
      ? closed.pages : closed.pages.filter((page) => page.page === claim.source.locator.page);
    if (!pages.some((page) => page.text.includes(snippet))) {
      throw new TypeError("provisional adapter claim locator does not resolve in its content-addressed source extraction");
    }
    referencedCaptures.add(claim.source.captureId);
  }
  if (referencedCaptures.size !== byCapture.size || [...byCapture.keys()].some((captureId) => !referencedCaptures.has(captureId))) {
    throw new TypeError("provisional adapter evidence source closure contains unreferenced documents/captures/bytes");
  }
}

async function assertGovernedFactClosure(
  closure: CaseAdapterFactClosure,
  identity: CaseAdapterIdentity,
  catalogIdentity: EvidencePipelineSubject,
  evidenceSources: readonly CaseAdapterEvidenceSourceClosure[],
): Promise<Map<string, FactRecord>> {
  const record = safeRecord(closure);
  if (!record || !hasExactKeys(record, ["snapshot", "facts", "conflicts", "evidenceClaims"])) {
    throw new TypeError("provisional adapter fact closure shape invalid");
  }
  if (!await verifyFactSnapshot(closure.snapshot)) throw new TypeError("provisional adapter FactSnapshot hash invalid");
  if (!Array.isArray(closure.facts) || !Array.isArray(closure.conflicts) || !Array.isArray(closure.evidenceClaims)) {
    throw new TypeError("provisional adapter fact closure arrays invalid");
  }
  if (closure.facts.length !== closure.snapshot.factRefs.length
    || closure.conflicts.length !== closure.snapshot.conflictRefs.length) {
    throw new TypeError("provisional adapter fact closure is not exact");
  }

  const facts = new Map<string, FactRecord>();
  for (const fact of closure.facts) {
    if (!await verifyFactRecord(fact)) throw new TypeError("provisional adapter fact content hash invalid");
    if (facts.has(fact.factId)) throw new TypeError("provisional adapter fact closure contains duplicate facts");
    if (!sameProductIdentity(fact, identity) || fact.status !== "active"
      || (fact.authority !== "official" && fact.authority !== "third_party")) {
      throw new TypeError("provisional adapter facts must be active exact-identity official/third-party facts");
    }
    facts.set(fact.factId, fact);
  }
  for (const ref of closure.snapshot.factRefs) {
    if (facts.get(ref.factId)?.contentHash !== ref.contentHash) throw new TypeError("provisional adapter FactSnapshot has a dangling fact ref");
  }

  const openConflictFacts = new Set<string>();
  const conflicts = new Map<string, string>();
  for (const conflict of closure.conflicts) {
    if (!await verifyConflictSet(conflict)) throw new TypeError("provisional adapter conflict hash invalid");
    if (conflicts.has(conflict.conflictSetId)) throw new TypeError("provisional adapter conflict closure contains duplicates");
    conflicts.set(conflict.conflictSetId, conflict.contentHash);
    if (conflict.status === "open") conflict.factIds.forEach((factId) => openConflictFacts.add(factId));
  }
  for (const ref of closure.snapshot.conflictRefs) {
    if (conflicts.get(ref.conflictSetId) !== ref.contentHash) throw new TypeError("provisional adapter FactSnapshot has a dangling conflict ref");
  }
  if ([...facts.keys()].some((factId) => openConflictFacts.has(factId))) {
    throw new TypeError("provisional adapter source facts contain an unresolved conflict");
  }

  const claims = new Map<string, EvidenceClaim>();
  for (const claim of closure.evidenceClaims) {
    if (!await verifyEvidenceClaim(claim) || claim.status !== "active") {
      throw new TypeError("provisional adapter EvidenceClaim closure is invalid or inactive");
    }
    if (claims.has(claim.claimId)) throw new TypeError("provisional adapter EvidenceClaim closure contains duplicates");
    claims.set(claim.claimId, claim);
  }
  await assertEvidenceSourceClosure(evidenceSources, closure.evidenceClaims, catalogIdentity);
  const referencedClaims = new Set<string>();
  for (const fact of facts.values()) {
    if (fact.evidenceRefs.length === 0) throw new TypeError("provisional adapter source fact lacks evidence authority");
    for (const claimId of fact.evidenceRefs) {
      const claim = claims.get(claimId);
      if (!claim || !claimClosesFact(claim, fact)) throw new TypeError("provisional adapter EvidenceClaim does not close its exact fact");
      referencedClaims.add(claimId);
    }
  }
  if (referencedClaims.size !== claims.size || [...claims.keys()].some((claimId) => !referencedClaims.has(claimId))) {
    throw new TypeError("provisional adapter EvidenceClaim closure contains unreferenced authority");
  }

  const identityFacts = identity.identityFactIds.map((factId) => facts.get(factId));
  if (identityFacts.some((fact) => !fact)
    || !identityFacts.some((fact) => fact?.field === "identity.revision" && fact.value === identity.revision)) {
    throw new TypeError("provisional adapter exact revision identity is not closed by governed facts");
  }
  return facts;
}

function oneFactByField(facts: ReadonlyMap<string, FactRecord>, field: string): FactRecord | null {
  const matches = [...facts.values()].filter((fact) => fact.field === field);
  if (matches.length > 1) throw new TypeError(`provisional adapter field ${field} is ambiguous in the exact snapshot`);
  return matches[0] ?? null;
}

function positiveMillimetres(fact: FactRecord | null): number | null {
  return fact && fact.unit === "mm" && typeof fact.value === "number" && Number.isFinite(fact.value) && fact.value > 20
    ? fact.value : null;
}

function portableArray(fact: FactRecord | null): string[] | null {
  return fact && Array.isArray(fact.value) && fact.value.length > 0
    && fact.value.every(isPortableId) && new Set(fact.value).size === fact.value.length
    ? [...fact.value] as string[] : null;
}

function provisionalBinding(sourceFactIds: string[], derivationId: string, uncertaintyMm: number): CaseManifestBinding {
  if (!(Number.isFinite(uncertaintyMm) && uncertaintyMm > 0)) throw new TypeError("inferred adapter anchors require positive uncertainty");
  return { status: "provisional", sourceFactIds: [...sourceFactIds].sort(compareCanonical), derivationIds: [derivationId], uncertaintyMm };
}

function dimensionEnvelopeBinding(facts: FactRecord[]): CaseManifestBinding {
  return facts.every((fact) => fact.authority === "official")
    ? { status: "verified", sourceFactIds: facts.map((fact) => fact.factId).sort(compareCanonical), derivationIds: [], uncertaintyMm: 0 }
    : provisionalBinding(facts.map((fact) => fact.factId), "derive.generic.envelope-from-third-party-dimensions-v1", 5);
}

function formFactorStandard(formFactor: string): string | null {
  const normalized = formFactor.toLowerCase();
  if (normalized === "atx") return "mount.motherboard.atx";
  if (normalized === "micro-atx" || normalized === "matx") return "mount.motherboard.micro-atx";
  if (normalized === "mini-itx" || normalized === "itx") return "mount.motherboard.mini-itx";
  return null;
}

interface PortTopologyValue {
  endpointId: string;
  connectorType: string;
  quantity: number;
}

function portTopology(fact: FactRecord | null): PortTopologyValue | null {
  const candidates = fact ? (Array.isArray(fact.value) ? fact.value : [fact.value]) : [];
  for (const candidate of candidates) {
    const value = safeRecord(candidate);
    if (value && isPortableId(value.endpointId) && isPortableId(value.connectorType)
      && Number.isSafeInteger(value.quantity) && Number(value.quantity) > 0 && Number(value.quantity) <= 4096) {
      return { endpointId: value.endpointId, connectorType: value.connectorType, quantity: Number(value.quantity) };
    }
  }
  return null;
}

function missingAction(fieldId: string): ProvisionalCaseAdapterNextEvidenceAction {
  if (["physical.width", "physical.height", "physical.depth"].includes(fieldId)) {
    return { fieldId, preferredAuthority: "official", action: "acquire_dimensioned_drawing", reason: "exact case envelope dimension is required for spatial closure" };
  }
  if (fieldId === "io.port_topology") {
    return { fieldId, preferredAuthority: "official", action: "acquire_port_or_routing_view", reason: "a documented connector and route endpoint are required for routing closure" };
  }
  return { fieldId, preferredAuthority: "official", action: "acquire_product_page_or_manual", reason: "an exact revision installation fact is required for mount closure" };
}

const ALLOWED_MISSING_FIELDS = new Set([
  "physical.width", "physical.height", "physical.depth", "mount.point_ids", "case.motherboard_form_factors", "io.port_topology",
]);

function domainResults(missingFields: readonly string[]): ProvisionalCaseAdapterCandidate["domains"] {
  const geometryMissing = missingFields.filter((field) => field !== "io.port_topology");
  return {
    electronics: { status: "ready", reason: "exact governed capability facts remain usable independently of spatial evidence" },
    geometry: geometryMissing.length
      ? { status: "blocked", reason: `missing exact spatial fields: ${geometryMissing.join(", ")}` }
      : { status: "blocked", reason: "provisional manifest lacks a reviewed full CaseRuntimeModel spatial authority" },
    routing: missingFields.length
      ? { status: "blocked", reason: `missing exact route fields: ${missingFields.join(", ")}` }
      : { status: "blocked", reason: "provisional manifest lacks a reviewed full CaseRuntimeModel routing authority" },
    assembly: { status: "blocked", reason: "provisional manifest lacks a reviewed full CaseRuntimeModel assembly authority" },
  };
}

async function buildManifest(
  identity: CaseAdapterIdentity,
  closure: CaseAdapterFactClosure,
  facts: ReadonlyMap<string, FactRecord>,
  additionalSourceRefs: readonly string[],
): Promise<{ manifest: CaseAdapterManifest | null; missingFields: string[]; domains: ProvisionalCaseAdapterCandidate["domains"] }> {
  const widthFact = oneFactByField(facts, "physical.width");
  const heightFact = oneFactByField(facts, "physical.height");
  const depthFact = oneFactByField(facts, "physical.depth");
  const mountFact = oneFactByField(facts, "mount.point_ids");
  const formFactorFact = oneFactByField(facts, "case.motherboard_form_factors");
  const portFact = oneFactByField(facts, "io.port_topology");
  const width = positiveMillimetres(widthFact);
  const height = positiveMillimetres(heightFact);
  const depth = positiveMillimetres(depthFact);
  const mountIds = portableArray(mountFact);
  const formFactors = portableArray(formFactorFact);
  const standard = formFactors?.map(formFactorStandard).find((value): value is string => value !== null) ?? null;
  const topology = portTopology(portFact);

  const missingFields = [
    ...(!width ? ["physical.width"] : []),
    ...(!height ? ["physical.height"] : []),
    ...(!depth ? ["physical.depth"] : []),
    ...(!mountIds ? ["mount.point_ids"] : []),
    ...(!standard ? ["case.motherboard_form_factors"] : []),
    ...(!topology ? ["io.port_topology"] : []),
  ].sort(compareCanonical);
  const domains = domainResults(missingFields);
  if (missingFields.length || !widthFact || !heightFact || !depthFact || !mountFact || !formFactorFact || !portFact
    || !width || !height || !depth || !mountIds || !standard || !topology) {
    return { manifest: null, missingFields, domains };
  }

  const dimensionFacts = [widthFact, heightFact, depthFact];
  const dimensionFactIds = dimensionFacts.map((fact) => fact.factId);
  const size = [width, height, depth] as Vec3Mm;
  const interiorSize = [width - 10, height - 10, depth - 10] as Vec3Mm;
  const routingSize = [width - 20, height - 20, depth - 20] as Vec3Mm;
  const boardMountId = mountIds.find((id) => /(?:board|motherboard)/iu.test(id)) ?? "mount.board.primary";
  const capabilityBindings = [...facts.values()]
    .filter((fact) => Object.prototype.hasOwnProperty.call(CAPABILITY_FACET_REGISTRY, fact.field))
    .map((fact) => ({ facetId: fact.field as keyof typeof CAPABILITY_FACET_REGISTRY, sourceFactIds: [fact.factId] }))
    .sort((left, right) => compareCanonical(left.facetId, right.facetId));
  const sourceRefs = [...new Set([...closure.evidenceClaims.flatMap((claim) => [claim.source.documentId, claim.source.captureId]), ...additionalSourceRefs])]
    .sort(compareCanonical);

  const manifest = await createCaseAdapterManifest({
    schemaVersion: "case-adapter-manifest-v1",
    adapterId: `adapter.provisional.${identity.skuId}`,
    adapterVersion: "provisional-v1",
    identity: structuredClone(identity),
    capabilityBindings,
    geometry: {
      envelope: { nodeId: "case.envelope", centerMm: [0, 0, 0], sizeMm: size, binding: dimensionEnvelopeBinding(dimensionFacts) },
      interiorSpaces: [{
        nodeId: "case.interior.primary", centerMm: [0, 0, 0], sizeMm: interiorSize,
        binding: provisionalBinding(dimensionFactIds, "derive.generic.interior-from-envelope-v1", 5),
      }],
      forbiddenZones: [],
      serviceCorridors: [],
    },
    mounts: [{
      mountId: boardMountId,
      kind: "motherboard",
      standardIds: [standard],
      quantity: 1,
      location: "main",
      binding: provisionalBinding([mountFact.factId, formFactorFact.factId], "derive.generic.primary-board-mount-v1", 2),
    }],
    ports: [{
      portId: topology.endpointId,
      connectorStandardId: topology.connectorType,
      direction: "bidirectional",
      quantity: topology.quantity,
      anchorMm: [0, height / 2 - 10, -depth / 2 + 10],
      binding: provisionalBinding([portFact.factId, ...dimensionFactIds], "derive.generic.port-anchor-from-documented-topology-v1", 10),
    }],
    routingZones: [{
      zoneId: "route.primary",
      kind: "free",
      centerMm: [0, 0, 0],
      sizeMm: routingSize,
      connectsToZoneIds: [],
      binding: provisionalBinding([portFact.factId, ...dimensionFactIds], "derive.generic.primary-route-volume-v1", 10),
    }],
    assemblyConstraints: [],
    bundleItems: [],
    resourcePatterns: [],
    sourceRefs,
  });
  return { manifest, missingFields, domains };
}

export async function assertResolvedProvisionalCaseAdapterContext(
  context: ResolvedProvisionalCaseAdapterContext,
  request: GenerateProvisionalCaseAdapterRequest,
): Promise<Map<string, FactRecord>> {
  const value = safeRecord(context);
  if (!value || !hasExactKeys(value, ["schemaVersion", "planContext", "planComponent", "planAuthority", "registryGuard", "generationJob", "catalogIdentity", "identity", "factClosure", "evidenceSources"])
    || value.schemaVersion !== "resolved-provisional-case-adapter-context-v1") {
    throw new TypeError("resolved provisional adapter context shape invalid");
  }
  const plan = safeRecord(context.planContext);
  if (!plan || !hasExactKeys(plan, ["planId", "caseComponentInstanceId", "planRevision", "configHash"])
    || plan.planId !== request.planId || plan.caseComponentInstanceId !== request.caseComponentInstanceId
    || !Number.isSafeInteger(plan.planRevision) || Number(plan.planRevision) < 0 || !isSha256(plan.configHash)) {
    throw new TypeError("resolved provisional adapter plan context is invalid or mismatched");
  }
  if (!exactIdentity(context.identity)) throw new TypeError("resolved provisional adapter exact identity invalid");
  if (!exactCatalogIdentity(context.catalogIdentity, context.identity)) throw new TypeError("resolved provisional adapter full catalog identity invalid");
  if (!exactPlanComponent(context.planComponent, context)) throw new TypeError("resolved provisional adapter exact plan component projection invalid");
  if (!exactRegistryGuard(context.registryGuard)) throw new TypeError("resolved provisional adapter registry CAS guard invalid");
  assertPlanAuthorityArtifact(context);
  const generationJob = safeRecord(context.generationJob);
  if (!generationJob || !hasExactKeys(generationJob, ["jobId", "resultRef", "attemptStartedAt"])
    || typeof generationJob.jobId !== "string" || !/^job-[a-f0-9]{64}$/u.test(generationJob.jobId)
    || typeof generationJob.resultRef !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(generationJob.resultRef)
    || typeof generationJob.attemptStartedAt !== "string" || new Date(generationJob.attemptStartedAt).toISOString() !== generationJob.attemptStartedAt) {
    throw new TypeError("resolved provisional adapter generation job authority is invalid");
  }
  return assertGovernedFactClosure(context.factClosure, context.identity, context.catalogIdentity, context.evidenceSources);
}

function assertGenerateRequest(value: unknown): asserts value is GenerateProvisionalCaseAdapterRequest {
  const request = safeRecord(value);
  if (!request || !hasExactKeys(request, ["planId", "caseComponentInstanceId", "expectedRuntimeGeneration", "expectedRuntimeRevision"])
    || !isPortableId(request.planId) || !isPortableId(request.caseComponentInstanceId)
    || !Number.isSafeInteger(request.expectedRuntimeGeneration) || Number(request.expectedRuntimeGeneration) <= 0
    || !Number.isSafeInteger(request.expectedRuntimeRevision) || Number(request.expectedRuntimeRevision) < 0) {
    throw new TypeError("provisional adapter generation request must contain only exact plan lookup and runtime fence fields");
  }
}

export function validateProvisionalCaseAdapterCandidate(value: unknown): string[] {
  try {
    const candidate = safeRecord(value);
    if (!candidate || !hasExactKeys(candidate, [
      "schemaVersion", "candidateId", "status", "runtimeGeneration", "planContext", "registryGuard", "authorityRefs", "catalogIdentity",
      "identity", "factSnapshotRef", "sourceAuthorities", "domains", "missingFields", "nextEvidenceActions",
      "manifest", "createdAt", "contentHash",
    ])) return ["provisional case adapter candidate shape invalid"];
    const errors: string[] = [];
    if (candidate.schemaVersion !== "provisional-case-adapter-candidate-v1") errors.push("candidate schemaVersion invalid");
    if (typeof candidate.candidateId !== "string" || !CANDIDATE_ID.test(candidate.candidateId)) errors.push("candidate ID invalid");
    if (!isSha256(candidate.contentHash) || (typeof candidate.candidateId === "string" && CANDIDATE_ID.exec(candidate.candidateId)?.[1] !== candidate.contentHash)) errors.push("candidate content identity mismatch");
    if (!Number.isSafeInteger(candidate.runtimeGeneration) || Number(candidate.runtimeGeneration) <= 0) errors.push("candidate runtime fence invalid");
    const plan = safeRecord(candidate.planContext);
    if (!plan || !hasExactKeys(plan, ["planId", "caseComponentInstanceId", "planRevision", "configHash"])
      || !isPortableId(plan.planId) || !isPortableId(plan.caseComponentInstanceId)
      || !Number.isSafeInteger(plan.planRevision) || Number(plan.planRevision) < 0 || !isSha256(plan.configHash)) errors.push("candidate plan context invalid");
    if (!exactRegistryGuard(candidate.registryGuard)) errors.push("candidate registry CAS guard invalid");
    const identityValid = exactIdentity(candidate.identity);
    if (!identityValid) errors.push("candidate exact identity invalid");
    if (!identityValid || !exactCatalogIdentity(candidate.catalogIdentity, candidate.identity as unknown as CaseAdapterIdentity)) errors.push("candidate full catalog identity invalid");
    const authorityRefs = safeRecord(candidate.authorityRefs);
    if (!authorityRefs || !hasExactKeys(authorityRefs, ["generationJobId", "generationJobResultRef", "planContextArtifactRef", "evidenceClaimIds", "evidenceDocumentIds", "evidenceCaptureIds", "evidenceLocatorArtifactRefs"])
      || typeof authorityRefs.generationJobId !== "string" || !/^job-[a-f0-9]{64}$/u.test(authorityRefs.generationJobId)
      || typeof authorityRefs.generationJobResultRef !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(authorityRefs.generationJobResultRef)
      || typeof authorityRefs.planContextArtifactRef !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(authorityRefs.planContextArtifactRef)
      || !Array.isArray(authorityRefs.evidenceClaimIds) || authorityRefs.evidenceClaimIds.length < 1
      || authorityRefs.evidenceClaimIds.some((ref) => typeof ref !== "string" || !/^claim-sha256-[a-f0-9]{64}$/u.test(ref))
      || !Array.isArray(authorityRefs.evidenceDocumentIds) || authorityRefs.evidenceDocumentIds.length < 1
      || authorityRefs.evidenceDocumentIds.some((ref) => typeof ref !== "string" || !/^doc-sha256-[a-f0-9]{64}$/u.test(ref))
      || !Array.isArray(authorityRefs.evidenceCaptureIds) || authorityRefs.evidenceCaptureIds.length < 1
      || authorityRefs.evidenceCaptureIds.some((ref) => typeof ref !== "string" || !/^capture-sha256-[a-f0-9]{64}$/u.test(ref))
      || !Array.isArray(authorityRefs.evidenceLocatorArtifactRefs) || authorityRefs.evidenceLocatorArtifactRefs.length < 1
      || authorityRefs.evidenceLocatorArtifactRefs.some((ref) => typeof ref !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(ref))
      || [authorityRefs.evidenceClaimIds, authorityRefs.evidenceDocumentIds, authorityRefs.evidenceCaptureIds, authorityRefs.evidenceLocatorArtifactRefs]
        .some((refs) => new Set(refs).size !== refs.length || canonicalize(refs) !== canonicalize([...refs].sort(compareCanonical)))) {
      errors.push("candidate job/evidence authority refs invalid");
    }
    const snapshot = safeRecord(candidate.factSnapshotRef);
    if (!snapshot || !hasExactKeys(snapshot, ["snapshotId", "contentHash"])
      || !isPortableId(snapshot.snapshotId) || !isSha256(snapshot.contentHash)) errors.push("candidate FactSnapshot ref invalid");
    if (!Array.isArray(candidate.sourceAuthorities) || candidate.sourceAuthorities.length === 0
      || candidate.sourceAuthorities.some((authority) => authority !== "official" && authority !== "third_party")
      || new Set(candidate.sourceAuthorities).size !== candidate.sourceAuthorities.length
      || canonicalize(candidate.sourceAuthorities) !== canonicalize([...candidate.sourceAuthorities].sort(compareCanonical))) errors.push("candidate source authorities invalid");
    const domains = safeRecord(candidate.domains);
    if (!domains || !hasExactKeys(domains, ["electronics", "geometry", "routing", "assembly"])) errors.push("candidate domains invalid");
    else for (const domain of ["electronics", "geometry", "routing", "assembly"] as const) {
      const result = safeRecord(domains[domain]);
      if (!result || !hasExactKeys(result, ["status", "reason"])
        || (result.status !== "ready" && result.status !== "blocked") || typeof result.reason !== "string" || !result.reason) errors.push(`candidate ${domain} domain invalid`);
    }
    if (!Array.isArray(candidate.missingFields) || candidate.missingFields.some((field) => !isPortableId(field) || !ALLOWED_MISSING_FIELDS.has(field))
      || new Set(candidate.missingFields).size !== candidate.missingFields.length
      || canonicalize(candidate.missingFields) !== canonicalize([...candidate.missingFields].sort(compareCanonical))) errors.push("candidate missingFields invalid");
    const semanticMissing = Array.isArray(candidate.missingFields) ? candidate.missingFields as string[] : [];
    if (domains && canonicalize(domains) !== canonicalize(domainResults(semanticMissing))) errors.push("candidate domains do not match missing evidence semantics");
    if (!Array.isArray(candidate.nextEvidenceActions)
      || candidate.nextEvidenceActions.some((action) => {
        const item = safeRecord(action);
        return !item || !hasExactKeys(item, ["fieldId", "preferredAuthority", "action", "reason"])
          || !isPortableId(item.fieldId) || !ALLOWED_MISSING_FIELDS.has(item.fieldId)
          || item.preferredAuthority !== "official"
          || !["acquire_product_page_or_manual", "acquire_dimensioned_drawing", "acquire_port_or_routing_view"].includes(String(item.action))
          || typeof item.reason !== "string" || !item.reason;
      })
      || canonicalize(candidate.nextEvidenceActions) !== canonicalize(semanticMissing.map(missingAction))) errors.push("candidate nextEvidenceActions do not exactly match missing fields");
    if (candidate.status === "ready_for_review") {
      if (candidate.manifest === null || semanticMissing.length !== 0) errors.push("reviewable candidate must contain a complete manifest");
    } else if (candidate.status === "partial") {
      if (candidate.manifest !== null || semanticMissing.length === 0) errors.push("partial candidate must identify missing evidence without a manifest");
    } else errors.push("candidate status invalid");
    if (candidate.manifest !== null) {
      const manifest = safeRecord(candidate.manifest);
      const expectedSources = authorityRefs ? [...new Set([
        ...(Array.isArray(authorityRefs.evidenceDocumentIds) ? authorityRefs.evidenceDocumentIds : []),
        ...(Array.isArray(authorityRefs.evidenceCaptureIds) ? authorityRefs.evidenceCaptureIds : []),
        ...(Array.isArray(authorityRefs.evidenceLocatorArtifactRefs) ? authorityRefs.evidenceLocatorArtifactRefs : []),
      ])].sort(compareCanonical) : [];
      if (!manifest || !identityValid || canonicalize(manifest.identity) !== canonicalize(candidate.identity)
        || manifest.adapterId !== `adapter.provisional.${(candidate.identity as CaseAdapterIdentity).skuId}`
        || manifest.adapterVersion !== "provisional-v1" || canonicalize(manifest.sourceRefs) !== canonicalize(expectedSources)) {
        errors.push("candidate manifest identity/source authority semantics invalid");
      }
    }
    if (typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt))
      || new Date(candidate.createdAt).toISOString() !== candidate.createdAt) errors.push("candidate createdAt invalid");
    return errors;
  } catch {
    return ["provisional case adapter candidate is inaccessible or invalid"];
  }
}

export async function verifyProvisionalCaseAdapterCandidate(value: unknown): Promise<boolean> {
  if (validateProvisionalCaseAdapterCandidate(value).length) return false;
  const candidate = value as ProvisionalCaseAdapterCandidate;
  if (candidate.manifest && !await verifyCaseAdapterManifest(candidate.manifest)) return false;
  const { candidateId: _candidateId, contentHash: _contentHash, ...unsigned } = candidate;
  return candidate.contentHash === candidateContentHash(unsigned);
}

export function provisionalCaseAdapterCandidateArtifactRef(candidateId: string): `sha256:${string}` {
  if (!CANDIDATE_ID.test(candidateId)) throw new TypeError("provisional adapter candidate ID invalid");
  return `sha256:${CANDIDATE_ID.exec(candidateId)![1]}`;
}

export async function readProvisionalCaseAdapterCandidateAtRoot(
  activeRoot: string,
  candidateId: string,
): Promise<ProvisionalCaseAdapterCandidate | null> {
  const ref = provisionalCaseAdapterCandidateArtifactRef(candidateId);
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") });
  const stored = await artifacts.get(ref);
  if (!stored) return null;
  if (stored.record.kind !== "provisional-case-adapter-candidate"
    || stored.record.mediaType !== "application/vnd.buildsim.provisional-case-adapter+json"
    || stored.record.privacyClass !== "runtime_internal") throw new Error("stored provisional adapter candidate artifact metadata is invalid");
  let material: unknown;
  try { material = JSON.parse(stored.bytes.toString("utf8")); }
  catch { throw new Error("stored provisional adapter candidate artifact JSON is invalid"); }
  const record = safeRecord(material);
  if (!record || !hasExactKeys(record, ["domain", "candidate"]) || record.domain !== CANDIDATE_HASH_DOMAIN || !safeRecord(record.candidate)) {
    throw new Error("stored provisional adapter candidate artifact material is invalid");
  }
  const candidate = {
    ...(record.candidate as unknown as Omit<ProvisionalCaseAdapterCandidate, "candidateId" | "contentHash">),
    candidateId,
    contentHash: ref.slice("sha256:".length),
  } as ProvisionalCaseAdapterCandidate;
  if (!await verifyProvisionalCaseAdapterCandidate(candidate)) throw new Error("stored provisional adapter candidate is corrupt");
  const expectedReferences = [...new Set([
    candidate.authorityRefs.generationJobResultRef,
    candidate.authorityRefs.planContextArtifactRef,
    ...(candidate.registryGuard.expectedPriorRegistryRef ? [candidate.registryGuard.expectedPriorRegistryRef] : []),
    ...candidate.authorityRefs.evidenceLocatorArtifactRefs,
  ])].sort(compareCanonical).map((reference) => ({ ref: reference, necessity: "required_for_replay" }));
  if (canonicalize(stored.record.references) !== canonicalize(expectedReferences)) {
    throw new Error("stored provisional adapter candidate metadata authority refs are incomplete or forged");
  }
  await assertStoredPlanAuthorityAtRoot(activeRoot, candidate);
  return deepFreeze(structuredClone(candidate)) as ProvisionalCaseAdapterCandidate;
}

async function assertStoredPlanAuthorityAtRoot(
  activeRoot: string,
  candidate: ProvisionalCaseAdapterCandidate,
): Promise<void> {
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts") });
  const stored = await artifacts.get(candidate.authorityRefs.planContextArtifactRef);
  if (!stored || stored.record.kind !== "provisional-case-adapter-plan-authority"
    || stored.record.mediaType !== "application/vnd.buildsim.provisional-case-adapter-plan-authority+json"
    || stored.record.privacyClass !== "runtime_internal" || stored.record.references.length !== 0) {
    throw new Error("stored provisional adapter immutable plan authority is missing or mismatched");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stored.bytes.toString("utf8")); }
  catch { throw new Error("stored provisional adapter immutable plan authority JSON is invalid"); }
  const material = safeRecord(parsed);
  const planComponent = safeRecord(material?.planComponent);
  const componentIdentity = safeRecord(planComponent?.identity);
  if (!material || !hasExactKeys(material, ["schemaVersion", "planContext", "planComponent", "catalogIdentity", "identity"])
    || material.schemaVersion !== "provisional-case-adapter-plan-authority-v1"
    || canonicalize(material.planContext) !== canonicalize(candidate.planContext)
    || !planComponent || planComponent.instanceId !== candidate.planContext.caseComponentInstanceId
    || planComponent.kind !== "case" || componentIdentity?.status !== "resolved"
    || componentIdentity.skuId !== candidate.catalogIdentity.skuId
    || canonicalize(material.catalogIdentity) !== canonicalize(candidate.catalogIdentity)
    || canonicalize(material.identity) !== canonicalize(candidate.identity)
    || stableAgentJson(material) !== stored.bytes.toString("utf8")) {
    throw new Error("stored provisional adapter immutable plan authority projection is corrupt");
  }
}

async function storePlanAuthorityAtRoot(
  activeRoot: string,
  context: ResolvedProvisionalCaseAdapterContext,
): Promise<void> {
  assertPlanAuthorityArtifact(context);
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts"), now: () => context.generationJob.attemptStartedAt });
  const stored = await artifacts.put({
    bytes: context.planAuthority.artifactBytes,
    mediaType: "application/vnd.buildsim.provisional-case-adapter-plan-authority+json",
    privacyClass: "runtime_internal",
    kind: "provisional-case-adapter-plan-authority",
    references: [],
    createdAt: context.generationJob.attemptStartedAt,
  });
  if (stored.record.ref !== context.planAuthority.artifactRef) {
    throw new Error("provisional adapter immutable plan authority artifact/content identity mismatch");
  }
}

async function storeResolvedAuthorityClosureAtRoot(
  activeRoot: string,
  context: ResolvedProvisionalCaseAdapterContext,
): Promise<void> {
  // The root-bound authority may derive a case-only snapshot and bounded
  // locator artifacts from already governed repository records. Persist those
  // immutable projections in the same coordinator writer as the candidate so
  // production generation never depends on process-local closure bytes.
  const snapshot = context.factClosure.snapshot;
  if (!await verifyFactSnapshot(snapshot)) throw new TypeError("refusing to store an invalid provisional adapter FactSnapshot");
  const snapshotFile = confined(activeRoot, "facts", "snapshots", `${snapshot.snapshotId}.json`);
  let existing: unknown = null;
  try { existing = await readJson(snapshotFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const envelope = {
    schemaVersion: "fact-repository-envelope-v1" as const,
    kind: "snapshot" as const,
    checksum: sha256Json(snapshot),
    payload: snapshot,
  };
  if (existing === null) await atomicWriteJson(snapshotFile, envelope);
  else if (canonicalize(existing) !== canonicalize(envelope)) {
    throw new Error("provisional adapter FactSnapshot content identity collision");
  }

  const artifacts = new FileArtifactRepository({
    root: confined(activeRoot, "artifacts"),
    now: () => context.generationJob.attemptStartedAt,
  });
  for (const source of context.evidenceSources) {
    const stored = await artifacts.put({
      bytes: source.locatorArtifactBytes,
      mediaType: "application/vnd.buildsim.case-adapter-locator+json",
      privacyClass: "runtime_internal",
      kind: "case-adapter-evidence-locator",
      references: [],
      createdAt: context.generationJob.attemptStartedAt,
    });
    if (stored.record.ref !== source.locatorArtifactRef) {
      throw new Error("provisional adapter evidence locator artifact/content identity mismatch");
    }
  }
}

async function storeCandidateAtRoot(activeRoot: string, candidate: ProvisionalCaseAdapterCandidate): Promise<void> {
  if (!await verifyProvisionalCaseAdapterCandidate(candidate)) throw new TypeError("refusing to store an invalid provisional adapter candidate");
  const { candidateId: _candidateId, contentHash: _contentHash, ...unsigned } = candidate;
  const artifacts = new FileArtifactRepository({ root: confined(activeRoot, "artifacts"), now: () => candidate.createdAt });
  const references = [...new Set([
    candidate.authorityRefs.generationJobResultRef,
    candidate.authorityRefs.planContextArtifactRef,
    ...(candidate.registryGuard.expectedPriorRegistryRef ? [candidate.registryGuard.expectedPriorRegistryRef] : []),
    ...candidate.authorityRefs.evidenceLocatorArtifactRefs,
  ])].sort(compareCanonical).map((ref) => ({ ref, necessity: "required_for_replay" as const }));
  const stored = await artifacts.put({
    bytes: Buffer.from(stableAgentJson(candidateMaterial(unsigned)), "utf8"),
    mediaType: "application/vnd.buildsim.provisional-case-adapter+json",
    privacyClass: "runtime_internal",
    kind: "provisional-case-adapter-candidate",
    references,
    createdAt: candidate.createdAt,
  });
  if (stored.record.ref !== provisionalCaseAdapterCandidateArtifactRef(candidate.candidateId)) {
    throw new Error("provisional adapter candidate artifact/content identity mismatch");
  }
}

export async function replayProvisionalCaseAdapterCandidate(
  context: ResolvedProvisionalCaseAdapterContext,
  request: GenerateProvisionalCaseAdapterRequest,
  runtimeGeneration: number,
): Promise<ProvisionalCaseAdapterCandidate> {
  if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration <= 0
    || runtimeGeneration !== request.expectedRuntimeGeneration) throw new TypeError("provisional adapter replay runtime generation invalid");
  const facts = await assertResolvedProvisionalCaseAdapterContext(context, request);
  const locatorRefs = context.evidenceSources.map((source) => source.locatorArtifactRef).sort(compareCanonical);
  const generated = await buildManifest(context.identity, context.factClosure, facts, locatorRefs);
  const missingFields = [...generated.missingFields].sort(compareCanonical);
  const unsigned: Omit<ProvisionalCaseAdapterCandidate, "candidateId" | "contentHash"> = {
    schemaVersion: "provisional-case-adapter-candidate-v1",
    status: generated.manifest ? "ready_for_review" : "partial",
    runtimeGeneration,
    planContext: structuredClone(context.planContext),
    registryGuard: structuredClone(context.registryGuard),
    authorityRefs: {
      generationJobId: context.generationJob.jobId,
      generationJobResultRef: context.generationJob.resultRef,
      planContextArtifactRef: context.planAuthority.artifactRef,
      evidenceClaimIds: context.factClosure.evidenceClaims.map((claim) => claim.claimId).sort(compareCanonical),
      evidenceDocumentIds: [...new Set(context.factClosure.evidenceClaims.map((claim) => claim.source.documentId))].sort(compareCanonical),
      evidenceCaptureIds: [...new Set(context.factClosure.evidenceClaims.map((claim) => claim.source.captureId))].sort(compareCanonical),
      evidenceLocatorArtifactRefs: locatorRefs,
    },
    catalogIdentity: structuredClone(context.catalogIdentity),
    identity: structuredClone(context.identity),
    factSnapshotRef: {
      snapshotId: context.factClosure.snapshot.snapshotId,
      contentHash: context.factClosure.snapshot.contentHash,
    },
    sourceAuthorities: [...new Set(context.factClosure.facts.map((fact) => fact.authority as "official" | "third_party"))].sort(compareCanonical),
    domains: generated.domains,
    missingFields,
    nextEvidenceActions: missingFields.map(missingAction),
    manifest: generated.manifest,
    createdAt: context.generationJob.attemptStartedAt,
  };
  const contentHash = candidateContentHash(unsigned);
  const candidate: ProvisionalCaseAdapterCandidate = {
    ...unsigned,
    candidateId: `provisional-case-adapter-sha256-${contentHash}`,
    contentHash,
  };
  if (!await verifyProvisionalCaseAdapterCandidate(candidate)) throw new TypeError("generated provisional adapter candidate failed closure validation");
  return deepFreeze(candidate) as ProvisionalCaseAdapterCandidate;
}

export class ProvisionalCaseAdapterService {
  constructor(
    private readonly coordinator: RuntimeCoordinator,
    private readonly authority: RootBoundProvisionalCaseAdapterAuthority,
  ) {
    if (!authority || authority.authorityKind !== GENERATION_AUTHORITY_KIND
      || typeof authority.resolveProvisionalCaseAdapterContextAtRoot !== "function") {
      throw new TypeError("root-bound provisional adapter Fact/Evidence authority is required");
    }
  }

  async generate(value: unknown): Promise<ProvisionalCaseAdapterCandidate> {
    assertGenerateRequest(value);
    const request = structuredClone(value);
    const preflight = await this.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: RuntimeOperationContext) => {
      if (state.runtimeGeneration !== request.expectedRuntimeGeneration || state.revision !== request.expectedRuntimeRevision) {
        throw new Error("provisional adapter generation runtime fence is stale");
      }
      const context = await this.authority.resolveProvisionalCaseAdapterContextAtRoot(activeRoot, {
        planId: request.planId,
        caseComponentInstanceId: request.caseComponentInstanceId,
        runtimeGeneration: state.runtimeGeneration,
        runtimeRevision: state.revision,
      });
      const candidate = await replayProvisionalCaseAdapterCandidate(context, request, state.runtimeGeneration);
      const existing = await readProvisionalCaseAdapterCandidateAtRoot(activeRoot, candidate.candidateId);
      if (existing && canonicalize(existing) !== canonicalize(candidate)) throw new Error("provisional adapter candidate replay mismatch");
      return { candidate, alreadyStored: existing !== null };
    });
    if (preflight.result.alreadyStored) return preflight.result.candidate;

    const written = await this.coordinator.withWrite(async ({ state, activeRoot }: RuntimeOperationContext) => {
      if (state.runtimeGeneration !== request.expectedRuntimeGeneration || state.revision !== request.expectedRuntimeRevision) {
        throw new Error("provisional adapter generation runtime fence is stale");
      }
      const context = await this.authority.resolveProvisionalCaseAdapterContextAtRoot(activeRoot, {
        planId: request.planId,
        caseComponentInstanceId: request.caseComponentInstanceId,
        runtimeGeneration: state.runtimeGeneration,
        runtimeRevision: state.revision,
      });
      const candidate = await replayProvisionalCaseAdapterCandidate(context, request, state.runtimeGeneration);
      await storeResolvedAuthorityClosureAtRoot(activeRoot, context);
      await storePlanAuthorityAtRoot(activeRoot, context);
      await storeCandidateAtRoot(activeRoot, candidate);
      return deepFreeze(candidate) as ProvisionalCaseAdapterCandidate;
    }, { expectedRevision: request.expectedRuntimeRevision });
    return written.result;
  }

  /** Narrow production hook for the governed adapter_generation handler. */
  async proposeAtRoot(value: unknown): Promise<ProvisionalCaseAdapterCandidate> {
    return this.generate(value);
  }
}

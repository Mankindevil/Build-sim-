import { createHash } from "node:crypto";
import { agentAuditHash } from "../../src/agent/audit";
import { stableAgentJson } from "../../src/agent/evaluation-contract";
import { createCaseAdapterManifest, type CaseAdapterManifest } from "../../src/adapters/contracts";
import {
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
  REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
  type RuntimeCaseAdapterRegistryEntry,
  type RuntimeCaseAdapterRegistryState,
} from "../../src/adapters/runtime-registry-repository";

const ENTRY_DOMAIN = "buildsim.runtime-case-adapter-registration-v1";
const REGISTRY_DOMAIN = "buildsim.runtime-case-adapter-registry-v1";

function rawHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function manifest(depthMm: number, suffix: string): Promise<CaseAdapterManifest> {
  const identity = {
    skuId: "fixture.case.runtime-registry",
    region: "global",
    revision: "rev-a",
    identityFactIds: [`fact.fixture.identity.${suffix}`],
  };
  const dimensions = [`fact.fixture.width.${suffix}`, `fact.fixture.height.${suffix}`, `fact.fixture.depth.${suffix}`];
  const provisional = (sourceFactIds: string[], derivationId: string, uncertaintyMm: number) => ({
    status: "provisional" as const,
    sourceFactIds: [...sourceFactIds].sort(),
    derivationIds: [derivationId],
    uncertaintyMm,
  });
  return createCaseAdapterManifest({
    schemaVersion: "case-adapter-manifest-v1",
    adapterId: "adapter.provisional.fixture.case.runtime-registry",
    adapterVersion: "provisional-v1",
    identity,
    capabilityBindings: [
      { facetId: "identity.revision", sourceFactIds: [identity.identityFactIds[0]!] },
      { facetId: "physical.width", sourceFactIds: [dimensions[0]!] },
      { facetId: "physical.height", sourceFactIds: [dimensions[1]!] },
      { facetId: "physical.depth", sourceFactIds: [dimensions[2]!] },
    ],
    geometry: {
      envelope: {
        nodeId: "case.envelope", centerMm: [0, 0, 0], sizeMm: [240, 480, depthMm],
        binding: { status: "verified", sourceFactIds: dimensions, derivationIds: [], uncertaintyMm: 0 },
      },
      interiorSpaces: [{
        nodeId: "case.interior", centerMm: [0, 0, 0], sizeMm: [230, 470, depthMm - 10],
        binding: provisional(dimensions, "derive.fixture.interior-v1", 2),
      }],
      forbiddenZones: [],
      serviceCorridors: [],
    },
    mounts: [{
      mountId: "mount.board.primary", kind: "motherboard", standardIds: ["mount.motherboard.atx"],
      quantity: 1, location: "main",
      binding: provisional([`fact.fixture.mount.${suffix}`], "derive.fixture.mount-v1", 1),
    }],
    ports: [{
      portId: "front.usb-c", connectorStandardId: "usb-c", direction: "bidirectional", quantity: 1,
      anchorMm: [0, 220, -depthMm / 2 + 10],
      binding: provisional([`fact.fixture.port.${suffix}`, ...dimensions], "derive.fixture.port-v1", 4),
    }],
    routingZones: [{
      zoneId: "route.primary", kind: "free", centerMm: [0, 0, 0], sizeMm: [220, 450, depthMm - 20],
      connectsToZoneIds: [],
      binding: provisional([`fact.fixture.port.${suffix}`, ...dimensions], "derive.fixture.route-v1", 5),
    }],
    assemblyConstraints: [],
    bundleItems: [],
    resourcePatterns: [],
    sourceRefs: [
      `capture-sha256-${suffix.repeat(64).slice(0, 64)}`,
      `doc-sha256-${suffix.repeat(64).slice(0, 64)}`,
      `sha256:${suffix.repeat(64).slice(0, 64)}`,
    ].sort(),
  });
}

function approval(runSuffix: string, inputHash: string, issuedAt: string) {
  const runId = `run-registry-fixture-${runSuffix}`;
  const execution = {
    toolName: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_NAME,
    toolDefinitionHash: REGISTER_PROVISIONAL_CASE_ADAPTER_TOOL_DEFINITION_HASH,
    sessionId: `session-registry-fixture-${runSuffix}`,
    runId,
    inputHash,
    callId: `call-registry-fixture-${runSuffix}`,
  };
  const identity = agentAuditHash({ contractVersion: "1.0.0", ...execution });
  const unsigned = {
    schemaVersion: "agent-write-approval-binding-v1" as const,
    confirmedAuthorityRef: `sha256:${rawHash(`confirmed-${runSuffix}`)}` as const,
    pendingRef: `sha256:${rawHash(`pending-${runSuffix}`)}` as const,
    approvalId: `approval-${identity}`,
    approvedBy: `reviewer-${runSuffix}`,
    idempotencyKey: `agent-write-${identity}`,
    ...execution,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString(),
    runtimeGeneration: 1,
    jobId: `job-${rawHash(`agent-run:${runId}`)}`,
    checkpointRef: `sha256:${rawHash(`confirmed-${runSuffix}`)}` as const,
    planContextHash: rawHash(`plan-context-${runSuffix}`),
  };
  return { ...unsigned, contentHash: agentAuditHash(unsigned) };
}

function entryFor(
  value: CaseAdapterManifest,
  suffix: string,
  previousEntryHash: string | null,
  registeredAt: string,
): RuntimeCaseAdapterRegistryEntry {
  const candidateHash = rawHash(`candidate-${suffix}`);
  const authorityRefs = {
    generationJobId: `job-${rawHash(`generation-${suffix}`)}` as const,
    generationJobResultRef: `sha256:${rawHash(`attempt-${suffix}`)}` as const,
    planContextArtifactRef: `sha256:${rawHash(`plan-${suffix}`)}` as const,
    evidenceClaimIds: [`claim-sha256-${rawHash(`claim-${suffix}`)}`],
    evidenceDocumentIds: [value.sourceRefs.find((ref) => ref.startsWith("doc-"))!],
    evidenceCaptureIds: [value.sourceRefs.find((ref) => ref.startsWith("capture-"))!],
    evidenceLocatorArtifactRefs: [value.sourceRefs.find((ref) => ref.startsWith("sha256:"))! as `sha256:${string}`],
  };
  const planContext = {
    planId: "plan-runtime-registry-fixture",
    caseComponentInstanceId: "case-runtime-registry-fixture",
    planRevision: suffix === "a" ? 1 : 2,
    configHash: rawHash(`config-${suffix}`),
  };
  const factSnapshotRef = { snapshotId: `fact-snapshot-${suffix}`, contentHash: rawHash(`snapshot-${suffix}`) };
  const approvalInputHash = agentAuditHash({
    candidateId: `provisional-case-adapter-sha256-${candidateHash}`,
    planId: planContext.planId,
    caseComponentInstanceId: planContext.caseComponentInstanceId,
    planRevision: planContext.planRevision,
    configHash: planContext.configHash,
    manifestHash: value.contentHash,
    factSnapshotHash: factSnapshotRef.contentHash,
    expectedPriorRegistrationHash: previousEntryHash,
    expectedPriorRegistryRef: null,
  });
  const unsigned = {
    schemaVersion: "runtime-case-adapter-registration-v1" as const,
    identity: structuredClone(value.identity),
    manifest: structuredClone(value),
    manifestHash: value.contentHash,
    candidateId: `provisional-case-adapter-sha256-${candidateHash}` as const,
    previousEntryHash,
    planContext,
    factSnapshotRef,
    authorityRefs,
    approval: approval(suffix, approvalInputHash, registeredAt),
    registeredAt,
  };
  const contentHash = agentAuditHash({ domain: ENTRY_DOMAIN, entry: unsigned });
  return { ...unsigned, entryId: `runtime-case-adapter-registration-sha256-${contentHash}`, contentHash };
}

function registryState(
  entry: RuntimeCaseAdapterRegistryEntry,
  registryGeneration: number,
  previousRegistryRef: `sha256:${string}` | null,
): RuntimeCaseAdapterRegistryState {
  const unsigned = {
    schemaVersion: "runtime-case-adapter-registry-v1" as const,
    runtimeGeneration: 1,
    registryGeneration,
    previousRegistryRef,
    entries: [entry],
  };
  const contentHash = agentAuditHash({ domain: REGISTRY_DOMAIN, registry: unsigned });
  return { ...unsigned, registryRef: `sha256:${contentHash}`, contentHash };
}

export interface RuntimeCaseAdapterRegistryFixtureVersion {
  registryRef: `sha256:${string}`;
  registryBytes: string;
  runtimeGeneration: number;
  registryGeneration: number;
  manifests: CaseAdapterManifest[];
  state: RuntimeCaseAdapterRegistryState;
}

/** Pure, durable-schema-valid gen1/gen2 bytes for lock/cache tests. */
export async function createRuntimeCaseAdapterRegistryFixture(): Promise<{
  first: RuntimeCaseAdapterRegistryFixtureVersion;
  second: RuntimeCaseAdapterRegistryFixtureVersion;
}> {
  const firstManifest = await manifest(420, "a");
  const firstEntry = entryFor(firstManifest, "a", null, "2026-08-28T12:00:00.000Z");
  const firstState = registryState(firstEntry, 1, null);
  const secondManifest = await manifest(430, "b");
  const secondEntry = entryFor(secondManifest, "b", firstEntry.contentHash, "2026-08-28T12:01:00.000Z");
  const secondState = registryState(secondEntry, 2, firstState.registryRef);
  const project = (state: RuntimeCaseAdapterRegistryState): RuntimeCaseAdapterRegistryFixtureVersion => ({
    registryRef: state.registryRef,
    registryBytes: stableAgentJson({
      domain: REGISTRY_DOMAIN,
      registry: Object.fromEntries(Object.entries(state).filter(([key]) => !["registryRef", "contentHash"].includes(key))),
    }),
    runtimeGeneration: state.runtimeGeneration,
    registryGeneration: state.registryGeneration,
    manifests: state.entries.map((entry) => structuredClone(entry.manifest)),
    state: structuredClone(state),
  });
  return { first: project(firstState), second: project(secondState) };
}

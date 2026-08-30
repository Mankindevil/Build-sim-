import {
  ARTIFACT_LOCK_ROLES,
  createArtifactLockfile,
  createContentAddressedRef,
  createLockedArtifactRef,
  hashContent,
  type ArtifactLockEntries,
  type ArtifactLockRole,
  type SnapshotHashes,
} from "../../src/hash";
import { createFactSnapshot } from "../../src/facts/snapshots";
import type { ConflictSet, FactRecord } from "../../src/facts/contracts";
import { contentHashRuntime } from "../../src/facts/canonical-runtime.mjs";
import { factFieldPolicy } from "../../src/facts/field-registry";
import { sha256Utf8Runtime } from "../../src/hash/sha256-runtime.mjs";
import { createPlanEvaluationLock } from "../../src/plans/evaluation-lock";
import { hashPlanConfig } from "../../src/plans/canonical";
import type {
  GovernedEvaluationInput,
  LoadedArtifactInputs,
  ResolvedObservationRecord,
} from "../../src/server/evaluation-service";
import type { BuildConfigV3, ComponentInstance } from "../../src/topology/contracts";
import type { PriceQuote, PriceSnapshotFile } from "../../src/price/types";
import {
  BUILTIN_COMPATIBILITY_ENGINE_MODULE_IDS,
  BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS,
  BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES,
} from "../../src/compatibility/rules";

export const PROGRESSIVE_FIXTURE_NOW = "2026-08-28T12:00:00.000Z";

export function progressivePriceSnapshot(quotes: readonly PriceQuote[] = []): PriceSnapshotFile {
  const inputHash = sha256Utf8Runtime(JSON.stringify(quotes));
  if (inputHash === null) throw new TypeError("fixture price input cannot be hashed");
  const material = {
    schemaVersion: "1.1.0" as const,
    asOf: "2026-08-28",
    snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: PROGRESSIVE_FIXTURE_NOW,
    inputHash,
    priceVersion: "price-snapshot-v2" as const,
    quotes: structuredClone([...quotes]),
  };
  const contentHash = sha256Utf8Runtime(JSON.stringify(material));
  if (contentHash === null) throw new TypeError("fixture price snapshot cannot be hashed");
  return { ...material, contentHash };
}

const ROLE_DOMAIN: Record<ArtifactLockRole, string> = {
  ruleSet: "artifact.rule-set",
  standardSet: "artifact.standard-set",
  systemProfile: "artifact.system-profile",
  adapterSnapshot: "artifact.adapter-snapshot",
  engine: "artifact.engine",
  simulationModel: "artifact.simulation-model",
};

export function resolvedComponent(
  instanceId: string,
  kind: ComponentInstance["kind"],
  skuId: string,
  role = kind,
): ComponentInstance {
  return {
    instanceId,
    kind,
    role,
    state: "planned",
    identity: { status: "resolved", skuId, identityClaimIds: [`fact.identity.${instanceId}`] },
    source: "user",
  };
}

export function fact(
  component: ComponentInstance,
  field: string,
  value: FactRecord["value"],
  options: Partial<Pick<FactRecord, "authority" | "scope" | "status" | "unit">> & {
    subjectRevision?: string;
    subjectRegion?: string;
  } = {},
): FactRecord {
  if (component.identity.status !== "resolved") throw new TypeError("fixture facts require resolved identity");
  const token = field.replaceAll("_", "-");
  const authority = options.authority ?? "official";
  const policy = factFieldPolicy(field);
  if (policy === null) throw new TypeError(`fixture fact field is not governed: ${field}`);
  const digest = sha256Utf8Runtime(`${component.instanceId}\0${field}\0${JSON.stringify(value)}`);
  const material = {
    schemaVersion: "fact-record-v1",
    factId: field === "identity.model" ? `fact.identity.${component.instanceId}` : `fact.${component.instanceId}.${token}`,
    subject: {
      kind: "product" as const,
      skuId: component.identity.skuId,
      revision: options.subjectRevision ?? "fixture",
      ...(options.subjectRegion === undefined ? {} : { region: options.subjectRegion }),
    },
    field,
    value,
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    scope: options.scope ?? "revision",
    authority,
    safetyClass: policy.safetyClass,
    status: options.status ?? "active",
    evidenceRefs: authority === "official" || authority === "third_party" ? [`claim-sha256-${digest}`] : [],
    derivedFromFactIds: authority === "agent_inference" ? [`fact.source.${digest}`] : [],
    ...(authority === "agent_inference" ? {
      inferenceTraceId: `inference-sha256-${digest}`,
      extractorOrRuleVersion: "fixture-inference@1.0.0",
      assumptions: [],
    } : {}),
    confidence: 1,
    retrievedAt: PROGRESSIVE_FIXTURE_NOW,
  };
  const contentHash = contentHashRuntime(material, "fact-record", "fact-record-v1", "factRecord");
  if (contentHash === null) throw new TypeError("fixture fact hash failed");
  return { ...material, contentHash } as FactRecord;
}

function artifactPayload(role: ArtifactLockRole): unknown {
  if (role === "ruleSet") return {
    schemaVersion: "workspace-rule-set-v1",
    ruleIds: [...BUILTIN_COMPATIBILITY_RULE_ARTIFACT_IDS],
    sources: [{
      moduleId: "compatibility/rule-manifest",
      bytes: JSON.stringify(BUILTIN_COMPATIBILITY_RULE_MANIFEST_ENTRIES),
    }],
  };
  if (role === "engine") return {
    schemaVersion: "workspace-engine-v1",
    engineId: "progressive-engine",
    engineVersion: "1.0.0",
    sources: BUILTIN_COMPATIBILITY_ENGINE_MODULE_IDS.map((moduleId) => ({
      moduleId,
      // Production bundles can legitimately contain a literal NUL in a
      // regular-expression character class. Artifact identity preserves the
      // exact source text instead of treating it as a scalar user string.
      bytes: `locked\0source bytes for ${moduleId}`,
    })),
  };
  if (role === "adapterSnapshot") return {
    schemaVersion: "workspace-adapter-snapshot-v1",
    catalog: { schemaVersion: "2.0.0", skus: [] },
    sources: [{ moduleId: "adapter/fixture", bytes: "locked adapter fixture" }],
  };
  if (role === "standardSet") return {
    schemaVersion: "workspace-standard-set-v1",
    standardIds: ["standard.fixture"],
    sources: [{ moduleId: "standard/fixture", bytes: "locked standard fixture" }],
  };
  if (role === "systemProfile") return {
    schemaVersion: "workspace-system-profile-v1",
    profileId: "system.linux-desktop",
    supportedPlanSchemas: ["2.0.0", "3.0.0"],
    sources: [{ moduleId: "system/fixture", bytes: "locked system fixture" }],
  };
  return {
    schemaVersion: "workspace-simulation-model-binding-v1",
    modelId: "simulation.fixture",
    modelVersion: "1.0.0",
    claims: "unknown",
    sources: [{ moduleId: "simulation/fixture", bytes: "locked simulation fixture" }],
  };
}

async function artifacts(): Promise<{ loaded: LoadedArtifactInputs; entries: ArtifactLockEntries }> {
  const pairs = await Promise.all(ARTIFACT_LOCK_ROLES.map(async (role) => {
    const payload = artifactPayload(role);
    const ref = await createLockedArtifactRef(
      payload,
      role,
      `${role}.fixture`,
      `application/vnd.buildsim.${role}+json`,
      { domain: ROLE_DOMAIN[role], schemaVersion: "1.0.0" },
    );
    return [role, { ref, payload }] as const;
  }));
  const loaded = Object.fromEntries(pairs) as LoadedArtifactInputs;
  const entries = Object.fromEntries(pairs.map(([role, value]) => [role, value.ref])) as ArtifactLockEntries;
  return { loaded, entries };
}

export async function progressiveInput(
  config: BuildConfigV3,
  facts: readonly FactRecord[] = [],
  observations: readonly ResolvedObservationRecord[] = [],
  conflicts: readonly ConflictSet[] = [],
  priceSnapshot: PriceSnapshotFile = progressivePriceSnapshot(),
): Promise<GovernedEvaluationInput> {
  const artifactClosure = await artifacts();
  const artifactLockfile = await createArtifactLockfile(artifactClosure.entries);
  const factById = new Map(facts.map((entry) => [entry.factId, entry]));
  for (const component of config.components) {
    if (component.identity.status !== "resolved") continue;
    for (const identityClaimId of component.identity.identityClaimIds) {
      if (factById.has(identityClaimId)) continue;
      const generated = fact(component, "identity.model", component.identity.skuId, { scope: "revision" });
      if (generated.factId === identityClaimId) factById.set(identityClaimId, generated);
      else {
        const { contentHash: _contentHash, ...material } = generated;
        const renamed = { ...material, factId: identityClaimId };
        const contentHash = contentHashRuntime(renamed, "fact-record", "fact-record-v1", "factRecord");
        if (contentHash === null) throw new TypeError("fixture identity fact hash failed");
        factById.set(identityClaimId, { ...renamed, contentHash } as FactRecord);
      }
    }
  }
  const allFacts = [...factById.values()].sort((left, right) => left.factId.localeCompare(right.factId));
  const factSnapshot = await createFactSnapshot({
    schemaVersion: "fact-snapshot-v2",
    factRefs: allFacts.map(({ factId, contentHash }) => ({ factId, contentHash })),
    conflictRefs: conflicts.map(({ conflictSetId, contentHash }) => ({ conflictSetId, contentHash })),
    createdAt: PROGRESSIVE_FIXTURE_NOW,
  });
  const sortedObservations = [...observations].sort((left, right) => left.observation.observationId.localeCompare(right.observation.observationId));
  const observationMaterial = {
    schemaVersion: "user-observation-snapshot-v1" as const,
    snapshotId: "observation-snapshot-progressive",
    planId: config.id,
    observationIds: sortedObservations.map(({ observation }) => observation.observationId),
    observationRecordHashes: Object.fromEntries(sortedObservations.map(({ observation, recordHash }) => [observation.observationId, recordHash])),
    createdAt: PROGRESSIVE_FIXTURE_NOW,
  };
  const observationSnapshot = {
    ...observationMaterial,
    contentHash: await hashContent(observationMaterial, {
      domain: "user-observation-snapshot",
      schemaVersion: "user-observation-snapshot-v1",
    }),
  };
  const requirementSpec = { requirementSpecId: "requirements.progressive", schemaVersion: "1.0.0" as const, workloads: [], constraints: [] };
  const requirementSpecRef = await createContentAddressedRef(requirementSpec, { domain: "requirement-spec", schemaVersion: "1.0.0" });
  const emptyArtifact = { schemaVersion: "artifact-payload-v1" as const, artifactId: "empty", mediaType: "application/json", payload: {}, contentHash: "0".repeat(64) };
  const emptyArtifactHash = await hashContent(emptyArtifact, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  const emptyPayload = { ...emptyArtifact, contentHash: emptyArtifactHash };
  const emptyRef = await createContentAddressedRef(emptyPayload, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  const priceArtifactCandidate = {
    schemaVersion: "artifact-payload-v1" as const,
    artifactId: `price-${priceSnapshot.snapshotId}`,
    mediaType: "application/vnd.buildsim.price-snapshot+json",
    payload: structuredClone(priceSnapshot),
    contentHash: "0".repeat(64),
  };
  const priceArtifactHash = await hashContent(priceArtifactCandidate, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  const priceArtifact = { ...priceArtifactCandidate, contentHash: priceArtifactHash };
  const priceRef = await createContentAddressedRef(priceArtifact, { domain: "artifact", schemaVersion: "artifact-payload-v1" });
  const configHash = await hashPlanConfig(config);
  const snapshotHashes: SnapshotHashes = {
    configHash,
    requirementSpecHash: requirementSpecRef.contentHash,
    factSnapshotHash: factSnapshot.contentHash,
    userObservationSnapshotHash: observationSnapshot.contentHash,
    priceSnapshotHash: priceRef.contentHash,
    ruleSetHash: artifactClosure.loaded.ruleSet.ref.contentHash,
    systemProfileHash: artifactClosure.loaded.systemProfile.ref.contentHash,
    adapterSnapshotHash: artifactClosure.loaded.adapterSnapshot.ref.contentHash,
    engineHash: artifactClosure.loaded.engine.ref.contentHash,
    simulationModelHash: artifactClosure.loaded.simulationModel.ref.contentHash,
    simulationInputHash: emptyRef.contentHash,
  };
  const evaluationLock = await createPlanEvaluationLock({
    planId: config.id,
    snapshotHashes,
    factSnapshotId: factSnapshot.snapshotId,
    userObservationSnapshotId: observationSnapshot.snapshotId,
    artifactLockfileHash: artifactLockfile.lockfileHash,
  });
  return {
    planId: config.id,
    planVersionId: null,
    draftRevision: 0,
    config,
    snapshotHashes,
    factClosure: { snapshot: factSnapshot, facts: allFacts, conflicts: [...conflicts], decisions: [] },
    observationClosure: { snapshot: observationSnapshot, observations: sortedObservations },
    artifactLockfile,
    artifacts: artifactClosure.loaded,
    externalInputs: {
      requirementSpec: { ref: requirementSpecRef, payload: requirementSpec },
      priceSnapshot: { ref: priceRef, payload: priceArtifact },
      simulationInput: { ref: emptyRef, payload: emptyPayload },
    },
    evaluationLock,
  };
}

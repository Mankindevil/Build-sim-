import { describe, expect, it } from "vitest";
import {
  validatePortableProfile,
  verifyPortableProfileClosure,
  verifyPortableProfileClosureAuthoritatively,
  type BackupManifest,
  type PortableClosureVerificationContext,
  type PortableReferenceEdge,
} from "../src/backup/contracts";
import { ARTIFACT_LOCK_ROLES, createArtifactLockfile, createLockedArtifactRef, hashContent, type ArtifactLockfile, type ArtifactLockRole } from "../src/hash";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";

const digest = "b".repeat(64);
const artifactDomain: Record<ArtifactLockRole, string> = {
  ruleSet: "artifact.rule-set",
  standardSet: "artifact.standard-set",
  systemProfile: "artifact.system-profile",
  adapterSnapshot: "artifact.adapter-snapshot",
  engine: "artifact.engine",
  simulationModel: "artifact.simulation-model",
};

async function lockfile(): Promise<ArtifactLockfile> {
  const entries = Object.fromEntries(await Promise.all(ARTIFACT_LOCK_ROLES.map(async (role) => [role, await createLockedArtifactRef(
    { role, version: 1 }, role, `${role}-1`, "application/json", { domain: artifactDomain[role], schemaVersion: "1.0.0" },
  )]))) as unknown as Parameters<typeof createArtifactLockfile>[0];
  return createArtifactLockfile(entries);
}

async function manifest(profile: "slim" | "complete", lock: ArtifactLockfile): Promise<BackupManifest> {
  const candidate: BackupManifest = {
    schemaVersion: "backup-v1", backupId: "portable", createdAt: "2026-08-27T00:00:00.000Z", appVersion: "1", runtimeGeneration: 1,
    entries: [], includedRoots: ["plan"], excludedEntries: [], planIds: ["plan"], requirementSpecHashes: [], factSnapshotIds: [], userObservationSnapshotIds: [], priceSnapshotIds: [], evaluationHashes: [], artifactLockfileRef: `sha256:${lock.lockfileHash}`, executionSessionIds: [], manifestHash: digest,
    mode: "plan_portable", portableProfile: profile,
  };
  return { ...candidate, manifestHash: await hashContent(candidate, { domain: "backup-manifest", schemaVersion: "backup-v1" }) };
}

function context(lock: ArtifactLockfile, stagedIncludedRefs: string[]): PortableClosureVerificationContext {
  const lockRef = `sha256:${lock.lockfileHash}`;
  const artifactRefs = Object.values(lock.artifacts).map((artifact) => artifact.ref);
  const edges: PortableReferenceEdge[] = [
    { fromRef: "plan", toRef: "facts", necessity: "required_for_replay" },
    { fromRef: "plan", toRef: lockRef, necessity: "required_for_replay" },
    { fromRef: "plan", toRef: "vendor-original", necessity: "optional_for_audit" },
    ...artifactRefs.map((ref) => ({ fromRef: lockRef, toRef: ref, necessity: "required_for_replay" as const })),
  ];
  return {
    trustedRepositoryGraph: { graphVersion: "repository-reference-graph-v1", graphHash: digest, nodes: ["plan", "facts", "vendor-original", lockRef, ...artifactRefs], edges },
    requiredRoots: ["plan"], stagedIncludedRefs, artifactLockfile: lock,
  };
}

describe("U0 portable profile closure", () => {
  it("keeps structural validation unable to self-claim exact replay", async () => {
    const lock = await lockfile();
    expect(validatePortableProfile(await manifest("slim", lock))).toMatchObject({ valid: true, exactReplayReady: false, missingRequiredRefs: [] });
  });

  it("derives complete closure from trusted roots/graph and the verified artifact lock", async () => {
    const lock = await lockfile();
    const complete = await manifest("complete", lock);
    const all = ["plan", "facts", `sha256:${lock.lockfileHash}`, ...Object.values(lock.artifacts).map((artifact) => artifact.ref)];
    await expect(verifyPortableProfileClosure(complete, context(lock, all))).resolves.toMatchObject({ valid: true, exactReplayReady: true, missingRequiredRefs: [] });
  });

  it("rejects omitted trusted edges/roots and a tampered lock even if package claims completeness", async () => {
    const lock = await lockfile();
    const complete = await manifest("complete", lock);
    const withoutFact = ["plan", `sha256:${lock.lockfileHash}`, ...Object.values(lock.artifacts).map((artifact) => artifact.ref)];
    await expect(verifyPortableProfileClosure(complete, context(lock, withoutFact))).resolves.toMatchObject({ valid: false, exactReplayReady: false, missingRequiredRefs: ["facts"] });
    await expect(verifyPortableProfileClosure(complete, { ...context(lock, withoutFact.slice(1)), requiredRoots: ["plan"] })).resolves.toMatchObject({ valid: false, exactReplayReady: false, missingRequiredRefs: expect.arrayContaining(["plan", "facts"]) });
    const tampered = { ...lock, artifacts: { ...lock.artifacts, engine: { ...lock.artifacts.engine, artifactId: "tampered" } } };
    await expect(verifyPortableProfileClosure(complete, { ...context(lock, withoutFact), artifactLockfile: tampered })).resolves.toMatchObject({ valid: false, exactReplayReady: false });
  });

  it("resolves closure state and recomputes the trusted repository graph hash", async () => {
    const lock = await lockfile();
    const complete = await manifest("complete", lock);
    const all = ["plan", "facts", `sha256:${lock.lockfileHash}`, ...Object.values(lock.artifacts).map((artifact) => artifact.ref)];
    const base = context(lock, all);
    const graph = { ...base.trustedRepositoryGraph, graphVersion: "portable-reference-graph-v1" };
    const trusted: PortableClosureVerificationContext = { ...base, trustedRepositoryGraph: { ...graph, graphHash: await hashContent(graph, {
      domain: "portable-reference-graph", schemaVersion: "portable-reference-graph-v1",
    }) } };
    const resolver = createAuthoritativeResolver("portable-closure-context", (ref) => ref === "portable/closure" ? trusted : undefined);
    await expect(verifyPortableProfileClosureAuthoritatively(complete, "portable/closure", resolver))
      .resolves.toMatchObject({ valid: true, exactReplayReady: true, errors: [] });
    await expect(verifyPortableProfileClosureAuthoritatively(complete, "missing", resolver))
      .resolves.toMatchObject({ valid: false, exactReplayReady: false, errors: [expect.stringContaining("portable closure authoritative context resolution failed")] });
    await expect(verifyPortableProfileClosureAuthoritatively(complete, "portable/closure", JSON.parse(JSON.stringify(trusted)) as never))
      .resolves.toMatchObject({ valid: false, exactReplayReady: false, errors: [expect.stringContaining("resolver was not issued by the server composition root")] });
    const tampered = createAuthoritativeResolver("portable-closure-context", () => ({
      ...trusted,
      trustedRepositoryGraph: { ...trusted.trustedRepositoryGraph, nodes: [...trusted.trustedRepositoryGraph.nodes, "injected"] },
    }));
    await expect(verifyPortableProfileClosureAuthoritatively(complete, "portable/closure", tampered))
      .resolves.toMatchObject({ valid: false, exactReplayReady: false, errors: expect.arrayContaining(["trusted repository reference graphHash verification failed"]) });
  });
});

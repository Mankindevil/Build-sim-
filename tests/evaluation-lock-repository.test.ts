import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactRepository } from "../src/facts/repository";
import { ObservationRepository } from "../src/observations/repository";
import { createArtifactLockfile, createLockedArtifactRef, type ArtifactLockEntries, type SnapshotHashes } from "../src/hash";
import { createPlanEvaluationLock } from "../src/plans/evaluation-lock";
import { EvaluationLockRepository } from "../src/plans/evaluation-lock-repository";

const roots: string[] = [];
const digest = (value: string): string => value.repeat(64);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-evaluation-lock-"));
  roots.push(root);
  const facts = new FactRepository({ root: path.join(root, "facts"), now: () => "2026-08-28T02:00:00.000Z" });
  const factSnapshot = await facts.createSnapshot();
  const observations = new ObservationRepository({
    root: path.join(root, "observations"),
    now: () => "2026-08-28T02:00:00.000Z",
    attachments: { hasAvailable: async () => true },
  });
  const observationSnapshot = await observations.createSnapshot("plan-a");
  const entries = await Promise.all((["ruleSet", "standardSet", "systemProfile", "adapterSnapshot", "engine", "simulationModel"] as const).map(async (role) => [
    role,
    await createLockedArtifactRef({ role, version: 1 }, role, `${role}-v1`, "application/json", {
      domain: `artifact.${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      schemaVersion: "1.0.0",
    }),
  ] as const));
  const artifactLockfile = await createArtifactLockfile(Object.fromEntries(entries) as unknown as ArtifactLockEntries);
  const presentRefs = new Set(Object.values(artifactLockfile.artifacts).map((entry) => entry.ref));
  let externalValid = true;
  const repository = new EvaluationLockRepository({
    root: path.join(root, "snapshots"), facts, observations,
    verifyArtifact: (ref) => presentRefs.has(ref.ref),
    verifyExternalSnapshotHashes: () => externalValid,
  });
  await repository.putArtifactLockfile(artifactLockfile);
  const snapshotHashes: SnapshotHashes = {
    configHash: digest("1"), requirementSpecHash: digest("2"), factSnapshotHash: factSnapshot.contentHash,
    userObservationSnapshotHash: observationSnapshot.contentHash, priceSnapshotHash: digest("3"),
    ruleSetHash: artifactLockfile.artifacts.ruleSet.contentHash,
    systemProfileHash: artifactLockfile.artifacts.systemProfile.contentHash,
    adapterSnapshotHash: artifactLockfile.artifacts.adapterSnapshot.contentHash,
    engineHash: artifactLockfile.artifacts.engine.contentHash,
    simulationModelHash: artifactLockfile.artifacts.simulationModel.contentHash,
    simulationInputHash: digest("4"),
  };
  const lock = await createPlanEvaluationLock({
    planId: "plan-a", snapshotHashes, factSnapshotId: factSnapshot.snapshotId,
    userObservationSnapshotId: observationSnapshot.snapshotId, artifactLockfileHash: artifactLockfile.lockfileHash,
  });
  return { repository, lock, setExternalValid: (value: boolean) => { externalValid = value; } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("U3 evaluation authority lock repository", () => {
  it("persists and re-verifies the full fact, observation and artifact closure", async () => {
    const { repository, lock } = await fixture();
    await expect(repository.putEvaluationLock(lock)).resolves.toEqual(lock);
    await expect(repository.verify(lock)).resolves.toBe(true);
    await expect(repository.putEvaluationLock(lock)).resolves.toEqual(lock);
  });

  it("rejects wrong plan ownership, self-consistent hash substitutions and unavailable external snapshots", async () => {
    const { repository, lock, setExternalValid } = await fixture();
    const wrongPlan = await createPlanEvaluationLock({
      planId: "plan-b", snapshotHashes: lock.snapshotHashes, factSnapshotId: lock.factSnapshotId,
      userObservationSnapshotId: lock.userObservationSnapshotId, artifactLockfileHash: lock.artifactLockfileHash,
    });
    await expect(repository.putEvaluationLock(wrongPlan)).rejects.toThrow(/observation snapshot closure/);
    const changed = await createPlanEvaluationLock({
      planId: lock.planId, snapshotHashes: { ...lock.snapshotHashes, adapterSnapshotHash: digest("f") }, factSnapshotId: lock.factSnapshotId,
      userObservationSnapshotId: lock.userObservationSnapshotId, artifactLockfileHash: lock.artifactLockfileHash,
    });
    await expect(repository.putEvaluationLock(changed)).rejects.toThrow(/artifact snapshot hashes/);
    setExternalValid(false);
    await expect(repository.putEvaluationLock(lock)).rejects.toThrow(/external snapshot closure/);
  });
});

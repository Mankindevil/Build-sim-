import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { planArtifactGc, runArtifactGc } from "../src/runtime/gc.mjs";
import { createConsistentReferenceGraph } from "../src/runtime/reference-graph.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U1 reference-graph mark-and-sweep", () => {
  it("defaults to dry-run, protects reachable/audit objects, and quarantines only eligible garbage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-gc-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const repository = new FileArtifactRepository({ coordinator, now: () => "2026-01-01T00:00:00.000Z" });
    const child = await repository.put({ bytes: Buffer.from("child"), mediaType: "text/plain", privacyClass: "runtime_internal", kind: "fact", references: [] });
    const parent = await repository.put({ bytes: Buffer.from("parent"), mediaType: "text/plain", privacyClass: "runtime_internal", kind: "active_snapshot", references: [{ ref: child.record.ref, necessity: "required_for_replay" }] });
    const dead = await repository.put({ bytes: Buffer.from("dead"), mediaType: "text/plain", privacyClass: "runtime_internal", kind: "temporary", references: [] });
    const audit = await repository.put({ bytes: Buffer.from("audit"), mediaType: "text/plain", privacyClass: "runtime_internal", kind: "audit", references: [] });
    const graph = await createConsistentReferenceGraph({ coordinator, providers: [repository], requiredRoots: [parent.record.ref] });
    const policy = { repository, referenceGraph: graph, retentionMs: 1, now: () => "2026-08-27T00:00:00.000Z" };
    const plan = await planArtifactGc(policy);
    expect(plan.candidates.map((candidate: { ref: string }) => candidate.ref)).toEqual([dead.record.ref]);
    expect(plan.markedRefs).toEqual(expect.arrayContaining([parent.record.ref, child.record.ref, audit.record.ref]));
    await runArtifactGc(policy);
    expect(await repository.get(dead.record.ref)).not.toBeNull();
    const applied = await runArtifactGc({ ...policy, dryRun: false });
    expect(applied.quarantined).toEqual([expect.objectContaining({ ref: dead.record.ref, quarantined: true })]);
    expect(await repository.get(dead.record.ref)).toBeNull();
    expect(await repository.get(child.record.ref)).not.toBeNull();
    expect(await repository.restoreQuarantined(dead.record.ref)).toMatchObject({ restored: true });
    expect(await repository.get(dead.record.ref)).not.toBeNull();
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashContent } from "../src/hash";
import type { ObservationProjectionContext, UserObservation, UserObservationSnapshot } from "../src/observations/contracts";
import { ObservationRepository } from "../src/observations/repository";
import { canonicalJson } from "../src/plans/canonical";

const roots: string[] = [];
const sha = (character: string): string => character.repeat(64);
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const now = (): string => "2026-08-28T04:00:00.000Z";

function context(candidate: UserObservation): ObservationProjectionContext {
  return {
    planId: candidate.planId,
    subjectExists: true,
    currentConfigHash: candidate.observedAgainstConfigHash,
    currentSubjectRevisionHash: candidate.subjectRevisionHash,
  };
}

function activeObservation(observationId: string, planId: string, instanceId: string, value: number): UserObservation {
  const base = {
    observationId,
    planId,
    subjectRef: { kind: "instance" as const, instanceId },
    fieldId: "physical.component_length" as const,
    value,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "measurement" as const,
    attachmentRefs: [],
    confirmedByUser: true,
    observedAgainstConfigHash: planId === "plan-a" ? sha("a") : sha("c"),
    subjectRevisionHash: instanceId.endsWith("a") ? sha("b") : sha("d"),
    capturedAt: "2026-08-28T03:00:00.000Z",
    validatedAt: "2026-08-28T03:01:00.000Z",
    status: "active" as const,
  };
  return { ...base, contentHash: digest(base) };
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-observation-snapshot-"));
  roots.push(root);
  const store = new ObservationRepository({
    root,
    now,
    attachments: { hasAvailable: async () => false },
    projectionContextForObservation: context,
  });
  return { root, store };
}

async function expectedSnapshotHash(snapshot: UserObservationSnapshot): Promise<string> {
  const { contentHash: _contentHash, ...base } = snapshot;
  return hashContent(base, { domain: "user-observation-snapshot", schemaVersion: "user-observation-snapshot-v1" });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 content-addressed observation snapshots", () => {
  it("sorts and pins exact immutable record hashes and independently recomputes both hashes", async () => {
    const { store } = await repository();
    const first = activeObservation("observation-a", "plan-a", "instance-a", 147);
    const second = activeObservation("observation-b", "plan-a", "instance-b", 149);
    await store.put({ observation: first });
    await store.put({ observation: second });

    const snapshot = await store.createSnapshot("plan-a", { observationIds: [second.observationId, first.observationId] });
    expect(snapshot.observationIds).toEqual([first.observationId, second.observationId]);
    expect(snapshot.observationRecordHashes).toEqual({
      [first.observationId]: digest(first),
      [second.observationId]: digest(second),
    });
    expect(snapshot.contentHash).toBe(await expectedSnapshotHash(snapshot));

    const closure = {
      schemaVersion: "user-observation-snapshot-v1" as const,
      planId: snapshot.planId,
      observationIds: snapshot.observationIds,
      observationRecordHashes: snapshot.observationRecordHashes,
    };
    const closureHash = await hashContent(closure, {
      domain: "user-observation-snapshot",
      schemaVersion: "user-observation-snapshot-v1",
    });
    expect(snapshot.snapshotId).toBe(`snapshot-${closureHash}`);
    await expect(store.createSnapshot("plan-a", { observationIds: [first.observationId, second.observationId] })).resolves.toEqual(snapshot);
    await expect(store.getSnapshot("plan-a", snapshot.snapshotId)).resolves.toEqual(snapshot);
    await expect(store.getSnapshot("plan-b", snapshot.snapshotId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("detects a payload changed behind a recomputed outer checksum", async () => {
    const { root, store } = await repository();
    const candidate = activeObservation("observation-tamper", "plan-a", "instance-a", 147);
    await store.put({ observation: candidate });
    const snapshot = await store.createSnapshot("plan-a");
    const snapshotFile = path.join(root, "plans", "plan-a", "snapshots", `${snapshot.snapshotId}.json`);
    const envelope = JSON.parse(await readFile(snapshotFile, "utf8")) as {
      checksum: string;
      payload: UserObservationSnapshot;
    };
    envelope.payload.createdAt = "2026-08-28T04:01:00.000Z";
    envelope.checksum = digest(envelope.payload);
    await writeFile(snapshotFile, `${JSON.stringify(envelope)}\n`);

    await expect(store.getSnapshot("plan-a", snapshot.snapshotId)).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("changes only the affected plan snapshot after supersede and retract", async () => {
    const { store } = await repository();
    const planA = activeObservation("observation-plan-a", "plan-a", "instance-a", 147);
    const planB = activeObservation("observation-plan-b", "plan-b", "instance-a", 147);
    await store.put({ observation: planA });
    await store.put({ observation: planB });
    const beforeA = await store.createSnapshot("plan-a");
    const beforeB = await store.createSnapshot("plan-b");

    const replacementCandidate = activeObservation("ignored", "plan-a", "instance-a", 149);
    const {
      observationId: _observationId,
      planId: _planId,
      supersedesObservationId: _supersedesObservationId,
      contentHash: _contentHash,
      ...replacement
    } = replacementCandidate;
    const superseded = await store.supersede({
      planId: "plan-a",
      observationId: planA.observationId,
      expectedHash: digest(planA),
      replacementObservationId: "observation-plan-a-updated",
      context: context(planA),
      replacement,
    });
    const updatedA = await store.createSnapshot("plan-a");
    const unchangedB = await store.createSnapshot("plan-b");
    expect(updatedA.snapshotId).not.toBe(beforeA.snapshotId);
    expect(updatedA.observationIds).toEqual([superseded.observationId]);
    expect(unchangedB).toEqual(beforeB);

    await store.retract({
      planId: "plan-a",
      observationId: superseded.observationId,
      expectedHash: digest(superseded),
      replacementObservationId: "observation-plan-a-retracted",
      context: context(superseded),
    });
    const retractedA = await store.createSnapshot("plan-a");
    expect(retractedA.observationIds).toEqual([]);
    expect(retractedA.snapshotId).not.toBe(updatedA.snapshotId);
    await expect(store.createSnapshot("plan-b")).resolves.toEqual(beforeB);
  });
});

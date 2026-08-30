import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentRepository } from "../src/attachments/repository";
import { canonicalJson } from "../src/plans/canonical";
import {
  ObservationRepository,
  type CreateObservationSnapshotOptions,
} from "../src/observations/repository";
import type { ObservationProjectionContext, UserObservation } from "../src/observations/contracts";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = [];
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hash = (letter: string): string => letter.repeat(64);
const now = () => "2026-08-28T00:03:00.000Z";

function context(overrides: Partial<ObservationProjectionContext> = {}): ObservationProjectionContext {
  return {
    planId: "plan-a",
    subjectExists: true,
    currentConfigHash: hash("a"),
    currentSubjectRevisionHash: hash("b"),
    ...overrides,
  };
}

function activeObservation(observationId: string, overrides: Partial<UserObservation> = {}): UserObservation {
  const { contentHash: _contentHash, ...rest } = overrides;
  const base = {
    observationId,
    planId: "plan-a",
    subjectRef: { kind: "placement" as const, placementId: "placement-a" },
    fieldId: "physical.clearance" as const,
    value: 4,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "photo" as const,
    attachmentRefs: ["attachment-a"],
    confirmedByUser: true,
    observedAgainstConfigHash: hash("a"),
    subjectRevisionHash: hash("b"),
    capturedAt: "2026-08-28T00:00:00.000Z",
    validatedAt: "2026-08-28T00:01:00.000Z",
    status: "active" as const,
    ...rest,
  };
  return { ...base, contentHash: digest(base) } as UserObservation;
}

function proposedObservation(observationId: string): UserObservation {
  const base = {
    observationId,
    planId: "plan-a",
    subjectRef: { kind: "placement" as const, placementId: "placement-a" },
    fieldId: "physical.clearance" as const,
    value: 4,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "photo" as const,
    attachmentRefs: ["attachment-a"],
    confirmedByUser: false,
    observedAgainstConfigHash: hash("a"),
    subjectRevisionHash: hash("b"),
    capturedAt: "2026-08-28T00:00:00.000Z",
    status: "proposed" as const,
  };
  return { ...base, contentHash: digest(base) };
}

async function localRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-observation-lifecycle-"));
  roots.push(root);
  const attachments = new AttachmentRepository({ root: path.join(root, "attachments"), now });
  const attachment = await attachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("image"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
  let id = 0;
  const observations = new ObservationRepository({
    root: path.join(root, "observations"),
    attachments,
    now,
    id: (prefix) => `${prefix}-${++id}`,
  });
  return { root, attachments, attachment, observations };
}

const snapshotOptions = (): CreateObservationSnapshotOptions => ({ resolveProjectionContext: () => context() });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 observation lifecycle CAS and current snapshots", () => {
  it("activates exactly one immutable successor under source-hash CAS and snapshots only that current record", async () => {
    const { root, attachments, observations } = await localRepository();
    const proposed = proposedObservation("observation-proposed");
    await observations.put({ observation: proposed });

    await expect(observations.activate({
      planId: "plan-a", observationId: proposed.observationId, expectedHash: digest(proposed), replacementObservationId: "observation-stale-context", context: context({ currentSubjectRevisionHash: hash("c") }),
    })).rejects.toMatchObject({ code: "conflict" });

    const results = await Promise.allSettled([
      observations.activate({ planId: "plan-a", observationId: proposed.observationId, expectedHash: digest(proposed), replacementObservationId: "observation-active-a", context: context() }),
      observations.activate({ planId: "plan-a", observationId: proposed.observationId, expectedHash: digest(proposed), replacementObservationId: "observation-active-b", context: context() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const active = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<UserObservation>).value;
    expect(active).toMatchObject({ status: "active", confirmedByUser: true, supersedesObservationId: proposed.observationId });
    expect((await observations.listCurrent("plan-a")).map((entry) => entry.observationId)).toEqual([active.observationId]);

    await expect(observations.createSnapshot("plan-a", { ...snapshotOptions(), observationIds: [proposed.observationId] })).rejects.toMatchObject({ code: "invalid_input" });
    const snapshot = await observations.createSnapshot("plan-a", snapshotOptions());
    expect(snapshot.observationIds).toEqual([active.observationId]);
    expect(snapshot.observationRecordHashes).toEqual({ [active.observationId]: digest(active) });

    const factAuthority = new ObservationRepository({
      root: path.join(root, "observations"), attachments, now,
      projectionContextForObservation: () => context(),
    });
    await expect(factAuthority.resolveForFact("plan-a", proposed.observationId)).resolves.toBeNull();
    await expect(factAuthority.resolveForFact("plan-a", active.observationId)).resolves.toMatchObject({ observation: { observationId: active.observationId } });
  });

  it("keeps supersede, invalidate, and retract append-only, and excludes every non-projectable head from a new snapshot", async () => {
    const { observations } = await localRepository();
    const initial = activeObservation("observation-initial");
    const proposal = proposedObservation("observation-retract");
    await observations.put({ observation: initial });
    await observations.put({ observation: proposal });

    const nextCandidate = activeObservation("ignored", { value: 5 });
    const { observationId: _id, planId: _planId, supersedesObservationId: _supersedes, contentHash: _contentHash, ...replacement } = nextCandidate;
    const superseded = await observations.supersede({
      planId: "plan-a", observationId: initial.observationId, expectedHash: digest(initial), replacementObservationId: "observation-replacement", context: context(), replacement,
    });
    expect(superseded).toMatchObject({ status: "active", value: 5, supersedesObservationId: initial.observationId });

    const invalidated = await observations.invalidate({
      planId: "plan-a", observationId: superseded.observationId, expectedHash: digest(superseded), replacementObservationId: "observation-invalidated", context: context({ currentConfigHash: hash("d") }), invalidationReason: "placement route changed",
    });
    const retracted = await observations.retract({
      planId: "plan-a", observationId: proposal.observationId, expectedHash: digest(proposal), replacementObservationId: "observation-retracted", context: context(),
    });
    expect(invalidated.invalidatedAt).toBe(now());
    expect(retracted.status).toBe("retracted");
    expect((await observations.listCurrent("plan-a")).map((entry) => entry.observationId).sort()).toEqual([invalidated.observationId, retracted.observationId].sort());

    await expect(observations.createSnapshot("plan-a", { ...snapshotOptions(), observationIds: [invalidated.observationId] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(observations.createSnapshot("plan-a", { ...snapshotOptions(), observationIds: [retracted.observationId] })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await observations.createSnapshot("plan-a", snapshotOptions())).observationIds).toEqual([]);
  });

  it("derives a stable snapshot identity from sorted immutable member closure", async () => {
    const { root, attachments } = await localRepository();
    const observations = new ObservationRepository({ root: path.join(root, "observations"), attachments, now });
    const first = activeObservation("observation-closure-a");
    const second = activeObservation("observation-closure-b", { value: 5 });
    await observations.put({ observation: first });
    await observations.put({ observation: second });

    const one = await observations.createSnapshot("plan-a", { ...snapshotOptions(), observationIds: [second.observationId, first.observationId] });
    const two = await observations.createSnapshot("plan-a", { ...snapshotOptions(), observationIds: [first.observationId, second.observationId] });
    expect(one).toEqual(two);
    expect(one.snapshotId).toMatch(/^snapshot-[a-f0-9]{64}$/);
    expect(one.observationIds).toEqual([first.observationId, second.observationId]);
  });

  it("keeps activation and attachment deletion behind one RuntimeCoordinator writer barrier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-observation-lifecycle-barrier-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now });
    const attachments = new AttachmentRepository({ coordinator, now });
    const attachment = await attachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("image"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    let pause = false;
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const observations = new ObservationRepository({
      coordinator,
      now,
      attachments: {
        hasAvailable: (attachmentId, planId) => attachments.hasAvailable(attachmentId, planId),
        hasAvailableAtRoot: async (activeRoot, attachmentId, planId) => {
          if (pause) { entered(); await releasePromise; }
          return attachments.hasAvailableAtRoot(activeRoot, attachmentId, planId);
        },
      },
    });
    const proposed = proposedObservation("observation-proposed");
    await observations.put({ observation: proposed });
    pause = true;
    const activation = observations.activate({ planId: "plan-a", observationId: proposed.observationId, expectedHash: digest(proposed), replacementObservationId: "observation-active", context: context() });
    await enteredPromise;
    let deleted = false;
    const deletion = attachments.delete("attachment-a", { expectedRevision: attachment.revision, expectedHash: attachment.metadataHash }).then((result) => { deleted = true; return result; });
    await Promise.resolve();
    expect(deleted).toBe(false);
    release();
    const active = await activation;
    await deletion;
    await expect(observations.createSnapshot("plan-a", { ...snapshotOptions(), observationIds: [active.observationId] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("publishes exact observation snapshot closure while retracted history no longer pins deleted attachment bytes", async () => {
    const { root, attachments, attachment, observations } = await localRepository();
    const initial = activeObservation("observation-snapshot-source");
    await observations.put({ observation: initial });
    const snapshot = await observations.createSnapshot("plan-a", snapshotOptions());
    const before = await observations.snapshotReferences(root);
    expect(before.nodes).toEqual(expect.arrayContaining([
      `observation:${initial.observationId}`,
      `observation-snapshot:${snapshot.snapshotId}`,
    ]));
    expect(before.edges).toEqual(expect.arrayContaining([
      { fromRef: `observation-snapshot:${snapshot.snapshotId}`, toRef: `observation:${initial.observationId}`, necessity: "required_for_replay" },
      { fromRef: `observation:${initial.observationId}`, toRef: "attachment:attachment-a", necessity: "required_for_replay" },
    ]));

    await observations.retract({ planId: "plan-a", observationId: initial.observationId, expectedHash: digest(initial), replacementObservationId: "observation-snapshot-retracted", context: context() });
    await attachments.delete("attachment-a", { expectedRevision: attachment.revision, expectedHash: attachment.metadataHash });
    const after = await observations.snapshotReferences(root);
    expect(after.edges).toContainEqual({ fromRef: `observation-snapshot:${snapshot.snapshotId}`, toRef: `observation:${initial.observationId}`, necessity: "required_for_replay" });
    expect(after.edges).not.toContainEqual({ fromRef: `observation:${initial.observationId}`, toRef: "attachment:attachment-a", necessity: "required_for_replay" });
  });

  it("re-resolves the active generation after a pointer switch and reads the same restarted observation authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-observation-lifecycle-generation-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now });
    const liveAttachments = new AttachmentRepository({ coordinator, now });
    await liveAttachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("generation-one"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    const live = new ObservationRepository({ coordinator, attachments: liveAttachments, now });
    await live.put({ observation: activeObservation("observation-generation-one") });

    const before = await coordinator.readState();
    const lease = await coordinator.acquireMaintenanceLease("observation-pointer-test");
    const staging = await coordinator.createStagingGeneration(lease.token);
    const stagedAttachments = new AttachmentRepository({ root: path.join(staging, "attachments"), now });
    await stagedAttachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("generation-two"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    const staged = new ObservationRepository({ root: path.join(staging, "observations"), attachments: stagedAttachments, now });
    await staged.put({ observation: activeObservation("observation-generation-two") });
    await coordinator.activateStagingGeneration(staging, before.runtimeGeneration, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);

    expect((await live.list("plan-a")).map((entry) => entry.observationId)).toEqual(["observation-generation-two"]);
    const restarted = new ObservationRepository({ coordinator, attachments: new AttachmentRepository({ coordinator, now }), now });
    expect((await restarted.list("plan-a")).map((entry) => entry.observationId)).toEqual(["observation-generation-two"]);
  });
});

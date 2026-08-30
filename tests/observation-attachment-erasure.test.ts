import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentRepository } from "../src/attachments/repository";
import type { ObservationProjectionContext, UserObservation } from "../src/observations/contracts";
import { ObservationRepository } from "../src/observations/repository";
import { canonicalJson } from "../src/plans/canonical";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createConsistentReferenceGraph } from "../src/runtime/reference-graph.mjs";

const roots: string[] = [];
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sha = (character: string): string => character.repeat(64);
const now = (): string => "2026-08-28T03:00:00.000Z";
const context = (): ObservationProjectionContext => ({
  planId: "plan-a",
  subjectExists: true,
  currentConfigHash: sha("a"),
  currentSubjectRevisionHash: sha("b"),
});

function proposal(): UserObservation {
  const base = {
    observationId: "observation-photo-proposal",
    planId: "plan-a",
    subjectRef: { kind: "placement" as const, placementId: "placement-a" },
    fieldId: "physical.clearance" as const,
    value: 4,
    unit: "mm" as const,
    uncertainty: { plusMinus: 0.5 },
    method: "photo" as const,
    attachmentRefs: ["attachment-photo"],
    confirmedByUser: false,
    observedAgainstConfigHash: sha("a"),
    subjectRevisionHash: sha("b"),
    capturedAt: "2026-08-28T02:00:00.000Z",
    status: "proposed" as const,
  };
  return { ...base, contentHash: digest(base) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("U3 observation attachment erasure", () => {
  it("serializes activation with deletion, tombstones metadata, invalidates projection, and never exports deleted bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-observation-erasure-"));
    roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now });
    const attachments = new AttachmentRepository({ coordinator, now });
    const privateBytes = Buffer.from("private-photo-bytes-must-not-survive-new-export");
    const attachment = await attachments.put({
      attachmentId: "attachment-photo",
      planId: "plan-a",
      content: privateBytes,
      mediaType: "image/jpeg",
      deletionPolicy: "retain_until_user_deletes",
    });
    const beforeExport = await coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => attachments.snapshotReferences(activeRoot));

    let pauseClosure = false;
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
          if (pauseClosure) {
            entered();
            await releasePromise;
          }
          return attachments.hasAvailableAtRoot(activeRoot, attachmentId, planId);
        },
      },
      projectionContextForObservation: () => context(),
    });
    const proposed = proposal();
    await observations.put({ observation: proposed });

    pauseClosure = true;
    const activation = observations.activate({
      planId: "plan-a",
      observationId: proposed.observationId,
      expectedHash: digest(proposed),
      replacementObservationId: "observation-photo-active",
      context: context(),
    });
    await enteredPromise;

    let deletionCommitted = false;
    const deletion = attachments.delete("attachment-photo", {
      expectedRevision: attachment.revision,
      expectedHash: attachment.metadataHash,
    }).then((result) => {
      deletionCommitted = true;
      return result;
    });
    await Promise.resolve();
    expect(deletionCommitted).toBe(false);

    release();
    const active = await activation;
    const tombstone = await deletion;
    expect(tombstone).toMatchObject({
      attachmentId: attachment.attachmentId,
      contentHash: attachment.contentHash,
      status: "deleted_tombstone",
      deletedAt: now(),
      revision: 1,
    });
    expect(JSON.stringify(tombstone)).not.toContain(privateBytes.toString("utf8"));
    await expect(attachments.readBlob(attachment.attachmentId)).rejects.toMatchObject({ code: "not_found" });
    await expect(attachments.inspectBlob(attachment.contentHash)).resolves.toEqual({ exists: false, valid: false });

    await expect(observations.resolveForFact("plan-a", active.observationId)).resolves.toBeNull();
    await expect(observations.createSnapshot("plan-a")).resolves.toMatchObject({ observationIds: [] });

    // A new portable/reference export fails closed on the now-dangling active
    // observation. It cannot silently recover or re-include the deleted blob.
    await expect(createConsistentReferenceGraph({
      coordinator,
      providers: [attachments, observations],
      now,
    })).rejects.toThrow(/dangling/);

    const attachmentProjection = await coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => attachments.snapshotReferences(activeRoot));
    expect(attachmentProjection.result.manifestHash).not.toBe(beforeExport.result.manifestHash);
    expect(attachmentProjection.result.revision).toBeGreaterThan(beforeExport.result.revision);
    expect(attachmentProjection.result.nodes).not.toContain(`attachment:${attachment.attachmentId}`);
    expect(attachmentProjection.result.nodes).not.toContain(`attachment-blob:sha256:${attachment.contentHash}`);
    expect(await attachments.get(attachment.attachmentId)).toMatchObject({
      status: "deleted_tombstone",
      contentHash: attachment.contentHash,
    });
  });
});

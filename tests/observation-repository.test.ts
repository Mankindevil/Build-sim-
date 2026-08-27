import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentRepository } from "../src/attachments/repository";
import { canonicalJson } from "../src/plans/canonical";
import { ObservationRepository } from "../src/observations/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import type { UserObservation } from "../src/observations/contracts";

const roots: string[] = [];
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hashes = (letter: string) => letter.repeat(64);
function observation(id = "observation-a", supersedesObservationId?: string): UserObservation {
  const base = { observationId: id, planId: "plan-a", subjectRef: { kind: "placement" as const, placementId: "placement-a" }, fieldId: "physical.clearance" as const, value: 4, unit: "mm" as const, uncertainty: { plusMinus: 0.5 }, method: "photo" as const, attachmentRefs: ["attachment-a"], confirmedByUser: true, observedAgainstConfigHash: hashes("a"), subjectRevisionHash: hashes("b"), capturedAt: "2026-08-27T00:00:00.000Z", validatedAt: "2026-08-27T00:01:00.000Z", status: "active" as const, ...(supersedesObservationId ? { supersedesObservationId } : {}) };
  return { ...base, contentHash: digest(base) };
}
async function repositories() { const root = await mkdtemp(path.join(tmpdir(), "build-sim-observations-")); roots.push(root); const attachments = new AttachmentRepository({ root: path.join(root, "attachments") }); await attachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("photo"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" }); return { root, attachments, store: new ObservationRepository({ root: path.join(root, "observations"), attachments, now: () => "2026-08-27T00:02:00.000Z", id: (prefix) => `${prefix}-fixed` }) }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("U1 ObservationRepository", () => {
  it("persists only plan-scoped observations with an available attachment closure", async () => {
    const { root, attachments, store } = await repositories();
    const saved = await store.put({ observation: observation() });
    expect(saved.observationId).toBe("observation-a");
    await expect(store.put({ observation: { ...observation("observation-b"), planId: "plan-b" } })).rejects.toMatchObject({ code: "invalid_input" });
    const restarted = new ObservationRepository({ root: path.join(root, "observations"), attachments });
    await expect(restarted.get("plan-a", "observation-a")).resolves.toMatchObject({ contentHash: saved.contentHash });
  });

  it("keeps observation records immutable, idempotent, and records supersession separately", async () => {
    const { root, store } = await repositories();
    const first = observation(); await store.put({ observation: first, expectedHash: digest(first) });
    await expect(store.put({ observation: first, expectedHash: digest(first) })).resolves.toEqual(first);
    await store.put({ observation: observation("observation-b", "observation-a") });
    expect(await store.listSupersessions("plan-a")).toMatchObject([{ supersededObservationId: "observation-a", replacementObservationId: "observation-b" }]);
    expect((await store.listCurrent("plan-a")).map((item) => item.observationId)).toEqual(["observation-b"]);
    await expect(store.put({ observation: observation("observation-c", "observation-a") })).rejects.toMatchObject({ code: "conflict" });
    expect((await store.get("plan-a", "observation-a")).status).toBe("active");
    const originalFile = path.join(root, "observations", "plans", "plan-a", "records", "observation-a.json");
    expect(await readFile(originalFile, "utf8")).toContain("observation-a");
  });

  it("creates content-addressed snapshots and rejects corruption/partial or concurrent conflicting writes", async () => {
    const { root, store } = await repositories();
    const result = await Promise.allSettled([store.put({ observation: observation() }), store.put({ observation: { ...observation(), value: 5 } })]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
    const snapshot = await store.createSnapshot("plan-a"); expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const file = path.join(root, "observations", "plans", "plan-a", "records", "observation-a.json"); const raw = JSON.parse(await readFile(file, "utf8")); raw.payload.observation.value = 999; await writeFile(file, JSON.stringify(raw));
    await expect(store.get("plan-a", "observation-a")).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("uses a coordinator generation for observations rather than a static runtime root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-observations-runtime-")); roots.push(root); const coordinator = new RuntimeCoordinator({ root });
    const attachments = new AttachmentRepository({ coordinator }); await attachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("photo"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    const store = new ObservationRepository({ coordinator, attachments }); await store.put({ observation: observation() });
    await expect(readFile(path.join(root, "generations", "1", "observations", "plans", "plan-a", "records", "observation-a.json"), "utf8")).resolves.toContain("observation-a");
  });

  it("fails closed when a coordinated attachment provider cannot read inside the active-root barrier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-observations-runtime-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const unsupported = { hasAvailable: async () => true };
    const store = new ObservationRepository({ coordinator, attachments: unsupported });
    await expect(store.put({ observation: observation() })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(readFile(path.join(root, "generations", "1", "observations", "plans", "plan-a", "records", "observation-a.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds the same writer barrier across attachment validation and observation commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-observations-race-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const attachments = new AttachmentRepository({ coordinator });
    const attachment = await attachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("photo"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const lookup = {
      hasAvailable: (id: string, planId: string) => attachments.hasAvailable(id, planId),
      hasAvailableAtRoot: async (activeRoot: string, id: string, planId: string) => {
        entered();
        await releasePromise;
        return attachments.hasAvailableAtRoot(activeRoot, id, planId);
      },
    };
    const store = new ObservationRepository({ coordinator, attachments: lookup });
    const put = store.put({ observation: observation() });
    await enteredPromise;
    let tombstoned = false;
    const deletion = attachments.delete("attachment-a", { expectedRevision: attachment.revision, expectedHash: attachment.metadataHash }).then((result) => { tombstoned = true; return result; });
    await Promise.resolve();
    expect(tombstoned).toBe(false);
    release();
    await expect(put).resolves.toMatchObject({ observationId: "observation-a" });
    await expect(deletion).resolves.toMatchObject({ status: "deleted_tombstone" });
    await expect(store.put({ observation: observation("observation-after-tombstone") })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

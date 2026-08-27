import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentRepository } from "../src/attachments/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createConsistentReferenceGraph } from "../src/runtime/reference-graph.mjs";

const roots: string[] = [];
async function repository() { const root = await mkdtemp(path.join(tmpdir(), "build-sim-attachments-")); roots.push(root); return { root, store: new AttachmentRepository({ root, now: () => "2026-08-27T00:00:00.000Z", id: () => "attachment-fixed" }) }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("U1 AttachmentRepository", () => {
  it("separates private content-addressed blobs from 0600 metadata and survives restart", async () => {
    const { root, store } = await repository();
    const saved = await store.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("private photo bytes"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    expect(saved).toMatchObject({ attachmentId: "attachment-a", privacyClass: "private_user", status: "available", revision: 0 });
    const metadataPath = path.join(root, "metadata", "attachment-a.json");
    expect(await readFile(metadataPath, "utf8")).not.toContain("private photo bytes");
    expect((await (await import("node:fs/promises")).stat(metadataPath)).mode & 0o777).toBe(0o600);
    const restarted = new AttachmentRepository({ root });
    await expect(restarted.readBlob("attachment-a")).resolves.toEqual(Buffer.from("private photo bytes"));
    expect(await restarted.hasAvailable("attachment-a", "plan-a")).toBe(true);
    expect(await restarted.hasAvailable("attachment-a", "plan-b")).toBe(false);
  });

  it("deduplicates blobs, is idempotent, and fences metadata tombstones by revision/hash", async () => {
    const { store } = await repository();
    const first = await store.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("same"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" });
    const repeated = await store.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("same"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes", expectedHash: first.contentHash });
    expect(repeated.metadataHash).toBe(first.metadataHash);
    await expect(store.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("different"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.delete("attachment-a", { expectedRevision: 0, expectedHash: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
    const deleted = await store.delete("attachment-a", { expectedRevision: 0, expectedHash: first.metadataHash });
    expect(deleted).toMatchObject({ status: "deleted_tombstone", revision: 1, deletedAt: expect.any(String) });
    await expect(store.readBlob("attachment-a")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.inspectBlob(first.contentHash)).resolves.toMatchObject({ exists: false, valid: false });
  });

  it("erases raw bytes only after the last available attachment reference is tombstoned", async () => {
    const { store } = await repository();
    const first = await store.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("shared-private"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" });
    const second = await store.put({ attachmentId: "attachment-b", planId: "plan-a", content: Buffer.from("shared-private"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" });
    await store.delete("attachment-a", { expectedRevision: 0, expectedHash: first.metadataHash });
    await expect(store.inspectBlob(first.contentHash)).resolves.toMatchObject({ exists: true, valid: true });
    await store.delete("attachment-b", { expectedRevision: 0, expectedHash: second.metadataHash });
    await expect(store.inspectBlob(first.contentHash)).resolves.toMatchObject({ exists: false, valid: false });
  });

  it("detects corruption, ignores orphan partial files, and serializes concurrent id collisions", async () => {
    const { root, store } = await repository();
    await store.put({ attachmentId: "attachment-partial", planId: "plan-a", content: Buffer.from("complete"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" });
    await writeFile(path.join(root, "metadata", "interrupted.json.temporary"), "partial");
    await expect(store.get("attachment-partial")).resolves.toMatchObject({ attachmentId: "attachment-partial" });
    const writes = await Promise.allSettled([
      store.put({ attachmentId: "attachment-race", planId: "plan-a", content: Buffer.from("one"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" }),
      store.put({ attachmentId: "attachment-race", planId: "plan-a", content: Buffer.from("two"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" }),
    ]);
    expect(writes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((item) => item.status === "rejected")).toHaveLength(1);
    const metadataPath = path.join(root, "metadata", "attachment-race.json");
    const raw = JSON.parse(await readFile(metadataPath, "utf8")); raw.payload.planId = "tampered"; await writeFile(metadataPath, JSON.stringify(raw));
    await expect(store.get("attachment-race")).rejects.toMatchObject({ code: "corrupt_data" });
  });

  it("uses a directory lock across independent repository instances", async () => {
    const { root } = await repository();
    const left = new AttachmentRepository({ root }); const right = new AttachmentRepository({ root });
    const results = await Promise.allSettled([
      left.put({ attachmentId: "attachment-shared", planId: "plan-a", content: Buffer.from("left"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" }),
      right.put({ attachmentId: "attachment-shared", planId: "plan-a", content: Buffer.from("right"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("uses the coordinator-selected active generation by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-attachments-runtime-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root }); const store = new AttachmentRepository({ coordinator });
    await store.put({ attachmentId: "attachment-active", planId: "plan-a", content: Buffer.from("active"), mediaType: "image/png", deletionPolicy: "retain_until_user_deletes" });
    await expect(readFile(path.join(root, "generations", "1", "attachments", "metadata", "attachment-active.json"), "utf8")).resolves.toContain("attachment-active");
  });

  it("publishes attachment-to-blob references without re-entering the snapshot barrier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-attachment-graph-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root });
    const store = new AttachmentRepository({ coordinator });
    const saved = await store.put({
      attachmentId: "attachment-graph",
      planId: "plan-a",
      content: Buffer.from("graph body"),
      mediaType: "image/png",
      deletionPolicy: "retain_until_user_deletes",
    });
    const graph = await createConsistentReferenceGraph({
      coordinator,
      providers: [store],
      requiredRoots: ["attachment:attachment-graph"],
    });
    expect(graph.edges).toContainEqual({
      fromRef: "attachment:attachment-graph",
      toRef: `attachment-blob:sha256:${saved.contentHash}`,
      necessity: "required_for_replay",
    });
    await store.delete("attachment-graph", { expectedRevision: 0, expectedHash: saved.metadataHash });
    const afterDelete = await createConsistentReferenceGraph({ coordinator, providers: [store] });
    expect(afterDelete.edges).not.toContainEqual(expect.objectContaining({ fromRef: "attachment:attachment-graph" }));
  });
});

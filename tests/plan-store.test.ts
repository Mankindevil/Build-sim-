import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/plans/canonical";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanRepository } from "../src/plans/file-repository";
import { PlanConflictError } from "../src/plans/conflict";
import { ensureDefaultPlan } from "../src/plans/seed";

const roots: string[] = [];
let counter = 0;

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-plans-"));
  roots.push(root);
  const now = () => `2026-08-25T00:00:${String(counter++).padStart(2, "0")}.000Z`;
  const id = (prefix: "plan" | "version") => `${prefix}-${String(counter++).padStart(8, "0")}`;
  return { root, store: new FilePlanRepository({ root, now, id }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  counter = 0;
});

describe("R1 file plan repository", () => {
  it("persists multiple plans and survives a repository restart", async () => {
    const { root, store } = await repository();
    const first = await store.create({ name: "First", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const second = await store.create({ name: "Second", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    expect((await store.list()).map((plan) => plan.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    const restarted = new FilePlanRepository({ root });
    await expect(restarted.get(first.id)).resolves.toMatchObject({ id: first.id, name: "First" });
  });

  it("saves immutable versions and rejects stale revisions without overwrite", async () => {
    const { store } = await repository();
    const plan = await store.create({ name: "Plan", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const hash = await sha256Hex(plan.draft.config);
    const version1 = await store.saveVersion(plan.id, { expectedRevision: 0, expectedConfigHash: hash, reason: "initial" });
    const changed = structuredClone(plan.draft.config);
    changed.selection.diskCount = 2;
    const updated = await store.updateDraft(plan.id, { expectedRevision: 0, config: changed });
    await expect(store.updateDraft(plan.id, { expectedRevision: 0, config: changed })).rejects.toBeInstanceOf(PlanConflictError);
    expect((await store.get(plan.id)).draftRevision).toBe(1);
    const version2 = await store.saveVersion(plan.id, { expectedRevision: 1, expectedConfigHash: await sha256Hex(updated.draft.config), reason: "manual-save" });
    expect(version1.config.selection.diskCount).toBe(1);
    expect(version2.config.selection.diskCount).toBe(2);
    expect((await store.listVersions(plan.id)).map((version) => version.configHash)).toEqual([version1.configHash, version2.configHash]);
  });

  it("serializes concurrent draft writes so only one expected revision wins", async () => {
    const { store } = await repository();
    const plan = await store.create({ name: "Concurrent", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const left = structuredClone(plan.draft.config);
    const right = structuredClone(plan.draft.config);
    left.selection.diskCount = 2;
    right.selection.diskCount = 3;
    const outcomes = await Promise.allSettled([
      store.updateDraft(plan.id, { expectedRevision: 0, config: left }),
      store.updateDraft(plan.id, { expectedRevision: 0, config: right }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await store.get(plan.id)).draftRevision).toBe(1);
  });

  it("atomically rejects fan groups that the selected case cannot install", async () => {
    const { store } = await repository();
    const plan = await store.create({ name: "Fan bounds", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    for (const fanGroups of [
      [{ mountId: "top", sizeMm: 120 as const, count: 1 }],
      [{ mountId: "rear", sizeMm: 140 as const, count: 16 }],
    ]) {
      const invalid = structuredClone(plan.draft.config);
      invalid.selection.fanGroups = fanGroups;
      await expect(store.updateDraft(plan.id, { expectedRevision: plan.draftRevision, config: invalid })).rejects.toMatchObject({ code: "invalid_input", status: 400 });
      await expect(store.get(plan.id)).resolves.toMatchObject({ draftRevision: plan.draftRevision, draft: { config: { selection: { fanGroups: plan.draft.config.selection.fanGroups } } } });
    }
  });

  it("renames plan metadata with revision protection and persists version summaries", async () => {
    const { store } = await repository();
    const plan = await store.create({ name: "Before", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const renamed = await store.updateInfo(plan.id, { expectedRevision: 0, name: "After", description: "Workstation NAS" });
    expect(renamed).toMatchObject({ name: "After", description: "Workstation NAS", draftRevision: 1, draft: { config: { name: "After" }, dirty: true } });
    await expect(store.updateInfo(plan.id, { expectedRevision: 0, name: "Stale" })).rejects.toMatchObject({ code: "stale_revision" });
    const version = await store.saveVersion(plan.id, { expectedRevision: 1, expectedConfigHash: await sha256Hex(renamed.draft.config), reason: "manual-save", summary: "Rename and document purpose", evaluationHash: "b".repeat(64), evaluatedAt: "2026-08-25T00:00:10.000Z" });
    expect(version.summary).toBe("Rename and document purpose");
    expect(version.evaluationHash).toBe("b".repeat(64));
    expect((await store.listVersions(plan.id))[0]?.summary).toBe("Rename and document purpose");
  });

  it("duplicates into an independent version chain and honors idempotency", async () => {
    const { store } = await repository();
    const source = await store.create({ name: "Source", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z"), idempotencyKey: "create-source" });
    const repeated = await store.create({ name: "Source", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z"), idempotencyKey: "create-source" });
    expect(repeated.id).toBe(source.id);
    const copy = await store.duplicate(source.id, { name: "Copy", idempotencyKey: "copy-source" });
    expect(copy.id).not.toBe(source.id);
    expect(copy.activeVersionId).toBeTruthy();
    expect(await store.listVersions(source.id)).toEqual([]);
    expect(await store.listVersions(copy.id)).toHaveLength(1);
  });

  it("seeds a genuinely empty first profile exactly once without a template checkpoint", async () => {
    const { store } = await repository();
    const first = await ensureDefaultPlan(store, () => "2026-08-25T00:00:00.000Z");
    const second = await ensureDefaultPlan(store, () => "2026-08-25T00:00:00.000Z");
    expect(second.id).toBe(first.id);
    expect(first.draft.config).toMatchObject({
      id: first.id,
      caseId: "",
      boardId: "",
      cpuId: "",
      selection: { psuId: "", coolerId: "", gpuId: "", memoryId: "", diskCount: 0, fanGroups: [] },
      bom: [],
    });
    expect(first.metadata.initialization).toMatchObject({ status: "initialized", source: "manual" });
    expect(await store.listVersions(first.id)).toHaveLength(0);
  });

  it("detects corrupt files and soft-deletes plans into trash", async () => {
    const { root, store } = await repository();
    const plan = await store.create({ name: "Plan", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const file = path.join(root, plan.id, "plan.json");
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.payload.name = "tampered";
    await writeFile(file, JSON.stringify(envelope));
    await expect(store.get(plan.id)).rejects.toMatchObject({ code: "corrupt_data" });

    const clean = await store.create({ name: "Delete", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    await store.delete(clean.id);
    await expect(store.get(clean.id)).rejects.toMatchObject({ code: "not_found" });
    const trashEntries = await readdir(path.join(root, ".trash"));
    const deletedDirectory = trashEntries.find((entry) => entry.startsWith(`${clean.id}-`));
    expect(deletedDirectory).toBeTruthy();
    expect((await readFile(path.join(root, ".trash", deletedDirectory!, "plan.json"), "utf8"))).toContain(clean.id);
  });
});

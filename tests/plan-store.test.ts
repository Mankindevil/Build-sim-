import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/plans/canonical";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanRepository } from "../src/plans/file-repository";
import { PlanConflictError } from "../src/plans/conflict";
import { ensureDefaultPlan } from "../src/plans/seed";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const roots: string[] = [];
let counter = 0;

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

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
    const planFile = path.join(root, first.id, "plan.json");
    const rollbackFile = path.join(root, ".rollback", "manifest.json");
    expect((await stat(planFile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(planFile))).mode & 0o777).toBe(0o700);
    expect((await stat(rollbackFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(rollbackFile, "utf8")).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: path.join(first.id, "plan.json"), status: "committed", backup: null }),
    ]));
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

  it("stores only strict authoritative idempotency references and rejects forged replay owners", async () => {
    const { root, store } = await repository();
    const first = await store.create({ name: "First", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const second = await store.create({ name: "Second", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const candidate = structuredClone(first.draft.config);
    candidate.selection.diskCount = 2;
    const input = { expectedRevision: first.draftRevision, config: candidate, idempotencyKey: "strict-update-replay" };
    await store.updateDraft(first.id, input);
    const idempotencyRoot = path.join(root, ".idempotency");
    const [recordName] = await readdir(idempotencyRoot);
    const recordFile = path.join(idempotencyRoot, recordName!);
    const envelope = JSON.parse(await readFile(recordFile, "utf8"));
    expect(envelope.payload).toMatchObject({
      schemaVersion: "plan-idempotency-v2", operation: `updateDraft:${first.id}`,
      result: { kind: "plan", planId: first.id, resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(envelope.payload.result).not.toHaveProperty("value");

    envelope.payload.result.planId = second.id;
    const { resultHash: _ignored, ...resultMaterial } = envelope.payload.result;
    envelope.payload.result.resultHash = checksum(resultMaterial);
    envelope.checksum = checksum(envelope.payload);
    await writeFile(recordFile, JSON.stringify(envelope));
    await expect(new FilePlanRepository({ root }).updateDraft(first.id, input)).rejects.toMatchObject({ code: "corrupt_data", status: 500 });
  });

  it("rejects checksum-valid unknown idempotency operations after restart", async () => {
    const { root, store } = await repository();
    const input = { name: "Strict create", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z"), idempotencyKey: "strict-create-replay" };
    await store.create(input);
    const [recordName] = await readdir(path.join(root, ".idempotency"));
    const recordFile = path.join(root, ".idempotency", recordName!);
    const envelope = JSON.parse(await readFile(recordFile, "utf8"));
    envelope.payload.operation = "forged-operation";
    envelope.checksum = checksum(envelope.payload);
    await writeFile(recordFile, JSON.stringify(envelope));
    await expect(new FilePlanRepository({ root }).create(input)).rejects.toMatchObject({ code: "corrupt_data", status: 500 });
  });

  it("rejects checksum-valid unknown Plan, Draft, metadata, and Version fields", async () => {
    const { root, store } = await repository();
    const plan = await store.create({ name: "Exact authority", config: createDefaultN6Config("draft", "2026-08-25T00:00:00.000Z") });
    const version = await store.saveVersion(plan.id, {
      expectedRevision: plan.draftRevision, expectedConfigHash: await sha256Hex(plan.draft.config), reason: "manual-save",
    });
    const planFile = path.join(root, plan.id, "plan.json");
    const originalPlanEnvelope = JSON.parse(await readFile(planFile, "utf8"));
    const planMutations = [
      (payload: any) => { payload.injected = true; },
      (payload: any) => { payload.draft.derivedEvaluation = {}; },
      (payload: any) => { payload.metadata.injected = true; },
      (payload: any) => { payload.metadata.initialization = { status: "pending", source: "agent", injected: true }; },
    ];
    for (const mutate of planMutations) {
      const envelope = structuredClone(originalPlanEnvelope);
      mutate(envelope.payload);
      envelope.checksum = checksum(envelope.payload);
      await writeFile(planFile, JSON.stringify(envelope));
      await expect(new FilePlanRepository({ root }).get(plan.id)).rejects.toMatchObject({ code: "corrupt_data" });
    }
    await writeFile(planFile, JSON.stringify(originalPlanEnvelope));

    const versionFile = path.join(root, plan.id, "versions", `${version.id}.json`);
    const originalVersionEnvelope = JSON.parse(await readFile(versionFile, "utf8"));
    for (const mutate of [
      (payload: any) => { payload.injected = true; },
      (payload: any) => { payload.summary = 42; },
      (payload: any) => { payload.evaluatedAt = 42; },
    ]) {
      const envelope = structuredClone(originalVersionEnvelope);
      mutate(envelope.payload);
      envelope.checksum = checksum(envelope.payload);
      await writeFile(versionFile, JSON.stringify(envelope));
      await expect(new FilePlanRepository({ root }).listVersions(plan.id)).rejects.toMatchObject({ code: "corrupt_data" });
    }
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
    await writeFile(`${file}.interrupted.tmp`, "partial", { mode: 0o600 });
    await expect(store.get(plan.id)).resolves.toMatchObject({ id: plan.id, name: "Plan" });
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

  it("resolves the active generation per call and fences maintenance across restart", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-plans-runtime-")); roots.push(runtimeRoot);
    const now = () => "2026-08-27T00:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
    const store = new FilePlanRepository({ coordinator, now, id: () => "plan-00000001" });
    const oldPlan = await store.create({ name: "Generation one", config: createDefaultN6Config("draft", now()) });
    await expect(readFile(path.join(runtimeRoot, "generations", "1", "plans", oldPlan.id, "plan.json"), "utf8")).resolves.toContain("Generation one");
    const lease = await coordinator.acquireMaintenanceLease("restore", { ttlMs: 60_000 });
    await expect(store.create({ name: "Fenced", config: createDefaultN6Config("draft", now()) })).rejects.toThrow(/maintenance lease/);
    const staging = await coordinator.createStagingGeneration(lease.token);
    const staged = new FilePlanRepository({ root: path.join(staging, "plans"), now, id: () => "plan-00000002" });
    const newPlan = await staged.create({ name: "Generation two", config: createDefaultN6Config("draft", now()) });
    await coordinator.activateStagingGeneration(staging, 1, lease.token);
    await coordinator.releaseMaintenanceLease(lease.token);
    await expect(store.get(oldPlan.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(store.get(newPlan.id)).resolves.toMatchObject({ name: "Generation two" });
    await expect(new FilePlanRepository({ coordinator, now }).list()).resolves.toMatchObject([{ id: newPlan.id }]);
  });

  it("serializes coordinator-backed writers and fails closed on legacy top-level data", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-plans-runtime-")); roots.push(runtimeRoot);
    const now = () => "2026-08-27T00:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root: runtimeRoot, now });
    const first = new FilePlanRepository({ coordinator, now, id: () => "plan-00000003" });
    const second = new FilePlanRepository({ coordinator, now });
    const plan = await first.create({ name: "Concurrent", config: createDefaultN6Config("draft", now()) });
    const left = structuredClone(plan.draft.config); left.selection.diskCount = 2;
    const right = structuredClone(plan.draft.config); right.selection.diskCount = 3;
    const outcomes = await Promise.allSettled([first.updateDraft(plan.id, { expectedRevision: 0, config: left }), second.updateDraft(plan.id, { expectedRevision: 0, config: right })]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const legacyRoot = await mkdtemp(path.join(tmpdir(), "build-sim-plans-legacy-")); roots.push(legacyRoot);
    await new FilePlanRepository({ root: path.join(legacyRoot, "plans"), now, id: () => "plan-00000004" }).create({ name: "Legacy", config: createDefaultN6Config("draft", now()) });
    await expect(new FilePlanRepository({ coordinator: new RuntimeCoordinator({ root: legacyRoot, now }), runtimeRoot: legacyRoot, now }).list()).rejects.toThrow(/migration dry-run/);
  });
});

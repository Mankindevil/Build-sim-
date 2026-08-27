import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVIDENCE_SCHEMA_VERSION, type PlanEvidenceBinding } from "../src/evidence/contracts";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { canonicalJson, sha256Hex } from "../src/plans/canonical";
import type { BindPlanEvidenceInput } from "../src/plans/contracts";
import { createDefaultN6Config } from "../src/plans/default-plan";
import { FilePlanRepository } from "../src/plans/file-repository";
import { createWorkspaceRepositories } from "../src/server/workspace-server";

const roots: string[] = [];
let idCounter = 0;
let timeCounter = 0;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "build-sim-plan-evidence-"));
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), "build-sim-evidence-binding-"));
  roots.push(root, evidenceRoot);
  const evidence = new FileEvidenceRepository({ root: evidenceRoot, now: () => "2026-08-27T00:00:00.000Z" });
  const stored = await evidence.importBuffer(Buffer.from("official N6 manual revision one"), {
    mediaType: "application/pdf",
    kind: "manufacturer-manual",
    title: "JONSBO N6 User Guide",
    productIdentities: [{ brand: "JONSBO", model: "N6", category: "case", skuId: "case.jonsbo-n6" }],
    capture: {
      requestedUrl: "https://www.jonsbo.com/manual-requested.pdf",
      finalUrl: "https://www.jonsbo.com/manual-final.pdf",
      canonicalUrl: "https://www.jonsbo.com/manual.pdf",
      retrievedAt: "2026-08-27T00:00:00.000Z",
      status: 200,
      redirects: ["https://www.jonsbo.com/manual-final.pdf"],
      officialBrand: "JONSBO",
      acquisitionMethod: "official-fetch",
    },
  });
  const plans = new FilePlanRepository({
    root,
    now: () => `2026-08-27T00:00:${String(timeCounter++).padStart(2, "0")}.000Z`,
    id: (prefix) => `${prefix}-${String(idCounter++).padStart(8, "0")}`,
    getEvidenceDocument: (documentId) => evidence.getDocument(documentId),
    getEvidenceCapture: (captureId) => evidence.getCapture(captureId),
  });
  const plan = await plans.create({ name: "Evidence plan", config: createDefaultN6Config("draft", "2026-08-27T00:00:00.000Z") });
  return { root, evidence, stored, plans, plan };
}

function bindInput(
  stored: Awaited<ReturnType<FileEvidenceRepository["importBuffer"]>>,
  overrides: Partial<BindPlanEvidenceInput> = {},
): BindPlanEvidenceInput {
  return {
    expectedRevision: 0,
    documentId: stored.document.id,
    contentHash: stored.document.sha256,
    captureId: stored.capture.id,
    subject: { kind: "case-profile", id: "case.jonsbo-n6" },
    purposes: ["geometry", "compatibility"],
    locators: [{ page: 8, printedPage: "6", section: "Power supply installation" }],
    note: "Rear-upper ATX mounting relation",
    idempotencyKey: "bind-n6-manual-v1",
    ...overrides,
  };
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  idCounter = 0;
  timeCounter = 0;
});

describe("plan evidence bindings", () => {
  it("binds only authoritative document/capture facts with revision and idempotency protection", async () => {
    const { stored, plans, plan } = await fixture();
    const input = {
      ...bindInput(stored),
      title: "client-authored fake title",
      url: "https://attacker.invalid/fake.pdf",
    } as BindPlanEvidenceInput;

    const binding = await plans.bindEvidence(plan.id, input);
    expect(binding).toMatchObject({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      id: expect.stringMatching(/^binding-sha256-[a-f0-9]{64}$/),
      planId: plan.id,
      documentId: stored.document.id,
      contentHash: stored.document.sha256,
      captureId: stored.capture.id,
      subject: { kind: "case-profile", id: "case.jonsbo-n6" },
      purposes: ["geometry", "compatibility"],
    });
    expect(binding).not.toHaveProperty("title");
    expect(binding).not.toHaveProperty("url");
    expect((await plans.get(plan.id)).draftRevision).toBe(1);
    await expect(plans.listEvidenceBindings(plan.id)).resolves.toEqual([binding]);

    await expect(plans.bindEvidence(plan.id, input)).resolves.toEqual(binding);
    expect((await plans.get(plan.id)).draftRevision).toBe(1);
    await expect(plans.bindEvidence(plan.id, { ...input, idempotencyKey: "semantic-replay", note: "A later request cannot create a second edge" })).resolves.toEqual(binding);
    expect((await plans.get(plan.id)).draftRevision).toBe(1);

    await expect(plans.bindEvidence(plan.id, {
      ...input,
      purposes: [...input.purposes].reverse(),
      idempotencyKey: "reordered-semantic-replay",
    })).resolves.toEqual(binding);
    expect((await plans.get(plan.id)).draftRevision).toBe(1);
  });

  it("keeps a stable semantic binding id across removal and a later rebind", async () => {
    const { stored, plans, plan } = await fixture();
    const input = bindInput(stored, { idempotencyKey: "first-bind" });
    const first = await plans.bindEvidence(plan.id, input);
    await plans.unbindEvidence(plan.id, { expectedRevision: 1, bindingId: first.id, idempotencyKey: "remove-first-bind" });
    const second = await plans.bindEvidence(plan.id, { ...input, expectedRevision: 2, idempotencyKey: "later-rebind" });

    expect(second.id).toBe(first.id);
    expect(second.boundAt).not.toBe(first.boundAt);
  });

  it("validates document hashes and capture ownership, while allowing a document-only binding", async () => {
    const { root, evidence, stored, plans, plan } = await fixture();
    const other = await evidence.importBuffer(Buffer.from("another immutable manual"), {
      mediaType: "application/pdf",
      kind: "manufacturer-manual",
      title: "Other manual",
      productIdentities: [{ brand: "JONSBO", model: "Other" }],
      capture: {
        requestedUrl: "https://www.jonsbo.com/other.pdf",
        finalUrl: "https://www.jonsbo.com/other.pdf",
        retrievedAt: "2026-08-27T00:01:00.000Z",
        status: 200,
        redirects: [],
        officialBrand: "JONSBO",
        acquisitionMethod: "official-fetch",
      },
    });
    await expect(plans.bindEvidence(plan.id, bindInput(stored, { captureId: other.capture.id, idempotencyKey: "wrong-capture" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(plans.bindEvidence(plan.id, bindInput(stored, { contentHash: "f".repeat(64), idempotencyKey: "wrong-hash" }))).rejects.toMatchObject({ code: "invalid_input" });
    expect((await plans.get(plan.id)).draftRevision).toBe(0);

    const getEvidenceCapture = vi.fn();
    const documentOnly = new FilePlanRepository({
      root: path.join(root, "document-only"),
      now: () => "2026-08-27T01:00:00.000Z",
      id: (prefix) => `${prefix}-document-only`,
      getEvidenceDocument: () => stored.document,
      getEvidenceCapture,
    });
    const documentPlan = await documentOnly.create({ name: "Document only", config: createDefaultN6Config("draft", "2026-08-27T00:00:00.000Z") });
    const binding = await documentOnly.bindEvidence(documentPlan.id, bindInput(stored, { captureId: undefined, idempotencyKey: "document-only" }));
    expect(binding).not.toHaveProperty("captureId");
    expect(getEvidenceCapture).not.toHaveBeenCalled();

    const poisoned = new FilePlanRepository({
      root: path.join(root, "poisoned"),
      now: () => "2026-08-27T02:00:00.000Z",
      id: (prefix) => `${prefix}-poisoned0`,
      getEvidenceDocument: () => ({ ...stored.document, sha256: "e".repeat(64) }),
    });
    const poisonedPlan = await poisoned.create({ name: "Poisoned", config: createDefaultN6Config("draft", "2026-08-27T00:00:00.000Z") });
    await expect(poisoned.bindEvidence(poisonedPlan.id, bindInput(stored, { captureId: undefined, idempotencyKey: "poisoned" }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("unbinds idempotently without deleting the immutable evidence document", async () => {
    const { evidence, stored, plans, plan } = await fixture();
    const binding = await plans.bindEvidence(plan.id, bindInput(stored));
    const input = { expectedRevision: 1, bindingId: binding.id, idempotencyKey: "unbind-n6-manual-v1" };
    await plans.unbindEvidence(plan.id, input);
    await plans.unbindEvidence(plan.id, input);
    expect((await plans.get(plan.id)).draftRevision).toBe(2);
    await expect(plans.listEvidenceBindings(plan.id)).resolves.toEqual([]);
    await expect(evidence.getDocument(stored.document.id)).resolves.toEqual(stored.document);
    await plans.delete(plan.id);
    await expect(evidence.getDocument(stored.document.id)).resolves.toEqual(stored.document);
  });

  it("pins an immutable evidence snapshot and hash into versions, and duplicates references independently", async () => {
    const { stored, plans, plan } = await fixture();
    const binding = await plans.bindEvidence(plan.id, bindInput(stored));
    const current = await plans.get(plan.id);
    const version = await plans.saveVersion(plan.id, {
      expectedRevision: current.draftRevision,
      expectedConfigHash: await sha256Hex(current.draft.config),
      reason: "manual-save",
      idempotencyKey: "save-with-evidence",
    });
    expect(version.evidenceBindings).toEqual([{ ...binding, planVersionId: version.id }]);
    expect(version.evidenceHash).toBe(await sha256Hex(version.evidenceBindings));

    await plans.unbindEvidence(plan.id, { expectedRevision: current.draftRevision, bindingId: binding.id, idempotencyKey: "unbind-after-save" });
    expect((await plans.listVersions(plan.id))[0]?.evidenceBindings).toEqual(version.evidenceBindings);

    const rebound = await plans.bindEvidence(plan.id, bindInput(stored, { expectedRevision: 2, idempotencyKey: "rebind-for-copy" }));
    const copy = await plans.duplicate(plan.id, { name: "Evidence copy", idempotencyKey: "duplicate-evidence-plan" });
    const copied = await plans.listEvidenceBindings(copy.id);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({
      planId: copy.id,
      documentId: rebound.documentId,
      contentHash: rebound.contentHash,
      captureId: rebound.captureId,
      subject: rebound.subject,
      purposes: rebound.purposes,
    });
    expect(copied[0]?.id).not.toBe(rebound.id);
    const copyVersion = (await plans.listVersions(copy.id))[0]!;
    expect(copyVersion.evidenceBindings?.[0]).toMatchObject({ documentId: rebound.documentId, planId: copy.id, planVersionId: copyVersion.id });
    expect(copyVersion.evidenceHash).toBe(await sha256Hex(copyVersion.evidenceBindings));
  });

  it("reads legacy plan and version records that predate evidence fields", async () => {
    const { root, plans, plan } = await fixture();
    const planFile = path.join(root, plan.id, "plan.json");
    const planEnvelope = JSON.parse(await readFile(planFile, "utf8"));
    delete planEnvelope.payload.draft.evidenceBindings;
    planEnvelope.checksum = checksum(planEnvelope.payload);
    await writeFile(planFile, JSON.stringify(planEnvelope));

    const restarted = new FilePlanRepository({ root });
    const legacy = await restarted.get(plan.id);
    expect(legacy.draft.evidenceBindings).toEqual([]);
    const version = await restarted.saveVersion(plan.id, {
      expectedRevision: legacy.draftRevision,
      expectedConfigHash: await sha256Hex(legacy.draft.config),
      reason: "initial",
    });
    const versionFile = path.join(root, plan.id, "versions", `${version.id}.json`);
    const versionEnvelope = JSON.parse(await readFile(versionFile, "utf8"));
    delete versionEnvelope.payload.evidenceBindings;
    delete versionEnvelope.payload.evidenceHash;
    versionEnvelope.checksum = checksum(versionEnvelope.payload);
    await writeFile(versionFile, JSON.stringify(versionEnvelope));

    const legacyVersions = await new FilePlanRepository({ root }).listVersions(plan.id);
    expect(legacyVersions).toHaveLength(1);
    expect(legacyVersions[0]).not.toHaveProperty("evidenceBindings");
    expect(legacyVersions[0]).not.toHaveProperty("evidenceHash");
  });

  it("wires the production plan repository to the shared configured evidence repository", async () => {
    const planRoot = await mkdtemp(path.join(tmpdir(), "build-sim-workspace-plans-"));
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "build-sim-workspace-evidence-"));
    roots.push(planRoot, evidenceRoot);
    const { repository, evidenceRepository } = createWorkspaceRepositories({
      PLAN_REPOSITORY_ROOT: planRoot,
      EVIDENCE_REPOSITORY_ROOT: evidenceRoot,
    });
    const stored = await evidenceRepository.importBuffer(Buffer.from("workspace production evidence"), {
      mediaType: "application/pdf",
      kind: "manufacturer-manual",
      title: "Workspace manual",
      productIdentities: [{ brand: "JONSBO", model: "N6", category: "case", skuId: "case.jonsbo-n6" }],
      capture: {
        requestedUrl: "https://www.jonsbo.com/workspace.pdf",
        finalUrl: "https://www.jonsbo.com/workspace.pdf",
        retrievedAt: "2026-08-27T03:00:00.000Z",
        status: 200,
        redirects: [],
        officialBrand: "JONSBO",
        acquisitionMethod: "official-fetch",
      },
    });
    const plan = await repository.create({
      name: "Production evidence binding",
      config: createDefaultN6Config("draft", "2026-08-27T03:00:00.000Z"),
    });

    await expect(repository.bindEvidence(plan.id, bindInput(stored, { idempotencyKey: "production-bind" }))).resolves.toMatchObject({
      documentId: stored.document.id,
      captureId: stored.capture.id,
    });
    await expect(new FileEvidenceRepository({ root: evidenceRoot }).getDocument(stored.document.id)).resolves.toEqual(stored.document);
  });

  it("composes production plans and evidence under one active-generation coordinator", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-workspace-runtime-")); roots.push(runtimeRoot);
    const { repository, evidenceRepository, coordinator } = createWorkspaceRepositories({ RUNTIME_ROOT: runtimeRoot });
    expect(coordinator).toBeDefined();
    const stored = await evidenceRepository.importBuffer(Buffer.from("shared generation evidence"), {
      mediaType: "application/pdf",
      kind: "manufacturer-manual",
      title: "Shared runtime manual",
      productIdentities: [{ brand: "JONSBO", model: "N6", category: "case", skuId: "case.jonsbo-n6" }],
      capture: { requestedUrl: "https://www.jonsbo.com/shared-runtime.pdf", finalUrl: "https://www.jonsbo.com/shared-runtime.pdf", retrievedAt: "2026-08-27T03:00:00.000Z", status: 200, redirects: [], officialBrand: "JONSBO", acquisitionMethod: "official-fetch" },
    });
    const plan = await repository.create({ name: "Shared generation plan", config: createDefaultN6Config("draft", "2026-08-27T03:00:00.000Z") });
    await expect(repository.bindEvidence(plan.id, bindInput(stored, { idempotencyKey: "shared-generation-bind" }))).resolves.toMatchObject({ documentId: stored.document.id });
    await expect(readFile(path.join(runtimeRoot, "generations", "1", "plans", plan.id, "plan.json"), "utf8")).resolves.toContain(stored.document.id);
    await expect(readFile(path.join(runtimeRoot, "generations", "1", "evidence", "documents", stored.document.sha256.slice(0, 2), `${stored.document.id}.json`), "utf8")).resolves.toContain(stored.document.id);
  });

  it("fails closed on conflicting active-generation and legacy repository roots", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-workspace-runtime-"));
    const legacyPlanRoot = await mkdtemp(path.join(tmpdir(), "build-sim-workspace-legacy-plans-"));
    roots.push(runtimeRoot, legacyPlanRoot);
    expect(() => createWorkspaceRepositories({ RUNTIME_ROOT: runtimeRoot, PLAN_REPOSITORY_ROOT: legacyPlanRoot })).toThrow(/conflicts with legacy/);
  });
});

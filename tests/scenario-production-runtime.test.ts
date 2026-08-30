import { createCipheriv, scrypt as scryptCallback } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, openBackup, restoreBackup, verifyBackup } from "../src/backup/runtime.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteFile, atomicWriteJson, canonicalJson, confined, readJson, sha256Bytes, sha256Json } from "../src/runtime/fs.mjs";
import {
  applyScenarioTopologyPatchRuntime,
  createScenarioSnapshotSetManifest,
  validateScenarioPatchAuthority,
  validateScenarioRuntimeRecords,
} from "../src/scenarios/runtime-validation.mjs";
import { validatePersistedScenarioBranch, validateWhatIfResult } from "../src/scenarios/contracts";
import { FileScenarioRepository } from "../src/scenarios/repository";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { evidenceBindingIdRuntime, hashPlanConfigRuntime, validatePlanConfigRuntime, validatePlanEvidenceBindingRuntime } from "../src/plans/canonical-runtime.mjs";
import { validateResolvedV3CatalogBindingsRuntime } from "../src/config/v3-catalog-runtime.mjs";
import { loadMergedCatalogSync } from "../scripts/price-server/catalog/repository.mjs";
import { createProductionReferenceGraph } from "../src/runtime/production-reference-graph.mjs";
import { FileEvidenceRepository } from "../src/evidence/repository.mjs";
import { createDefaultN6Config, createEmptyBuildConfig } from "../src/plans/default-plan";
import { serializeConfig } from "../src/config/types";
import { migrateBuildConfigV2ToV3 } from "../src/plans/migration";

const roots: string[] = [];
const digest = (value: string) => value.repeat(64);
const now = "2026-08-27T00:00:00.000Z";
const snapshotHashes = {
  configHash: digest("a"), requirementSpecHash: digest("b"), factSnapshotHash: digest("c"),
  userObservationSnapshotHash: digest("d"), priceSnapshotHash: digest("e"), ruleSetHash: digest("f"),
  systemProfileHash: digest("1"), adapterSnapshotHash: digest("2"), engineHash: digest("3"),
  simulationModelHash: digest("4"), simulationInputHash: digest("5"),
};

function stored(kind: "family" | "branch" | "result", payload: unknown) {
  return { schemaVersion: "scenario-repository-envelope-v1", kind, checksum: sha256Json(payload), payload };
}
function record(rootLogicalPath: string, value: unknown) {
  return { rootLogicalPath, value };
}
function context() { return { nodes: [] as string[], edges: [] as Array<{ fromRef: string; toRef: string; necessity: string }>, pointers: [] as string[] }; }
async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "buildsim-scenario-production-")); roots.push(root);
  const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
  return { root, coordinator, activeRoot: coordinator.activeRoot(await coordinator.readState()) };
}

async function rewriteBackupJsonAuthority(
  inputFile: string,
  outputFile: string,
  password: string,
  logicalPath: string,
  mutatePayload: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const opened = await openBackup(inputFile, password);
  const inner = structuredClone(opened.inner);
  const file = inner.files.find((item: { logicalPath: string }) => item.logicalPath === logicalPath);
  if (!file) throw new Error(`backup fixture authority is missing: ${logicalPath}`);
  const envelope = JSON.parse(Buffer.from(file.dataBase64, "base64").toString("utf8"));
  mutatePayload(envelope.payload);
  envelope.checksum = sha256Json(envelope.payload);
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  file.dataBase64 = bytes.toString("base64");
  const entry = inner.manifest.entries.find((item: { logicalPath: string }) => item.logicalPath === logicalPath);
  if (!entry) throw new Error("lineage backup fixture manifest entry is missing");
  entry.byteLength = bytes.length;
  entry.sha256 = sha256Bytes(bytes);
  const { manifestHash: _oldManifestHash, ...manifestMaterial } = inner.manifest;
  inner.manifest.manifestHash = sha256Bytes(Buffer.from(
    `buildsim\0hash-spec-v1\0backup-manifest\0backup-v1\0${canonicalJson(manifestMaterial).normalize("NFC")}`,
    "utf8",
  ));

  const encryption = opened.envelope.encryption;
  const { authTagBase64: _oldTag, aadSha256: _oldAadHash, ...publicParameters } = encryption;
  const aad = Buffer.from(canonicalJson({
    formatVersion: "buildsim-backup-envelope-v1",
    manifestHash: inner.manifest.manifestHash,
    encryption: publicParameters,
  }).normalize("NFC"), "utf8");
  const salt = Buffer.from(encryption.kdfParams.saltBase64, "base64");
  const nonce = Buffer.from(encryption.nonceBase64, "base64");
  const key = await new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, 32, {
    N: encryption.kdfParams.n, r: encryption.kdfParams.r, p: encryption.kdfParams.p, maxmem: 64 * 1024 * 1024,
  }, (error, derived) => error ? reject(error) : resolve(Buffer.from(derived))));
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalJson(inner).normalize("NFC"), "utf8")), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally {
    key.fill(0);
  }
  const nextEnvelope = {
    ...opened.envelope,
    manifestHash: inner.manifest.manifestHash,
    payloadSha256: sha256Bytes(ciphertext),
    encryption: { ...publicParameters, authTagBase64: tag.toString("base64"), aadSha256: sha256Bytes(aad) },
  };
  await atomicWriteFile(outputFile, `${JSON.stringify({
    schemaVersion: "buildsim-backup-package-v1", envelope: nextEnvelope, ciphertextBase64: ciphertext.toString("base64"),
  })}\n`, { mode: 0o600 });
}

async function rewriteBackupWithReverseLineage(inputFile: string, outputFile: string, password: string): Promise<void> {
  await rewriteBackupJsonAuthority(
    inputFile,
    outputFile,
    password,
    "plans/plan-owner-alpha/versions/version-owner-alpha-1.json",
    (payload) => { payload.versionNumber = 2; },
  );
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U2 scenario production authority", () => {
  it("accepts a domain-hashed V3 plan with a replayable scenario closure", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const planId = "plan-scenario"; const versionId = "version-scenario";
    const config = createEmptyBuildConfigV3(planId, "Blank", now);
    const configHash = hashPlanConfigRuntime(config);
    const version = {
      schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: now,
      reason: "initial", config, configHash, parentVersionId: null,
    };
    const plan = {
      schemaVersion: "1.0.0", id: planId, name: "Scenario plan", status: "active", createdAt: now, updatedAt: now,
      activeVersionId: versionId, draftRevision: 0,
      draft: { schemaVersion: "1.0.0", baseVersionId: versionId, config, evidenceBindings: [], dirty: false, updatedAt: now }, metadata: {},
    };
    await atomicWriteJson(confined(activeRoot, "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
    await atomicWriteJson(confined(activeRoot, "plans", planId, "versions", `${versionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(version), payload: version });
    const boundSnapshots = { ...snapshotHashes, configHash };
    const repository = new FileScenarioRepository({
      coordinator,
      resolveBaseAtRoot: async (root, requested) => requested === versionId
        ? { planId, planVersionId: versionId, config: structuredClone(config), configHash, snapshotHashes: structuredClone(boundSnapshots) } : null,
      now: () => now,
    });
    const family = await repository.createFamily({ familyId: "family-production", planId, name: "Production", basePlanVersionId: versionId, baseConfigHash: configHash, baseSnapshotHashes: boundSnapshots });
    const branch = await repository.createBranch({ scenarioId: "scenario-production", familyId: "family-production", patch: [{ op: "replace", selector: { collection: "config", field: "name" }, value: "Scenario only" }] });
    await expect(repository.saveResult("scenario-production")).rejects.toMatchObject({ code: "evaluation_authority_unavailable" });
    const graph = await createProductionReferenceGraph({ coordinator, now: () => now });
    expect(graph.edges).toEqual(expect.arrayContaining([
      { fromRef: "scenario-family:family-production", toRef: `plan-version:${versionId}`, necessity: "required_for_replay" },
      { fromRef: "scenario-branch:scenario-production", toRef: "scenario-family:family-production", necessity: "required_for_replay" },
    ]));
    const cleanBackup = path.join(root, "v3-scenario-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });
    const opaqueResult = {
      schemaVersion: "1.0.0", createdAt: now, scenarioId: branch.scenarioId,
      beforeConfigHash: branch.baseConfigHash, afterConfigHash: branch.materializedConfigHash, patchHash: branch.patchHash,
      beforeEvaluationHash: digest("8"), afterEvaluationHash: digest("9"), decisionDiffRef: `sha256:${digest("6")}`,
      domainDiffRefs: [`sha256:${digest("7")}`], snapshotAttribution: "same_snapshots",
    };
    const opaqueResultFile = confined(activeRoot, "scenarios", "results", `${branch.scenarioId}.json`);
    await atomicWriteJson(opaqueResultFile, stored("result", opaqueResult));
    await expect(createBackup({ coordinator, outputFile: path.join(root, "opaque-result.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/result authority is unavailable/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });
    await rm(opaqueResultFile);
    const beforeOpaqueRestore = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => atomicWriteJson(
        confined(staging, "scenarios", "results", `${branch.scenarioId}.json`), stored("result", opaqueResult),
      ),
    })).rejects.toThrow(/result authority is unavailable/);
    expect(await coordinator.readState()).toEqual(beforeOpaqueRestore);
    const branchFile = confined(activeRoot, "scenarios", "branches", "scenario-production.json");
    const forged = await readJson(branchFile);
    forged.payload.materializedConfigHash = digest("0"); forged.checksum = sha256Json(forged.payload);
    await atomicWriteJson(branchFile, forged);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "v3-scenario-forged.backup"), password: "a sufficiently long password" })).rejects.toThrow(/materialized config hash is forged or stale/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
    const beforeRestore = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        const stagedFile = confined(staging, "scenarios", "branches", "scenario-production.json");
        const staged = await readJson(stagedFile); staged.payload.materializedConfigHash = digest("0"); staged.checksum = sha256Json(staged.payload);
        await atomicWriteJson(stagedFile, staged);
      },
    })).rejects.toThrow(/materialized config hash is forged or stale/);
    expect(await coordinator.readState()).toEqual(beforeRestore);
  });

  it("emits required family/base/branch/diff closure edges and rejects cross-runtime false-green corpus", async () => {
    const family = {
      schemaVersion: "1.0.0", familyId: "family-runtime", planId: "plan-runtime", name: "Runtime",
      basePlanVersionId: "version-runtime", baseConfigHash: digest("a"), baseSnapshotHashes: snapshotHashes,
      createdAt: now, updatedAt: now,
    };
    const branchPatch = [{ op: "add", selector: { collection: "components", id: "gpu-runtime" }, value: {
      instanceId: "gpu-runtime", kind: "gpu", role: "discrete_gpu", state: "planned",
      identity: { status: "unresolved", userText: "Agent proposal" }, source: "agent",
    } }];
    const branch = {
      schemaVersion: "1.0.0", createdByActor: "agent", createdAt: now,
      patchHash: sha256Json({ patch: branchPatch, simulationInputPatch: [] }), materializedConfigHash: digest("0"),
      scenarioId: "scenario-runtime", familyId: "family-runtime", basePlanVersionId: "version-runtime",
      baseConfigHash: digest("a"), baseSnapshotHashes: snapshotHashes,
      patch: branchPatch,
    };
    const result = {
      schemaVersion: "1.0.0", createdAt: now, scenarioId: "scenario-runtime",
      beforeConfigHash: digest("a"), afterConfigHash: digest("0"), patchHash: branch.patchHash,
      beforeEvaluationHash: sha256Json({ score: 6 }), afterEvaluationHash: sha256Json({ score: 7 }),
      decisionDiffRef: `sha256:${digest("8")}`, domainDiffRefs: [`sha256:${digest("9")}`], snapshotAttribution: "same_snapshots",
    };
    const graph = context();
    const snapshotManifest = createScenarioSnapshotSetManifest(snapshotHashes);
    await validateScenarioRuntimeRecords([
      record(`snapshots/${snapshotManifest.snapshotSetId}.json`, snapshotManifest),
      record("families/family-runtime.json", stored("family", family)),
      record("branches/scenario-runtime.json", stored("branch", branch)),
    ], graph);
    expect(graph.edges).toEqual(expect.arrayContaining([
      { fromRef: "scenario-branch:scenario-runtime", toRef: "scenario-family:family-runtime", necessity: "required_for_replay" },
      { fromRef: "scenario-branch:scenario-runtime", toRef: "plan-version:version-runtime", necessity: "required_for_replay" },
    ]));
    await expect(validateScenarioRuntimeRecords([
      record("results/scenario-runtime.json", stored("result", result)),
    ], context())).rejects.toThrow(/result authority is unavailable/);

    const hacked = { ...branch, patch: [{ hacked: true }] };
    expect(validatePersistedScenarioBranch(hacked)).not.toEqual([]);
    await expect(validateScenarioRuntimeRecords([record("branches/scenario-runtime.json", stored("branch", hacked))], context())).rejects.toThrow(/branch payload/);
    const invalidPatches = [
      [{ op: "add", selector: { collection: "components", id: "evil" }, value: { instanceId: "evil", kind: "evil_kind", role: "gpu", state: "planned", identity: { status: "unresolved", userText: "evil" }, source: "agent" } }],
      [{ op: "add", selector: { collection: "firmwareTargets", id: "board-1" }, value: { instanceId: "board-1", targetReleaseFactId: "release", requestedSettings: [{ settingId: "evil", desiredValue: "invented" }], source: "system_requirement" } }],
      [{ op: "replace", selector: { collection: "config", field: "requirementSpec" }, value: { requirementSpecId: "req-1", schemaVersion: "1.0.0", budget: { hacked: true }, workloads: [], constraints: [] } }],
      [{ op: "replace", selector: { collection: "config", field: "requirementSpec" }, value: {
        requirementSpecId: "req-1", schemaVersion: "1.0.0", workloads: [{ workloadId: "workload-1", name: "Bad metric", metrics: [{ metricId: "evil", operator: "gte", value: 1, unitId: "count", priority: "must" }], evidenceOrBenchmarkRefs: [] }], constraints: [],
      } }],
      [{ op: "replace", selector: { collection: "config", field: "requirementSpec" }, value: {
        requirementSpecId: "req-1", schemaVersion: "1.0.0", workloads: [], constraints: [{
          constraintId: "bad-facet", predicate: { facetId: "case.side_panel", operator: "gte", value: 42, unitId: "mm" },
          strength: "hard", source: "user", confirmedByUser: true,
        }],
      } }],
    ];
    for (const patch of invalidPatches) {
      const forged = { ...branch, patch, patchHash: sha256Json({ patch, simulationInputPatch: [] }) };
      expect(validatePersistedScenarioBranch(forged)).not.toEqual([]);
      await expect(validateScenarioRuntimeRecords([record("branches/scenario-runtime.json", stored("branch", forged))], context())).rejects.toThrow(/branch payload/);
    }
    const actorProvenancePatches = [
      [{ op: "add", selector: { collection: "components", id: "gpu-migration" }, value: {
        instanceId: "gpu-migration", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "proposal" }, source: "migration",
      } }],
      [{ op: "replace", selector: { collection: "config", field: "intent" }, value: {
        state: "answered", value: "nas", source: "defaulted", confirmedByUser: false,
      } }],
      [{ op: "replace", selector: { collection: "config", field: "requirementSpec" }, value: {
        requirementSpecId: "req-migration", schemaVersion: "1.0.0", workloads: [], constraints: [{
          constraintId: "constraint-migration", predicate: { facetId: "case.side_panel", operator: "eq", value: "mesh", unitId: null },
          strength: "hard", source: "migration", confirmedByUser: false,
        }],
      } }],
      [{ op: "add", selector: { collection: "firmwareTargets", id: "board-1" }, value: {
        instanceId: "board-1", targetReleaseFactId: "release-1", requestedSettings: [], source: "system_requirement",
      } }],
      [{ op: "replace", selector: { collection: "config", field: "system" }, value: {
        profileId: "system.linux-desktop", versionFactId: "release-1", source: "defaulted", lockedByUser: false,
      } }],
    ];
    const agentProposedRequirement = [{
      op: "replace", selector: { collection: "config", field: "intent" },
      value: { state: "answered", value: "nas", source: "agent_proposed", confirmedByUser: false },
    }];
    expect(validateScenarioPatchAuthority(agentProposedRequirement, undefined, "agent")).toEqual([]);
    expect(validateScenarioPatchAuthority([{
      op: "replace", selector: { collection: "config", field: "intent" },
      value: { state: "answered", value: "nas", source: "user", confirmedByUser: true },
    }], undefined, "user")).toEqual([]);
    expect(validateScenarioPatchAuthority([{
      op: "replace", selector: { collection: "config", field: "intent" },
      value: { state: "answered", value: "nas", source: "defaulted", confirmedByUser: false },
    }], undefined, "system")).toEqual([]);
    expect(validateScenarioPatchAuthority([{
      op: "add", selector: { collection: "firmwareTargets", id: "board-1" },
      value: { instanceId: "board-1", targetReleaseFactId: "release-1", requestedSettings: [], source: "system_requirement" },
    }], undefined, "system")).toEqual([]);
    expect(validateScenarioPatchAuthority([{
      op: "replace", selector: { collection: "config", field: "system" },
      value: { profileId: "system.truenas-scale", versionFactId: "system-release.truenas-scale.25.04", source: "defaulted", lockedByUser: false },
    }], undefined, "system")).toEqual([]);
    for (const actor of ["agent", "solver"] as const) for (const patch of actorProvenancePatches) {
      const forged = {
        ...branch, createdByActor: actor, patch,
        patchHash: sha256Json({ patch, simulationInputPatch: [] }),
      };
      expect(validatePersistedScenarioBranch(forged)).not.toEqual([]);
      await expect(validateScenarioRuntimeRecords([record("branches/scenario-runtime.json", stored("branch", forged))], context()))
        .rejects.toThrow(/branch payload/);
    }
    const spoofedByUserOrSystem = [
      ["user", actorProvenancePatches[0]],
      ["user", actorProvenancePatches[1]],
      ["user", actorProvenancePatches[3]],
      ["user", actorProvenancePatches[4]],
      ["system", [{ op: "add", selector: { collection: "components", id: "gpu-system" }, value: {
        instanceId: "gpu-system", kind: "gpu", role: "discrete_gpu", state: "planned",
        identity: { status: "unresolved", userText: "proposal" }, source: "agent",
      } }]],
      ["system", [{ op: "replace", selector: { collection: "config", field: "name" }, value: "system-spoof" }]],
      ["system", [{ op: "replace", selector: { collection: "config", field: "intent" }, value: {
        state: "answered", value: "nas", source: "user", confirmedByUser: true,
      } }]],
      ["system", [{ op: "add", selector: { collection: "firmwareTargets", id: "board-1" }, value: {
        instanceId: "board-1", targetReleaseFactId: "release-1", requestedSettings: [], source: "user",
      } }]],
    ] as const;
    for (const [actor, patch] of spoofedByUserOrSystem) {
      expect(validateScenarioPatchAuthority(patch, undefined, actor)).not.toEqual([]);
    }
    const badSimulation = {
      ...branch, patch: [], simulationInputPatch: [{ op: "replace", path: "/storageActivity/0/dutyCycle", value: 9 }],
      patchHash: sha256Json({ patch: [], simulationInputPatch: [{ op: "replace", path: "/storageActivity/0/dutyCycle", value: 9 }] }),
    };
    expect(validatePersistedScenarioBranch(badSimulation)).not.toEqual([]);
    await expect(validateScenarioRuntimeRecords([record("branches/scenario-runtime.json", stored("branch", badSimulation))], context())).rejects.toThrow(/branch payload/);
    for (const simulationInputPatch of [
      [{ op: "replace", path: "/ambientC", value: { min: 99, max: -99 } }],
      [{ op: "replace", path: "/storageActivity/0", value: { hacked: true } }],
    ]) {
      const forged = { ...branch, patch: [], simulationInputPatch, patchHash: sha256Json({ patch: [], simulationInputPatch }) };
      expect(validatePersistedScenarioBranch(forged)).not.toEqual([]);
      await expect(validateScenarioRuntimeRecords([record("branches/scenario-runtime.json", stored("branch", forged))], context())).rejects.toThrow(/branch payload/);
    }
    expect(validateWhatIfResult({ ...result, schemaVersion: undefined, createdAt: undefined, decisionDiffRef: "../../secret", domainDiffRefs: ["\n"] })).not.toEqual([]);
    await expect(validateScenarioRuntimeRecords([record("results/scenario-runtime.json", stored("result", { ...result, decisionDiffRef: "../../secret", domainDiffRefs: ["\n"] }))], context())).rejects.toThrow(/result authority is unavailable/);
  });

  it("blocks backup and Doctor on unknown, symlinked, corrupt, and dangling scenario authority", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const scenarioRoot = confined(activeRoot, "scenarios");
    const backupFile = path.join(root, "forged.backup");

    const unknown = confined(scenarioRoot, "unknown.json");
    await atomicWriteJson(unknown, { schemaVersion: "unknown" });
    await expect(createBackup({ coordinator, outputFile: backupFile, password: "a sufficiently long password" })).rejects.toThrow(/unrecognized authority path/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
    await rm(unknown);

    const corruptFamily = confined(scenarioRoot, "families", "family-corrupt.json");
    await atomicWriteJson(corruptFamily, { schemaVersion: "scenario-repository-envelope-v1", kind: "family", checksum: digest("0"), payload: {} });
    await expect(createBackup({ coordinator, outputFile: backupFile, password: "a sufficiently long password" })).rejects.toThrow(/envelope\/checksum/);
    await rm(corruptFamily);

    const evilPatch = [{ op: "replace", selector: { collection: "config", field: "requirementSpec" }, value: {
      requirementSpecId: "req-evil", schemaVersion: "1.0.0", workloads: [], constraints: [{
        constraintId: "bad-facet", predicate: { facetId: "case.side_panel", operator: "gte", value: 42, unitId: "mm" },
        strength: "hard", source: "user", confirmedByUser: true,
      }],
    } }];
    const forgedBranch = {
      schemaVersion: "1.0.0", createdByActor: "agent", createdAt: now,
      patchHash: sha256Json({ patch: evilPatch, simulationInputPatch: [] }), materializedConfigHash: digest("6"),
      scenarioId: "scenario-evil", familyId: "family-evil", basePlanVersionId: "version-evil",
      baseConfigHash: digest("a"), baseSnapshotHashes: snapshotHashes, patch: evilPatch,
    };
    const evilFile = confined(scenarioRoot, "branches", "scenario-evil.json");
    await atomicWriteJson(evilFile, stored("branch", forgedBranch));
    await expect(createBackup({ coordinator, outputFile: backupFile, password: "a sufficiently long password" })).rejects.toThrow(/branch payload/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
    await rm(evilFile);

    const target = confined(root, "outside-scenario.json"); await atomicWriteJson(target, { private: true });
    const linked = confined(scenarioRoot, "families", "family-linked.json"); await symlink(target, linked);
    await expect(createBackup({ coordinator, outputFile: backupFile, password: "a sufficiently long password" })).rejects.toThrow(/symbolic link/);
    await rm(linked);

    const family = {
      schemaVersion: "1.0.0", familyId: "family-dangling", planId: "plan-missing", name: "Dangling",
      basePlanVersionId: "version-missing", baseConfigHash: digest("a"), baseSnapshotHashes: snapshotHashes,
      createdAt: now, updatedAt: now,
    };
    const dangling = confined(scenarioRoot, "families", "family-dangling.json"); await atomicWriteJson(dangling, stored("family", family));
    const danglingManifest = createScenarioSnapshotSetManifest(family.baseSnapshotHashes);
    await atomicWriteJson(confined(scenarioRoot, "snapshots", `${danglingManifest.snapshotSetId}.json`), danglingManifest);
    await expect(createBackup({ coordinator, outputFile: backupFile, password: "a sufficiently long password" })).rejects.toThrow(/missing, stale, or hash-mismatched/);
  });

  it("revalidates restored staging scenario authorities before pointer commit", async () => {
    const { root, coordinator } = await runtime();
    const backupFile = path.join(root, "clean.backup");
    await createBackup({ coordinator, outputFile: backupFile, password: "a sufficiently long password" });
    const before = await coordinator.readState();
    const badPatch = [{ op: "add", selector: { collection: "components", id: "gpu-stage" }, value: {
      instanceId: "gpu-stage", kind: "gpu", role: "discrete_gpu", state: "planned",
      identity: { status: "unresolved", userText: "proposal" }, source: "migration",
    } }];
    const forgedBranch = {
      schemaVersion: "1.0.0", createdByActor: "agent", createdAt: now,
      patchHash: sha256Json({ patch: badPatch, simulationInputPatch: [] }), materializedConfigHash: digest("6"),
      scenarioId: "scenario-stage", familyId: "family-stage", basePlanVersionId: "version-stage",
      baseConfigHash: digest("a"), baseSnapshotHashes: snapshotHashes, patch: badPatch,
    };
    await expect(restoreBackup({
      coordinator, inputFile: backupFile, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => atomicWriteJson(confined(staging, "scenarios", "branches", "scenario-stage.json"), stored("branch", forgedBranch)),
    })).rejects.toThrow(/scenario branch payload/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("routes V3 draft semantics and migration source closure through backup, Doctor, and restore", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const cleanBackup = path.join(root, "plan-semantic-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });
    const planId = "plan-forged-v3";
    const invalidConfig = createEmptyBuildConfigV3(planId, "Invalid", now);
    invalidConfig.requirementSpec = {
      requirementSpecId: "requirements-forged", schemaVersion: "1.0.0", workloads: [],
      constraints: [{
        constraintId: "constraint-forged", predicate: { facetId: "case.side_panel", operator: "gte", value: 42, unitId: "mm" },
        strength: "hard", source: "user", confirmedByUser: true,
      }],
    };
    const planPayload = (config: unknown, configMigration?: unknown) => ({
      schemaVersion: "1.0.0", id: planId, name: "Forged", status: "active", createdAt: now, updatedAt: now,
      activeVersionId: null, draftRevision: 0,
      draft: { schemaVersion: "1.0.0", baseVersionId: null, config, ...(configMigration ? { configMigration } : {}), evidenceBindings: [], dirty: true, updatedAt: now }, metadata: {},
    });
    const writePlan = async (rootPath: string, payload: unknown) => atomicWriteJson(confined(rootPath, "plans", planId, "plan.json"), {
      schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(payload), payload,
    });
    await writePlan(activeRoot, planPayload(invalidConfig));
    await expect(createBackup({ coordinator, outputFile: path.join(root, "invalid-v3.backup"), password: "a sufficiently long password" })).rejects.toThrow(/plan authority payload/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes")).toMatchObject({ status: "fail" });
    await rm(confined(activeRoot, "plans", planId), { recursive: true });

    const validConfig = createEmptyBuildConfigV3(planId, "Missing migration source", now);
    const migration = {
      schemaVersion: "plan-config-migration-v1", sourceSchemaVersion: "2.0.0", targetSchemaVersion: "3.0.0",
      sourceVersionId: "version-missing", sourceConfigHash: digest("1"), migratedAt: now, diff: [], warnings: [],
      rollbackRef: { schemaVersion: "build-config-v2-rollback-ref-v1", configId: planId, sourceSchemaVersion: "2.0.0", sourceHash: digest("2"), sourceByteLength: 1 },
    };
    await writePlan(activeRoot, planPayload(validConfig, migration));
    await expect(createBackup({ coordinator, outputFile: path.join(root, "missing-source.backup"), password: "a sufficiently long password" })).rejects.toThrow(/plan authority payload/);
    await rm(confined(activeRoot, "plans", planId), { recursive: true });

    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => writePlan(staging, planPayload(invalidConfig)),
    })).rejects.toThrow(/plan authority payload/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("binds resolved V3 draft and version identities to the active merged catalog", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const cleanBackup = path.join(root, "catalog-binding-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });
    const planId = "plan-catalog-forged";
    const versionId = "version-catalog-forged";
    const validConfig = createEmptyBuildConfigV3(planId, "Catalog binding", now);
    const forgedConfig = structuredClone(validConfig);
    forgedConfig.components.push({
      instanceId: "nic-forged", kind: "nic", role: "network_adapter", state: "planned", source: "user",
      identity: { status: "resolved", skuId: "case.jonsbo-n6", identityClaimIds: ["claim-forged"] },
    });
    expect(validatePlanConfigRuntime(forgedConfig, { topologyV3Enabled: true })).toEqual([]);
    expect(validateResolvedV3CatalogBindingsRuntime(
      forgedConfig,
      loadMergedCatalogSync({ activeRoot, generationAware: true }),
    )).toEqual([expect.objectContaining({ path: "components.0.kind" })]);
    const writeAuthorities = async (rootPath: string, draftConfig: unknown, versionConfig?: typeof forgedConfig) => {
      const plan = {
        schemaVersion: "1.0.0", id: planId, name: "Catalog binding", status: "active", createdAt: now, updatedAt: now,
        activeVersionId: versionConfig ? versionId : null, draftRevision: 0,
        draft: {
          schemaVersion: "1.0.0", baseVersionId: versionConfig ? versionId : null,
          config: draftConfig, evidenceBindings: [], dirty: Boolean(versionConfig), updatedAt: now,
        },
        metadata: {},
      };
      await atomicWriteJson(confined(rootPath, "plans", planId, "plan.json"), {
        schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan,
      });
      if (versionConfig) {
        const version = {
          schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: now,
          reason: "manual-save", config: versionConfig, configHash: hashPlanConfigRuntime(versionConfig), parentVersionId: null,
        };
        await atomicWriteJson(confined(rootPath, "plans", planId, "versions", `${versionId}.json`), {
          schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(version), payload: version,
        });
      }
    };

    await writeAuthorities(activeRoot, forgedConfig);
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "forged-draft-catalog.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/plan authority payload/);
    await rm(confined(activeRoot, "plans", planId), { recursive: true });

    await writeAuthorities(activeRoot, validConfig, forgedConfig);
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "forged-version-catalog.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/plan version payload\/hash/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });

    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => writeAuthorities(staging, validConfig, forgedConfig),
    })).rejects.toThrow(/plan version payload\/hash/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("requires active, base, and parent versions to exist under the same plan without cycles", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const cleanBackup = path.join(root, "plan-owner-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });
    const planA = "plan-owner-alpha"; const planB = "plan-owner-beta";
    const a1 = "version-owner-alpha-1"; const a2 = "version-owner-alpha-2"; const b1 = "version-owner-beta-1";
    const configA = createEmptyBuildConfigV3(planA, "Alpha", now);
    const configB = createEmptyBuildConfigV3(planB, "Beta", now);
    const writeOwnerFixture = async (rootPath: string, options: {
      activeA?: string; baseA?: string; parentA1?: string | null; parentA2?: string | null;
      versionNumberA1?: number; versionNumberA2?: number;
    } = {}) => {
      const versions = [
        { id: a1, planId: planA, versionNumber: options.versionNumberA1 ?? 1, config: configA, parentVersionId: options.parentA1 ?? null },
        { id: a2, planId: planA, versionNumber: options.versionNumberA2 ?? 2, config: configA, parentVersionId: options.parentA2 === undefined ? a1 : options.parentA2 },
        { id: b1, planId: planB, versionNumber: 1, config: configB, parentVersionId: null },
      ];
      for (const value of versions) {
        const version = {
          schemaVersion: "1.0.0", ...value, createdAt: now, reason: "manual-save",
          configHash: hashPlanConfigRuntime(value.config),
        };
        await atomicWriteJson(confined(rootPath, "plans", value.planId, "versions", `${value.id}.json`), {
          schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(version), payload: version,
        });
      }
      for (const [id, name, config, activeVersionId, baseVersionId] of [
        [planA, "Alpha", configA, options.activeA ?? a2, options.baseA ?? a2],
        [planB, "Beta", configB, b1, b1],
      ] as const) {
        const plan = {
          schemaVersion: "1.0.0", id, name, status: "active", createdAt: now, updatedAt: now,
          activeVersionId, draftRevision: 0,
          draft: { schemaVersion: "1.0.0", baseVersionId, config, evidenceBindings: [], dirty: false, updatedAt: now },
          metadata: {},
        };
        await atomicWriteJson(confined(rootPath, "plans", id, "plan.json"), {
          schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan,
        });
      }
    };

    await writeOwnerFixture(activeRoot, { activeA: b1 });
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "cross-plan-active.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/plan authority payload/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });

    for (const options of [
      { parentA2: "version-owner-missing" },
      { parentA2: b1 },
      { parentA2: a2 },
      { parentA1: a2, parentA2: a1 },
    ]) {
      await writeOwnerFixture(activeRoot, options);
      await expect(createProductionReferenceGraph({ coordinator, now: () => now })).rejects.toThrow(/plan version payload\/hash|parent graph contains a cycle/);
    }

    await writeOwnerFixture(activeRoot, { versionNumberA1: 2, versionNumberA2: 1 });
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "reverse-version-lineage.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/plan version payload\/hash/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });
    await writeOwnerFixture(activeRoot);
    const validLineageBackup = path.join(root, "valid-version-lineage.backup");
    const forgedLineageBackup = path.join(root, "forged-version-lineage.backup");
    await createBackup({ coordinator, outputFile: validLineageBackup, password: "a sufficiently long password" });
    await rewriteBackupWithReverseLineage(validLineageBackup, forgedLineageBackup, "a sufficiently long password");
    await expect(verifyBackup({ inputFile: forgedLineageBackup, password: "a sufficiently long password" }))
      .rejects.toThrow(/plan version payload\/hash/);

    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => writeOwnerFixture(staging, { baseA: b1 }),
    })).rejects.toThrow(/plan authority payload/);
    expect(await coordinator.readState()).toEqual(before);

    const beforeReverseLineage = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => writeOwnerFixture(staging, { versionNumberA1: 2, versionNumberA2: 1 }),
    })).rejects.toThrow(/plan version payload\/hash/);
    expect(await coordinator.readState()).toEqual(beforeReverseLineage);
  });

  it("validates materialized scenario topology and resolved catalog identity before backup or restore", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const cleanBackup = path.join(root, "scenario-final-state-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });
    const planId = "plan-final-state"; const versionId = "version-final-state";
    const familyId = "family-final-state"; const scenarioId = "scenario-final-state";
    const writeClosure = async (rootPath: string, baseConfig: ReturnType<typeof createEmptyBuildConfigV3>, patch: unknown[]) => {
      const configHash = hashPlanConfigRuntime(baseConfig);
      const version = {
        schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: now,
        reason: "manual-save", config: baseConfig, configHash, parentVersionId: null,
      };
      const plan = {
        schemaVersion: "1.0.0", id: planId, name: "Final state", status: "active", createdAt: now, updatedAt: now,
        activeVersionId: versionId, draftRevision: 0,
        draft: { schemaVersion: "1.0.0", baseVersionId: versionId, config: baseConfig, evidenceBindings: [], dirty: false, updatedAt: now },
        metadata: {},
      };
      await atomicWriteJson(confined(rootPath, "plans", planId, "plan.json"), storedPlan("plan", plan));
      await atomicWriteJson(confined(rootPath, "plans", planId, "versions", `${versionId}.json`), storedPlan("version", version));
      const hashes = { ...snapshotHashes, configHash };
      const family = {
        schemaVersion: "1.0.0", familyId, planId, name: "Final state", basePlanVersionId: versionId,
        baseConfigHash: configHash, baseSnapshotHashes: hashes, createdAt: now, updatedAt: now,
      };
      const snapshotManifest = createScenarioSnapshotSetManifest(hashes);
      const materialized = applyScenarioTopologyPatchRuntime(baseConfig, patch);
      const branch = {
        schemaVersion: "1.0.0", createdByActor: "user", createdAt: now,
        patchHash: sha256Json({ patch, simulationInputPatch: [] }), materializedConfigHash: hashPlanConfigRuntime(materialized),
        scenarioId, familyId, basePlanVersionId: versionId, baseConfigHash: configHash, baseSnapshotHashes: hashes, patch,
      };
      await atomicWriteJson(confined(rootPath, "scenarios", "families", `${familyId}.json`), stored("family", family));
      await atomicWriteJson(confined(rootPath, "scenarios", "branches", `${scenarioId}.json`), stored("branch", branch));
      await atomicWriteJson(confined(rootPath, "scenarios", "snapshots", `${snapshotManifest.snapshotSetId}.json`), snapshotManifest);
      return materialized;
    };
    const storedPlan = (kind: "plan" | "version", payload: unknown) => ({
      schemaVersion: "1.0.0", kind, checksum: sha256Json(payload), payload,
    });

    const referencedBase = createEmptyBuildConfigV3(planId, "Dangling", now);
    referencedBase.components = [
      { instanceId: "case-1", kind: "case", role: "case", state: "planned", identity: { status: "unresolved", userText: "case" }, source: "user" },
      { instanceId: "gpu-1", kind: "gpu", role: "discrete_gpu", state: "planned", identity: { status: "unresolved", userText: "gpu" }, source: "user" },
    ];
    referencedBase.placements = [{ placementId: "placement-gpu", componentInstanceId: "gpu-1", mountOwnerInstanceId: "case-1", mountId: "slot-1" }];
    const danglingPatch = [{ op: "remove", selector: { collection: "components", id: "gpu-1" } }];
    const dangling = await writeClosure(activeRoot, referencedBase, danglingPatch);
    expect(validatePlanConfigRuntime(dangling, { topologyV3Enabled: true })).not.toEqual([]);
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "scenario-dangling.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/materialized config is semantically invalid/);
    await rm(confined(activeRoot, "plans", planId), { recursive: true });
    await rm(confined(activeRoot, "scenarios"), { recursive: true });

    const catalogBase = createEmptyBuildConfigV3(planId, "Wrong catalog", now);
    const wrongCatalogPatch = [{ op: "add", selector: { collection: "components", id: "nic-forged" }, value: {
      instanceId: "nic-forged", kind: "nic", role: "network_adapter", state: "planned",
      identity: { status: "resolved", skuId: "case.jonsbo-n6", identityClaimIds: ["claim-forged"] }, source: "user",
    } }];
    const wrongCatalog = await writeClosure(activeRoot, catalogBase, wrongCatalogPatch);
    expect(validatePlanConfigRuntime(wrongCatalog, { topologyV3Enabled: true })).toEqual([]);
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "scenario-wrong-catalog.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/resolved identity is not proven/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });

    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => { await writeClosure(staging, catalogBase, wrongCatalogPatch); },
    })).rejects.toThrow(/resolved identity is not proven/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("requires a content-addressed snapshot-set manifest for every scenario family", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const planId = "plan-snapshot-set"; const versionId = "version-snapshot-set";
    const config = createEmptyBuildConfigV3(planId, "Snapshot set", now);
    const configHash = hashPlanConfigRuntime(config);
    const version = {
      schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: now,
      reason: "manual-save", config, configHash, parentVersionId: null,
    };
    const plan = {
      schemaVersion: "1.0.0", id: planId, name: "Snapshot set", status: "active", createdAt: now, updatedAt: now,
      activeVersionId: versionId, draftRevision: 0,
      draft: { schemaVersion: "1.0.0", baseVersionId: versionId, config, evidenceBindings: [], dirty: false, updatedAt: now }, metadata: {},
    };
    await atomicWriteJson(confined(activeRoot, "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
    await atomicWriteJson(confined(activeRoot, "plans", planId, "versions", `${versionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(version), payload: version });
    const hashes = { ...snapshotHashes, configHash };
    const repository = new FileScenarioRepository({
      coordinator,
      resolveBaseAtRoot: async (_root, requested) => requested === versionId
        ? { planId, planVersionId: versionId, config: structuredClone(config), configHash, snapshotHashes: structuredClone(hashes) } : null,
      now: () => now,
    });
    const family = await repository.createFamily({
      familyId: "family-snapshot-set", planId, name: "Snapshot set", basePlanVersionId: versionId,
      baseConfigHash: configHash, baseSnapshotHashes: hashes,
    });
    const manifest = createScenarioSnapshotSetManifest(hashes);
    const manifestFile = confined(activeRoot, "scenarios", "snapshots", `${manifest.snapshotSetId}.json`);
    const cleanBackup = path.join(root, "snapshot-set-clean.backup");
    const graph = await createProductionReferenceGraph({ coordinator, now: () => now });
    expect(graph.edges).toContainEqual({
      fromRef: `scenario-family:${family.familyId}`,
      toRef: `scenario-snapshot-set:${manifest.snapshotSetId}`,
      necessity: "required_for_replay",
    });
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });

    await rm(manifestFile);
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "snapshot-set-missing.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/snapshot-set manifest is missing/);
    await atomicWriteJson(manifestFile, manifest);
    const tampered = structuredClone(manifest); tampered.snapshotHashes.priceSnapshotHash = digest("9");
    await atomicWriteJson(manifestFile, tampered);
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "snapshot-set-tampered.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/snapshot-set manifest identity\/content hash/);
    await atomicWriteJson(manifestFile, manifest);
    const familyFile = confined(activeRoot, "scenarios", "families", `${family.familyId}.json`);
    const swappedFamily = await readJson(familyFile);
    swappedFamily.payload.baseSnapshotHashes.priceSnapshotHash = digest("8");
    swappedFamily.checksum = sha256Json(swappedFamily.payload);
    await atomicWriteJson(familyFile, swappedFamily);
    await expect(createBackup({
      coordinator, outputFile: path.join(root, "snapshot-set-swapped.backup"), password: "a sufficiently long password",
    })).rejects.toThrow(/snapshot-set manifest is missing/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });

    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => {
        await rm(confined(staging, "scenarios", "snapshots", `${manifest.snapshotSetId}.json`));
      },
    })).rejects.toThrow(/snapshot-set manifest is missing/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("validates V2 plan structure and every non-empty identity against the active catalog", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const planId = "plan-v2-catalog"; const versionId = "version-v2-catalog";
    const writeV2 = async (rootPath: string, config: ReturnType<typeof createEmptyBuildConfig>) => {
      const version = {
        schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: now,
        reason: "manual-save", config, configHash: hashPlanConfigRuntime(config), parentVersionId: null,
      };
      const plan = {
        schemaVersion: "1.0.0", id: planId, name: "V2 catalog", status: "active", createdAt: now, updatedAt: now,
        activeVersionId: versionId, draftRevision: 0,
        draft: { schemaVersion: "1.0.0", baseVersionId: versionId, config, evidenceBindings: [], dirty: false, updatedAt: now }, metadata: {},
      };
      await atomicWriteJson(confined(rootPath, "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
      await atomicWriteJson(confined(rootPath, "plans", planId, "versions", `${versionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(version), payload: version });
    };
    const blank = createEmptyBuildConfig(planId, now);
    await writeV2(activeRoot, blank);
    await expect(createProductionReferenceGraph({ coordinator, now: () => now })).resolves.toBeDefined();
    const cleanBackup = path.join(root, "v2-catalog-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });

    const malformed = structuredClone(blank);
    Reflect.deleteProperty(malformed, "caseId");
    await writeV2(activeRoot, malformed as typeof blank);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "v2-missing-case.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/plan authority payload|plan version payload/);

    const wrongKind = structuredClone(blank); wrongKind.caseId = "cpu.i5-14500";
    await writeV2(activeRoot, wrongKind);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "v2-wrong-kind.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/plan authority payload|plan version payload/);

    const badBom = structuredClone(blank); badBom.bom = [{ skuId: "sku.unknown", qty: -9, bucket: "buy_now" }];
    await writeV2(activeRoot, badBom);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "v2-bom.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/plan authority payload|plan version payload/);

    const before = await coordinator.readState();
    const missingSku = structuredClone(blank); missingSku.selection.memoryId = "memory.does-not-exist";
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => writeV2(staging, missingSku),
    })).rejects.toThrow(/plan authority payload|plan version payload/);
    expect(await coordinator.readState()).toEqual(before);
  });

  it("recomputes config migration audit metadata from the immutable V2 source", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const planId = "plan-migration-audit"; const sourceVersionId = "version-migration-source"; const migratedVersionId = "version-migration-v3";
    const source = createDefaultN6Config(planId, now);
    const migrationCatalog = structuredClone(loadMergedCatalogSync({ activeRoot, generationAware: true }));
    const migrationCooler = structuredClone(migrationCatalog.skus.find((sku: { id: string }) => sku.id === source.selection.coolerId)!);
    migrationCooler.id = "cooler.catalog-a-only";
    migrationCooler.attrs = { ...migrationCooler.attrs, type: "down-draft" };
    migrationCatalog.skus.push(migrationCooler);
    source.selection.coolerId = migrationCooler.id;
    source.bom = [{ skuId: migrationCooler.id, qty: 1, bucket: "buy_now" }];
    const sourceBytes = serializeConfig(source); const sourceHash = sha256Bytes(Buffer.from(sourceBytes));
    const migrated = await migrateBuildConfigV2ToV3(source, {
      sourceBytes,
      sourceHash,
      catalog: migrationCatalog,
    });
    expect(migrated.config.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "cpu_cooler", identity: expect.objectContaining({ skuId: migrationCooler.id }) }),
    ]));
    const sourceVersion = {
      schemaVersion: "1.0.0", id: sourceVersionId, planId, versionNumber: 1, createdAt: now,
      reason: "migration-source", config: source, configHash: hashPlanConfigRuntime(source), parentVersionId: null,
    };
    const migratedVersion = {
      schemaVersion: "1.0.0", id: migratedVersionId, planId, versionNumber: 2, createdAt: now,
      reason: "manual-save", config: migrated.config, configHash: hashPlanConfigRuntime(migrated.config), parentVersionId: sourceVersionId,
    };
    const migration = {
      schemaVersion: "plan-config-migration-v1", sourceSchemaVersion: "2.0.0", targetSchemaVersion: "3.0.0",
      sourceVersionId, sourceConfigHash: sourceVersion.configHash, migratedAt: now,
      catalogBinding: migrated.catalogBinding, diff: migrated.diff, warnings: migrated.warnings, rollbackRef: migrated.rollbackRef,
    };
    const plan = {
      schemaVersion: "1.0.0", id: planId, name: "Migration audit", status: "active", createdAt: now, updatedAt: now,
      activeVersionId: migratedVersionId, draftRevision: 1,
      draft: { schemaVersion: "1.0.0", baseVersionId: migratedVersionId, config: migrated.config, configMigration: migration, evidenceBindings: [], dirty: false, updatedAt: now }, metadata: {},
    };
    const write = async (rootPath: string, planValue: typeof plan, migratedVersionValue: typeof migratedVersion = migratedVersion) => {
      await atomicWriteJson(confined(rootPath, "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(planValue), payload: planValue });
      await atomicWriteJson(confined(rootPath, "plans", planId, "versions", `${sourceVersionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(sourceVersion), payload: sourceVersion });
      await atomicWriteJson(confined(rootPath, "plans", planId, "versions", `${migratedVersionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(migratedVersionValue), payload: migratedVersionValue });
    };
    const catalogOverlay = (sku: typeof migrationCooler) => ({
      schemaVersion: migrationCatalog.schemaVersion,
      catalogVersion: migrationCatalog.catalogVersion ?? migrationCatalog.schemaVersion,
      updatedAt: "2026-08-28T00:00:00.000Z",
      skus: [sku],
      runtimeCatalog: {
        schemaVersion: "1.0.0", acceptedSkuIds: [sku.id],
        baseCatalogVersion: migrationCatalog.catalogVersion ?? migrationCatalog.schemaVersion,
        baseUpdatedAt: migrationCatalog.updatedAt,
      },
    });
    await write(activeRoot, plan);
    const unknownCooler = structuredClone(migrationCooler);
    unknownCooler.attrs = { ...unknownCooler.attrs, type: "unknown" };
    await atomicWriteJson(confined(activeRoot, "catalog-overlays", "product-catalog.json"), catalogOverlay(unknownCooler));
    await expect(createProductionReferenceGraph({ coordinator, now: () => now })).resolves.toBeDefined();
    const unknownBackup = path.join(root, "migration-audit-catalog-unknown.backup");
    await expect(createBackup({ coordinator, outputFile: unknownBackup, password: "a sufficiently long password" }))
      .resolves.toBeDefined();
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .not.toMatchObject({ status: "fail" });
    const unknownRestore = await restoreBackup({ coordinator, inputFile: unknownBackup, password: "a sufficiently long password" });
    const unknownRoot = coordinator.activeRoot(unknownRestore.state);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "migration-audit-unknown-restored.backup"), password: "a sufficiently long password" }))
      .resolves.toBeDefined();
    await rm(confined(unknownRoot, "catalog-overlays", "product-catalog.json"));
    await expect(createProductionReferenceGraph({ coordinator, now: () => now })).resolves.toBeDefined();
    const cleanBackup = path.join(root, "migration-audit-catalog-removed.backup");
    await expect(createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" }))
      .resolves.toBeDefined();
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .not.toMatchObject({ status: "fail" });
    const cleanRestore = await restoreBackup({ coordinator, inputFile: cleanBackup, password: "a sufficiently long password" });
    const restoredRoot = coordinator.activeRoot(cleanRestore.state);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "migration-audit-removed-restored.backup"), password: "a sufficiently long password" }))
      .resolves.toBeDefined();
    const forged = structuredClone(plan);
    forged.draft.configMigration.catalogBinding.cooler.type = "aio";
    await write(restoredRoot, forged);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "migration-audit-forged.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/plan authority payload/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });
    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => write(staging, forged),
    })).rejects.toThrow(/plan authority payload/);
    expect(await coordinator.readState()).toEqual(before);

    await write(restoredRoot, plan);
    const illegal = structuredClone(plan);
    illegal.draft.config.components.push({
      instanceId: "gpu-not-in-migration", kind: "gpu", role: "discrete_gpu", state: "planned", source: "user",
      identity: { status: "resolved", skuId: "gpu.catalog-b-missing", identityClaimIds: ["claim-illegal"] },
    });
    await write(restoredRoot, illegal);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "migration-illegal-resolved.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/plan authority payload/);

    await write(restoredRoot, plan);
    const driftedVersion = structuredClone(migratedVersion);
    const migratedCoolerComponent = driftedVersion.config.components.find((component) => component.identity.status === "resolved"
      && component.identity.skuId === migrationCooler.id);
    if (!migratedCoolerComponent) throw new Error("migration fixture must contain the bound cooler component");
    migratedCoolerComponent.state = migratedCoolerComponent.state === "planned" ? "ordered" : "planned";
    driftedVersion.configHash = hashPlanConfigRuntime(driftedVersion.config);
    await write(restoredRoot, plan, driftedVersion);
    await expect(createProductionReferenceGraph({ coordinator, now: () => now })).rejects.toThrow(/plan version payload/);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "migration-version-state-drift.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/plan version payload/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });

    const forgedBackup = path.join(root, "migration-version-state-drift-forged.backup");
    await rewriteBackupJsonAuthority(
      cleanBackup,
      forgedBackup,
      "a sufficiently long password",
      `plans/${planId}/versions/${migratedVersionId}.json`,
      (payload) => {
        const versionPayload = payload as unknown as typeof migratedVersion;
        const component = versionPayload.config.components.find((candidate) => candidate.identity.status === "resolved"
          && candidate.identity.skuId === migrationCooler.id);
        if (!component) throw new Error("forged backup migration cooler is missing");
        component.state = component.state === "planned" ? "ordered" : "planned";
        versionPayload.configHash = hashPlanConfigRuntime(versionPayload.config);
      },
    );
    await expect(verifyBackup({ inputFile: forgedBackup, password: "a sufficiently long password" }))
      .rejects.toThrow(/plan version payload/);
    const beforeStateDriftRestore = await coordinator.readState();
    await expect(restoreBackup({
      coordinator,
      inputFile: cleanBackup,
      password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => write(staging, plan, driftedVersion),
    })).rejects.toThrow(/plan version payload/);
    expect(await coordinator.readState()).toEqual(beforeStateDriftRestore);
  });

  it("binds plan evidence to the exact owner and evidence document content authority", async () => {
    const { root, coordinator, activeRoot } = await runtime();
    const planId = "plan-evidence-graph"; const versionId = "version-evidence-graph";
    const evidence = new FileEvidenceRepository({ coordinator, now: () => now });
    const storedEvidence = await evidence.importBuffer(Buffer.from("official governed evidence"), {
      mediaType: "application/pdf", kind: "manufacturer-manual", title: "Governed evidence",
      productIdentities: [{ brand: "Example", model: "Model", category: "case", skuId: "case.jonsbo-n6" }],
      capture: {
        requestedUrl: "https://example.com/requested.pdf", finalUrl: "https://example.com/final.pdf",
        canonicalUrl: "https://example.com/evidence.pdf", retrievedAt: now, status: 200,
        redirects: ["https://example.com/final.pdf"], officialBrand: "Example", acquisitionMethod: "official-fetch",
      },
    });
    const bindingBase = {
      schemaVersion: "1.0.0", planId, documentId: storedEvidence.document.id, contentHash: storedEvidence.document.sha256,
      subject: { kind: "plan", id: planId }, purposes: ["identity"], boundAt: now,
    };
    const draftBinding = { ...bindingBase, id: "" }; draftBinding.id = evidenceBindingIdRuntime(draftBinding);
    const versionBinding = { ...bindingBase, planVersionId: versionId, id: "" }; versionBinding.id = evidenceBindingIdRuntime(versionBinding);
    expect(validatePlanEvidenceBindingRuntime({ documentId: storedEvidence.document.id }, { planId })).not.toEqual([]);
    const config = createEmptyBuildConfigV3(planId, "Evidence graph", now);
    const version = {
      schemaVersion: "1.0.0", id: versionId, planId, versionNumber: 1, createdAt: now, reason: "manual-save",
      config, configHash: hashPlanConfigRuntime(config), parentVersionId: null,
      evidenceBindings: [versionBinding], evidenceHash: sha256Json([versionBinding]),
    };
    const plan = {
      schemaVersion: "1.0.0", id: planId, name: "Evidence graph", status: "active", createdAt: now, updatedAt: now,
      activeVersionId: versionId, draftRevision: 0,
      draft: { schemaVersion: "1.0.0", baseVersionId: versionId, config, evidenceBindings: [draftBinding], dirty: false, updatedAt: now }, metadata: {},
    };
    const write = async (rootPath: string, planValue: typeof plan, versionValue: typeof version = version) => {
      await atomicWriteJson(confined(rootPath, "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(planValue), payload: planValue });
      await atomicWriteJson(confined(rootPath, "plans", planId, "versions", `${versionId}.json`), { schemaVersion: "1.0.0", kind: "version", checksum: sha256Json(versionValue), payload: versionValue });
    };
    await write(activeRoot, plan);
    const cleanBackup = path.join(root, "evidence-graph-clean.backup");
    await createBackup({ coordinator, outputFile: cleanBackup, password: "a sufficiently long password" });

    const wrongOwner = structuredClone(plan); const wrongOwnerBinding = wrongOwner.draft.evidenceBindings[0];
    if (!wrongOwnerBinding) throw new Error("evidence owner fixture must contain one binding");
    wrongOwnerBinding.planId = "plan-other-owner";
    wrongOwnerBinding.id = evidenceBindingIdRuntime(wrongOwnerBinding);
    await write(activeRoot, wrongOwner);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "evidence-owner-forged.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/plan authority payload/);
    expect((await runDoctor({ coordinator })).report.checks.find((check: { checkId: string }) => check.checkId === "integrity.repository_hashes"))
      .toMatchObject({ status: "fail" });

    const forgedVersion = structuredClone(version);
    const forgedVersionBinding = forgedVersion.evidenceBindings[0];
    if (!forgedVersionBinding) throw new Error("evidence version fixture must contain one binding");
    forgedVersionBinding.contentHash = digest("0");
    forgedVersionBinding.documentId = `doc-sha256-${digest("0")}`;
    forgedVersionBinding.id = evidenceBindingIdRuntime(forgedVersionBinding);
    forgedVersion.evidenceHash = sha256Json(forgedVersion.evidenceBindings);
    await write(activeRoot, plan, forgedVersion);
    await expect(createBackup({ coordinator, outputFile: path.join(root, "evidence-content-forged.backup"), password: "a sufficiently long password" }))
      .rejects.toThrow(/evidence binding document content hash is missing or mismatched/);

    const before = await coordinator.readState();
    await expect(restoreBackup({
      coordinator, inputFile: cleanBackup, password: "a sufficiently long password",
      beforePointerSwitch: async ({ staging }: { staging: string }) => write(staging, wrongOwner),
    })).rejects.toThrow(/plan authority payload/);
    expect(await coordinator.readState()).toEqual(before);
  });
});

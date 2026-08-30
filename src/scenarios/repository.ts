import path from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import type { BuildConfigV3 } from "../topology/contracts";
import { configV3Hash } from "../topology/hash";
import type { SkuCatalog } from "../sku/types";
import { loadBundledCatalog } from "../sku/catalog";
import { loadMergedCatalogSync } from "../../scripts/price-server/catalog/repository.mjs";
import { validateResolvedV3CatalogBindingsRuntime } from "../config/v3-catalog-runtime.mjs";
import { isSnapshotHashes, type SnapshotHashes } from "../hash";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import {
  atomicWriteJson,
  confined,
  ensurePrivateDirectory,
  listRegularFiles,
  sha256Json,
  withDirectoryLock,
} from "../runtime/fs.mjs";
import {
  SCENARIO_SCHEMA_VERSION,
  validateScenarioFamily,
  validatePersistedScenarioBranch,
  validatePersistedWhatIfResult,
  type PersistedScenarioBranch,
  type PersistedWhatIfResult,
  type ScenarioBranch,
  type ScenarioFamily,
} from "./contracts";
import { applyTopologyV3Patch } from "./patch";
import type { PatchActor } from "../contracts/registries";
import {
  createScenarioSnapshotSetManifest,
  normalizeScenarioAuthorityValue,
  validateScenarioSnapshotSetManifest,
} from "./runtime-validation.mjs";
import { FileArtifactRepository } from "../artifacts/repository.mjs";
import {
  solverArtifactReferencesRuntime,
  validateSolverArtifactRuntime,
  validateSolverWhatIfArtifactRuntime,
  validateSolverWhatIfClosureRuntime,
} from "../solver/runtime-validation.mjs";

const ENVELOPE_SCHEMA_VERSION = "scenario-repository-envelope-v1" as const;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;

type EnvelopeKind = "family" | "branch" | "result";

interface StoredEnvelope<T> {
  schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  kind: EnvelopeKind;
  checksum: string;
  payload: T;
}

interface ScenarioSnapshotSetManifest {
  schemaVersion: "scenario-snapshot-set-v1";
  snapshotSetId: string;
  snapshotHashes: SnapshotHashes;
  contentHash: string;
}

export interface ScenarioBaseSnapshot {
  planId: string;
  planVersionId: string;
  config: BuildConfigV3;
  configHash: string;
  snapshotHashes: SnapshotHashes;
}

export type ScenarioBaseResolver = (planVersionId: string) => Promise<ScenarioBaseSnapshot | null>;
export type ScenarioBaseAtRootResolver = (activeRoot: string, planVersionId: string) => Promise<ScenarioBaseSnapshot | null>;
export type ScenarioCatalogResolver = () => Promise<SkuCatalog> | SkuCatalog;
export type ScenarioCatalogAtRootResolver = (activeRoot: string) => Promise<SkuCatalog> | SkuCatalog;
export interface CreateScenarioFamilyInput {
  familyId: string;
  planId: string;
  name: string;
  basePlanVersionId: string;
  baseConfigHash: string;
  baseSnapshotHashes: SnapshotHashes;
}

export interface CreateScenarioBranchInput {
  scenarioId: string;
  familyId: string;
  patch: ScenarioBranch["patch"];
  simulationInputPatch?: ScenarioBranch["simulationInputPatch"];
  actor?: PatchActor;
}

export interface ScenarioAcceptanceProposal {
  kind: "v3-change";
  scenarioId: string;
  familyId: string;
  planId: string;
  expectedPlanVersionId: string;
  expectedConfigHash: string;
  expectedDraftRevision: number;
  operations: ScenarioBranch["patch"];
}

export interface ScenarioRuntimeBinding {
  runtimeGeneration: number;
  runtimeRevision: number;
}

export interface ScenarioAuthoritativeResultCommit {
  scenarioId: string;
  expectedRuntimeGeneration: number;
  expectedRuntimeRevision: number;
  result: PersistedWhatIfResult;
  authority: { artifactRef: string; artifact: unknown };
}

interface AuthoritativeScenarioResultRecord {
  schemaVersion: "scenario-authoritative-result-v1";
  result: PersistedWhatIfResult;
  authority: { artifactRef: string; artifact: unknown };
}

export class ScenarioRepositoryError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict" | "stale" | "corrupt_data" | "evaluation_authority_unavailable", message: string) {
    super(message);
    this.name = "ScenarioRepositoryError";
  }
}

export interface FileScenarioRepositoryOptions {
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  /** Explicit-root test/import repositories use this resolver. */
  resolveBase?: ScenarioBaseResolver;
  /** Generation-aware repositories must resolve under the coordinator's barrier. */
  resolveBaseAtRoot?: ScenarioBaseAtRootResolver;
  getCatalog?: ScenarioCatalogResolver;
  getCatalogAtRoot?: ScenarioCatalogAtRootResolver;
  now?: () => string;
  /** Internal/root-pinned artifact closure; production composition supplies it via the coordinator. */
  artifactRoot?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertId(id: string, field: string): void {
  if (!SAFE_ID.test(id)) throw new ScenarioRepositoryError("invalid_input", `${field} is not a safe stable ID`);
}

function envelope<T>(kind: EnvelopeKind, payload: T): StoredEnvelope<T> {
  return { schemaVersion: ENVELOPE_SCHEMA_VERSION, kind, checksum: sha256Json(payload), payload };
}

function sameSnapshotHashes(left: SnapshotHashes, right: SnapshotHashes): boolean {
  return sha256Json(left) === sha256Json(right);
}

export class FileScenarioRepository {
  private readonly root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;
  private readonly resolveBase: ScenarioBaseResolver | undefined;
  private readonly resolveBaseAtRoot: ScenarioBaseAtRootResolver | undefined;
  private readonly getCatalog: ScenarioCatalogResolver;
  private readonly getCatalogAtRoot: ScenarioCatalogAtRootResolver | undefined;
  private readonly now: () => string;
  private readonly artifactRoot: string | undefined;

  constructor(options: FileScenarioRepositoryOptions) {
    const coordinatorRoot = (options.coordinator as unknown as { root?: string } | undefined)?.root;
    const runtimeRoot = path.resolve(options.runtimeRoot ?? coordinatorRoot ?? path.join(process.cwd(), "runtime"));
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, "scenarios"));
    this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot, now: options.now });
    if (options.root) {
      if (!options.resolveBase || options.resolveBaseAtRoot || options.getCatalogAtRoot) throw new TypeError("explicit-root scenario repository requires root-bound dependencies");
    } else if (!options.resolveBaseAtRoot || options.resolveBase || options.getCatalog) {
      throw new TypeError("coordinated scenario repository requires only resolveBaseAtRoot");
    }
    this.resolveBase = options.resolveBase;
    this.resolveBaseAtRoot = options.resolveBaseAtRoot;
    this.getCatalog = options.getCatalog ?? (() => loadBundledCatalog());
    this.getCatalogAtRoot = options.getCatalogAtRoot ?? (options.root ? undefined
      : (activeRoot) => loadMergedCatalogSync({ activeRoot, generationAware: true }) as SkuCatalog);
    this.now = options.now ?? (() => new Date().toISOString());
    this.artifactRoot = options.artifactRoot === undefined ? undefined : path.resolve(options.artifactRoot);
  }

  private atActiveRoot(activeRoot: string): FileScenarioRepository {
    const resolveBaseAtRoot = this.resolveBaseAtRoot;
    const getCatalogAtRoot = this.getCatalogAtRoot;
    if (!resolveBaseAtRoot || !getCatalogAtRoot) throw new ScenarioRepositoryError("corrupt_data", "generation-bound scenario dependencies are unavailable");
    return new FileScenarioRepository({
      root: confined(activeRoot, "scenarios"),
      resolveBase: (versionId) => resolveBaseAtRoot(activeRoot, versionId),
      getCatalog: () => getCatalogAtRoot(activeRoot),
      now: this.now,
      artifactRoot: confined(activeRoot, "artifacts"),
    });
  }

  private async boundary<T>(write: boolean, operation: (repository: FileScenarioRepository) => Promise<T>): Promise<T> {
    if (this.coordinator) {
      await this.coordinator.initialize();
      if (write) return (await this.coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => {
        const local = this.atActiveRoot(activeRoot);
        return local.assertRepositoryInventoryLocal().then(() => operation(local));
      })).result as T;
      return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => {
        const local = this.atActiveRoot(activeRoot);
        return local.assertRepositoryInventoryLocal().then(() => operation(local));
      })).result as T;
    }
    if (!write) { await this.assertRepositoryInventoryLocal(); return operation(this); }
    return withDirectoryLock(confined(this.root, ".locks", "repository-global"), async () => {
      await this.assertRepositoryInventoryLocal();
      return operation(this);
    });
  }

  private async assertRepositoryInventoryLocal(): Promise<void> {
    const files = await listRegularFiles(this.root);
    for (const file of files) {
      if (file.symlink) throw new ScenarioRepositoryError("corrupt_data", "scenario repository contains a symbolic link");
      if (/^(?:evaluations|evaluation-snapshots)\//.test(file.logicalPath)) {
        throw new ScenarioRepositoryError("evaluation_authority_unavailable", "persisted scenario result authority is unavailable in U2");
      }
      if (!/^(?:(?:families|branches|results)\/[a-z0-9][a-z0-9-]{2,79}|snapshots\/snapshot-set-[a-f0-9]{64})\.json$/.test(file.logicalPath)) {
        throw new ScenarioRepositoryError("corrupt_data", "scenario repository contains an unrecognized authority path");
      }
    }
  }

  private familyFile(familyId: string): string {
    assertId(familyId, "familyId");
    return confined(this.root, "families", `${familyId}.json`);
  }

  private branchFile(scenarioId: string): string {
    assertId(scenarioId, "scenarioId");
    return confined(this.root, "branches", `${scenarioId}.json`);
  }

  private resultFile(scenarioId: string): string {
    assertId(scenarioId, "scenarioId");
    return confined(this.root, "results", `${scenarioId}.json`);
  }

  private snapshotSetFile(snapshotSetId: string): string {
    if (!/^snapshot-set-[a-f0-9]{64}$/.test(snapshotSetId)) throw new ScenarioRepositoryError("invalid_input", "snapshotSetId is invalid");
    return confined(this.root, "snapshots", `${snapshotSetId}.json`);
  }

  private async assertSnapshotSetLocal(snapshotHashes: SnapshotHashes): Promise<ScenarioSnapshotSetManifest> {
    const expected = createScenarioSnapshotSetManifest(snapshotHashes) as ScenarioSnapshotSetManifest;
    let value: unknown;
    try {
      const file = this.snapshotSetFile(expected.snapshotSetId);
      const status = await lstat(file);
      if (status.isSymbolicLink() || !status.isFile()) throw new Error("not a regular file");
      value = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new ScenarioRepositoryError("corrupt_data", "scenario snapshot-set manifest is missing or unreadable");
    }
    if (validateScenarioSnapshotSetManifest(value, expected.snapshotSetId).length
      || !value || typeof value !== "object" || Array.isArray(value)
      || !isSnapshotHashes((value as Partial<ScenarioSnapshotSetManifest>).snapshotHashes)
      || sha256Json((value as ScenarioSnapshotSetManifest).snapshotHashes) !== sha256Json(snapshotHashes)) {
      throw new ScenarioRepositoryError("corrupt_data", "scenario snapshot-set manifest integrity/binding failed");
    }
    return clone(value as ScenarioSnapshotSetManifest);
  }

  private async writeSnapshotSetLocal(snapshotHashes: SnapshotHashes): Promise<ScenarioSnapshotSetManifest> {
    const manifest = createScenarioSnapshotSetManifest(snapshotHashes) as ScenarioSnapshotSetManifest;
    const file = this.snapshotSetFile(manifest.snapshotSetId);
    try {
      return await this.assertSnapshotSetLocal(snapshotHashes);
    } catch (error) {
      if (!(error instanceof ScenarioRepositoryError) || !/missing or unreadable/.test(error.message)) throw error;
    }
    await ensurePrivateDirectory(path.dirname(file));
    await atomicWriteJson(file, manifest);
    return clone(manifest);
  }

  private async readEnvelope<T>(file: string, kind: EnvelopeKind): Promise<T> {
    let value: unknown;
    try {
      const status = await lstat(file);
      if (status.isSymbolicLink() || !status.isFile()) throw new ScenarioRepositoryError("corrupt_data", `${kind} path is not a regular file`);
      value = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ScenarioRepositoryError("not_found", `${kind} was not found`);
      throw new ScenarioRepositoryError("corrupt_data", `${kind} could not be read`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScenarioRepositoryError("corrupt_data", `${kind} envelope invalid`);
    const stored = value as Partial<StoredEnvelope<T>>;
    if (Object.keys(stored).sort().join("\0") !== ["checksum", "kind", "payload", "schemaVersion"].sort().join("\0")
      || stored.schemaVersion !== ENVELOPE_SCHEMA_VERSION || stored.kind !== kind || !("payload" in stored) || stored.checksum !== sha256Json(stored.payload)) {
      throw new ScenarioRepositoryError("corrupt_data", `${kind} envelope integrity failed`);
    }
    return stored.payload as T;
  }

  private async writeImmutable<T>(file: string, kind: EnvelopeKind, payload: T): Promise<T> {
    try {
      const existing = await this.readEnvelope<T>(file, kind);
      if (sha256Json(existing) === sha256Json(payload)) return clone(existing);
      throw new ScenarioRepositoryError("conflict", `${kind} ID already stores different content`);
    } catch (error) {
      if (!(error instanceof ScenarioRepositoryError) || error.code !== "not_found") throw error;
    }
    await ensurePrivateDirectory(path.dirname(file));
    await atomicWriteJson(file, envelope(kind, payload));
    return clone(payload);
  }

  private async getFamilyLocal(familyId: string): Promise<ScenarioFamily> {
    const family = await this.readEnvelope<ScenarioFamily>(this.familyFile(familyId), "family");
    const errors = validateScenarioFamily(family);
    if (errors.length) throw new ScenarioRepositoryError("corrupt_data", `scenario family invalid: ${errors.join("; ")}`);
    await this.assertSnapshotSetLocal(family.baseSnapshotHashes);
    return family;
  }

  private async getBranchLocal(scenarioId: string): Promise<PersistedScenarioBranch> {
    const branch = await this.readEnvelope<PersistedScenarioBranch>(this.branchFile(scenarioId), "branch");
    const errors = validatePersistedScenarioBranch(branch);
    if (errors.length) throw new ScenarioRepositoryError("corrupt_data", `scenario branch invalid: ${errors.join("; ")}`);
    await this.assertSnapshotSetLocal(branch.baseSnapshotHashes);
    return branch;
  }

  private async assertBase(family: ScenarioFamily): Promise<ScenarioBaseSnapshot> {
    if (!this.resolveBase) throw new ScenarioRepositoryError("corrupt_data", "scenario base resolver is unavailable outside a generation barrier");
    const base = await this.resolveBase(family.basePlanVersionId);
    if (!base) throw new ScenarioRepositoryError("stale", "scenario base plan version is unavailable");
    if (base.planId !== family.planId
      || base.planVersionId !== family.basePlanVersionId
      || base.configHash !== family.baseConfigHash
      || !sameSnapshotHashes(base.snapshotHashes, family.baseSnapshotHashes)) {
      throw new ScenarioRepositoryError("stale", "scenario base config or snapshots changed");
    }
    return base;
  }

  private async catalogBindingErrors(config: BuildConfigV3): Promise<string[]> {
    const catalog = await this.getCatalog();
    return validateResolvedV3CatalogBindingsRuntime(config, catalog)
      .map((issue) => `${issue.path}: ${issue.message}`);
  }

  async createFamily(input: CreateScenarioFamilyInput): Promise<ScenarioFamily> {
    return this.boundary(true, async (repository) => {
      assertId(input.familyId, "familyId");
      const timestamp = repository.now();
      const family: ScenarioFamily = {
        schemaVersion: SCENARIO_SCHEMA_VERSION,
        familyId: input.familyId,
        planId: input.planId,
        name: input.name,
        basePlanVersionId: input.basePlanVersionId,
        baseConfigHash: input.baseConfigHash,
        baseSnapshotHashes: clone(input.baseSnapshotHashes),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const errors = validateScenarioFamily(family);
      if (errors.length) throw new ScenarioRepositoryError("invalid_input", errors.join("; "));
      await repository.assertBase(family);
      await repository.writeSnapshotSetLocal(family.baseSnapshotHashes);
      return repository.writeImmutable(repository.familyFile(family.familyId), "family", family);
    });
  }

  async getFamily(familyId: string): Promise<ScenarioFamily> {
    return this.boundary(false, async (repository) => clone(await repository.getFamilyLocal(familyId)));
  }

  async createBranch(input: CreateScenarioBranchInput): Promise<PersistedScenarioBranch> {
    return this.boundary(true, async (repository) => {
      assertId(input.scenarioId, "scenarioId");
      const family = await repository.getFamilyLocal(input.familyId);
      const base = await repository.assertBase(family);
      const actor = input.actor ?? "user";
      const patch = normalizeScenarioAuthorityValue(input.patch) as ScenarioBranch["patch"];
      const simulationInputPatch = input.simulationInputPatch
        ? normalizeScenarioAuthorityValue(input.simulationInputPatch) as NonNullable<ScenarioBranch["simulationInputPatch"]> : undefined;
      let materialized: BuildConfigV3;
      try { materialized = applyTopologyV3Patch(base.config, patch, { actor }); }
      catch (error) {
        throw new ScenarioRepositoryError("invalid_input", error instanceof Error ? error.message : "scenario patch is invalid");
      }
      const catalogErrors = await repository.catalogBindingErrors(materialized);
      if (catalogErrors.length) throw new ScenarioRepositoryError("invalid_input", `scenario resolved catalog binding invalid: ${catalogErrors.join("; ")}`);
      const branch: PersistedScenarioBranch = {
        schemaVersion: SCENARIO_SCHEMA_VERSION,
        createdByActor: actor,
        createdAt: repository.now(),
        patchHash: sha256Json(normalizeScenarioAuthorityValue({ patch, simulationInputPatch: simulationInputPatch ?? [] })),
        materializedConfigHash: await configV3Hash(materialized),
        scenarioId: input.scenarioId,
        familyId: family.familyId,
        basePlanVersionId: family.basePlanVersionId,
        baseConfigHash: family.baseConfigHash,
        baseSnapshotHashes: clone(family.baseSnapshotHashes),
        patch,
        ...(simulationInputPatch ? { simulationInputPatch } : {}),
      };
      const errors = validatePersistedScenarioBranch(branch);
      if (errors.length) throw new ScenarioRepositoryError("invalid_input", errors.join("; "));
      return repository.writeImmutable(repository.branchFile(branch.scenarioId), "branch", branch);
    });
  }

  async getBranch(scenarioId: string): Promise<PersistedScenarioBranch> {
    return this.boundary(false, async (repository) => clone(await repository.getBranchLocal(scenarioId)));
  }

  async listBranches(familyId: string): Promise<PersistedScenarioBranch[]> {
    return this.boundary(false, async (repository) => {
      await repository.getFamilyLocal(familyId);
      let entries: import("node:fs").Dirent[];
      try { entries = await readdir(confined(repository.root, "branches"), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      const branches: PersistedScenarioBranch[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const scenarioId = entry.name.slice(0, -5);
        if (!SAFE_ID.test(scenarioId)) throw new ScenarioRepositoryError("corrupt_data", "scenario branch path is not a safe ID");
        const branch = await repository.getBranchLocal(scenarioId);
        if (branch.familyId === familyId) branches.push(branch);
      }
      return branches.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId)).map(clone);
    });
  }

  private async materializeLocal(scenarioId: string): Promise<{
    family: ScenarioFamily;
    branch: PersistedScenarioBranch;
    base: ScenarioBaseSnapshot;
    config: BuildConfigV3;
  }> {
    const branch = await this.getBranchLocal(scenarioId);
    const family = await this.getFamilyLocal(branch.familyId);
    if (branch.basePlanVersionId !== family.basePlanVersionId
      || branch.baseConfigHash !== family.baseConfigHash
      || !sameSnapshotHashes(branch.baseSnapshotHashes, family.baseSnapshotHashes)) {
      throw new ScenarioRepositoryError("corrupt_data", "scenario branch base does not match its family");
    }
    const base = await this.assertBase(family);
    const config = applyTopologyV3Patch(base.config, branch.patch, { actor: branch.createdByActor });
    const catalogErrors = await this.catalogBindingErrors(config);
    if (catalogErrors.length) throw new ScenarioRepositoryError("corrupt_data", `scenario resolved catalog binding invalid: ${catalogErrors.join("; ")}`);
    if (await configV3Hash(config) !== branch.materializedConfigHash) {
      throw new ScenarioRepositoryError("corrupt_data", "scenario branch materialized config hash is invalid");
    }
    return { family, branch, base, config };
  }

  async materialize(scenarioId: string): Promise<{ family: ScenarioFamily; branch: PersistedScenarioBranch; config: BuildConfigV3 }> {
    return this.boundary(false, async (repository) => {
      const materialized = await repository.materializeLocal(scenarioId);
      return { family: clone(materialized.family), branch: clone(materialized.branch), config: materialized.config };
    });
  }

  /**
   * Read-only U6 evaluation view. It exposes a clone of the immutable base and
   * materialized branch while performing no PlanRepository write.
   */
  async materializeComparison(scenarioId: string): Promise<{
    family: ScenarioFamily;
    branch: PersistedScenarioBranch;
    base: ScenarioBaseSnapshot;
    config: BuildConfigV3;
    runtimeBinding: ScenarioRuntimeBinding;
  }> {
    if (this.coordinator) {
      await this.coordinator.initialize();
      const snapshot = await this.coordinator.withConsistentSnapshot(async ({ state, activeRoot }: {
        state: { runtimeGeneration: number; revision: number };
        activeRoot: string;
      }) => {
        const repository = this.atActiveRoot(activeRoot);
        await repository.assertRepositoryInventoryLocal();
        const materialized = await repository.materializeLocal(scenarioId);
        return {
          family: clone(materialized.family), branch: clone(materialized.branch), base: clone(materialized.base), config: clone(materialized.config),
          runtimeBinding: { runtimeGeneration: state.runtimeGeneration, runtimeRevision: state.revision },
        };
      });
      return snapshot.result;
    }
    return this.boundary(false, async (repository) => {
      const materialized = await repository.materializeLocal(scenarioId);
      return {
        family: clone(materialized.family),
        branch: clone(materialized.branch),
        base: clone(materialized.base),
        config: clone(materialized.config),
        runtimeBinding: { runtimeGeneration: 0, runtimeRevision: 0 },
      };
    });
  }

  async saveResult(scenarioId: string): Promise<PersistedWhatIfResult> {
    assertId(scenarioId, "scenarioId");
    throw new ScenarioRepositoryError(
      "evaluation_authority_unavailable",
      "persisted scenario results require the governed replayable evaluator authority introduced after U2",
    );
  }

  private async readSolverArtifactLocal(ref: string, expectedKind: string): Promise<{ value: unknown; references: unknown[] }> {
    if (!this.artifactRoot || !/^sha256:[a-f0-9]{64}$/.test(ref)) {
      throw new ScenarioRepositoryError("evaluation_authority_unavailable", "scenario result artifact authority is unavailable");
    }
    const repository = new FileArtifactRepository({ root: this.artifactRoot });
    const stored = await repository.get(ref);
    if (!stored || stored.record.kind !== expectedKind || stored.record.mediaType !== "application/vnd.buildsim.solver+json"
      || stored.bytes.byteLength > 16 * 1024 * 1024) {
      throw new ScenarioRepositoryError("corrupt_data", `scenario ${expectedKind} artifact is missing or has invalid metadata`);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.from(stored.bytes).toString("utf8")); }
    catch { throw new ScenarioRepositoryError("corrupt_data", `scenario ${expectedKind} artifact is not JSON`); }
    const errors = validateSolverArtifactRuntime(expectedKind, value);
    if (errors.length) throw new ScenarioRepositoryError("corrupt_data", `scenario ${expectedKind} artifact invalid: ${errors.join("; ")}`);
    const expectedReferences = solverArtifactReferencesRuntime(expectedKind, value);
    if (sha256Json(stored.record.references) !== sha256Json(expectedReferences)) {
      throw new ScenarioRepositoryError("corrupt_data", `scenario ${expectedKind} artifact reference closure invalid`);
    }
    return { value, references: stored.record.references };
  }

  private async validateAuthoritativeResultLocal(
    scenarioId: string,
    result: PersistedWhatIfResult,
    authority: ScenarioAuthoritativeResultCommit["authority"],
  ): Promise<AuthoritativeScenarioResultRecord> {
    assertId(scenarioId, "scenarioId");
    const resultErrors = validatePersistedWhatIfResult(result);
    if (resultErrors.length || result.scenarioId !== scenarioId) {
      throw new ScenarioRepositoryError("invalid_input", `persisted what-if result invalid: ${resultErrors.join("; ") || "scenario mismatch"}`);
    }
    const materialized = await this.materializeLocal(scenarioId);
    const persisted = await this.readSolverArtifactLocal(authority.artifactRef, "solver-what-if-result");
    if (validateSolverWhatIfArtifactRuntime(authority.artifact).length
      || sha256Json(persisted.value) !== sha256Json(authority.artifact)) {
      throw new ScenarioRepositoryError("invalid_input", "scenario what-if artifact inline/root authority mismatch");
    }
    const artifact = persisted.value as Record<string, unknown>;
    if (artifact.scenarioId !== scenarioId || artifact.familyId !== materialized.family.familyId
      || artifact.basePlanVersionId !== materialized.family.basePlanVersionId
      || artifact.baseConfigHash !== materialized.family.baseConfigHash
      || artifact.afterConfigHash !== materialized.branch.materializedConfigHash
      || sha256Json(artifact.baseSnapshotHashes) !== sha256Json(materialized.family.baseSnapshotHashes)
      || result.beforeConfigHash !== materialized.family.baseConfigHash
      || result.afterConfigHash !== materialized.branch.materializedConfigHash || result.patchHash !== materialized.branch.patchHash
      || result.createdAt !== artifact.createdAt || result.beforeEvaluationHash !== artifact.beforeEvaluationHash
      || result.afterEvaluationHash !== artifact.afterEvaluationHash || result.decisionDiffRef !== artifact.decisionDiffRef
      || sha256Json(result.domainDiffRefs) !== sha256Json(artifact.domainDiffRefs)
      || result.snapshotAttribution !== artifact.snapshotAttribution) {
      throw new ScenarioRepositoryError("stale", "scenario result no longer binds its exact family/branch/materialization authority");
    }
    const decision = (await this.readSolverArtifactLocal(result.decisionDiffRef, "solver-what-if-decision-diff")).value;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new ScenarioRepositoryError("corrupt_data", "scenario what-if decision diff authority is invalid");
    }
    const decisionRecord = decision as Record<string, unknown>;
    if (decisionRecord.scenarioId !== artifact.scenarioId
      || decisionRecord.beforeEvaluationHash !== artifact.beforeEvaluationHash
      || decisionRecord.afterEvaluationHash !== artifact.afterEvaluationHash
      || decisionRecord.beforeReceiptRef !== artifact.beforeReceiptRef
      || decisionRecord.afterReceiptRef !== artifact.afterReceiptRef) {
      throw new ScenarioRepositoryError("corrupt_data", "scenario what-if result/decision authority closure mismatch");
    }
    const domainDiffRefs = result.domainDiffRefs;
    const domainEntries = await Promise.all(domainDiffRefs.map(async (ref) => ({
      ref, value: (await this.readSolverArtifactLocal(ref, "solver-what-if-domain-diff")).value,
    })));
    const closureErrors = validateSolverWhatIfClosureRuntime(
      artifact,
      { ref: result.decisionDiffRef, value: decision },
      domainEntries,
    );
    if (closureErrors.length) throw new ScenarioRepositoryError("corrupt_data", `scenario what-if diff closure invalid: ${closureErrors.join("; ")}`);
    for (const ref of [artifact.beforeReceiptRef, artifact.afterReceiptRef, artifact.beforeCoverageRef, artifact.afterCoverageRef]) {
      if (typeof ref !== "string" || !this.artifactRoot || !await new FileArtifactRepository({ root: this.artifactRoot }).get(ref)) {
        throw new ScenarioRepositoryError("corrupt_data", "scenario evaluator receipt/coverage authority is missing");
      }
    }
    return {
      schemaVersion: "scenario-authoritative-result-v1",
      result: clone(result),
      authority: { artifactRef: authority.artifactRef, artifact: clone(authority.artifact) },
    };
  }

  /** Root-bound writer used only inside a coordinator barrier. */
  async saveAuthoritativeResultAtRoot(
    activeRoot: string,
    scenarioId: string,
    result: PersistedWhatIfResult,
    authority: ScenarioAuthoritativeResultCommit["authority"],
  ): Promise<PersistedWhatIfResult> {
    const repository = this.atActiveRoot(activeRoot);
    await repository.assertRepositoryInventoryLocal();
    const record = await repository.validateAuthoritativeResultLocal(scenarioId, result, authority);
    const stored = await repository.writeImmutable(repository.resultFile(scenarioId), "result", record);
    return clone(stored.result);
  }

  /** CAS commit: any generation/revision race leaves the scenario result path untouched. */
  async commitAuthoritativeResult(input: ScenarioAuthoritativeResultCommit): Promise<PersistedWhatIfResult> {
    if (!this.coordinator || input.expectedRuntimeGeneration < 1 || input.expectedRuntimeRevision < 0) {
      throw new ScenarioRepositoryError("evaluation_authority_unavailable", "authoritative scenario result commit requires a coordinated runtime root");
    }
    return (await this.coordinator.withWrite(async ({ state, activeRoot }: {
      state: { runtimeGeneration: number; revision: number };
      activeRoot: string;
    }) => {
      if (state.runtimeGeneration !== input.expectedRuntimeGeneration || state.revision !== input.expectedRuntimeRevision) {
        throw new ScenarioRepositoryError("stale", "scenario result runtime generation/revision changed before commit");
      }
      return this.saveAuthoritativeResultAtRoot(activeRoot, input.scenarioId, input.result, input.authority);
    }, { expectedRevision: input.expectedRuntimeRevision })).result;
  }

  async getResult(scenarioId: string): Promise<PersistedWhatIfResult | null> {
    return this.boundary(false, async (repository) => {
      try {
        const record = await repository.readEnvelope<AuthoritativeScenarioResultRecord>(repository.resultFile(scenarioId), "result");
        if (!record || record.schemaVersion !== "scenario-authoritative-result-v1") {
          throw new ScenarioRepositoryError("corrupt_data", "persisted scenario result record schema invalid");
        }
        const validated = await repository.validateAuthoritativeResultLocal(scenarioId, record.result, record.authority);
        if (sha256Json(validated) !== sha256Json(record)) throw new ScenarioRepositoryError("corrupt_data", "persisted scenario result authority changed");
        return clone(record.result);
      } catch (error) {
        if (error instanceof ScenarioRepositoryError && error.code === "not_found") return null;
        throw error;
      }
    });
  }

  async proposalForAcceptance(
    scenarioId: string,
    current: { planId: string; planVersionId: string; configHash: string; draftRevision: number },
  ): Promise<ScenarioAcceptanceProposal> {
    return this.boundary(false, async (repository) => {
      const branch = await repository.getBranchLocal(scenarioId);
      const family = await repository.getFamilyLocal(branch.familyId);
      await repository.assertBase(family);
      if (current.planId !== family.planId
        || current.planVersionId !== family.basePlanVersionId
        || current.configHash !== family.baseConfigHash) {
        throw new ScenarioRepositoryError("stale", "active plan no longer matches the scenario base");
      }
      if (!Number.isSafeInteger(current.draftRevision) || current.draftRevision < 0) throw new ScenarioRepositoryError("invalid_input", "draftRevision invalid");
      return {
        kind: "v3-change",
        scenarioId: branch.scenarioId,
        familyId: family.familyId,
        planId: family.planId,
        expectedPlanVersionId: family.basePlanVersionId,
        expectedConfigHash: family.baseConfigHash,
        expectedDraftRevision: current.draftRevision,
        operations: clone(branch.patch),
      };
    });
  }
}

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactLockfile, LockedArtifactRef, SnapshotHashes } from "../hash";
import { ARTIFACT_LOCK_ROLES, verifyArtifactLockfile, verifyContentAddressedRef } from "../hash";
import type { FactSnapshot } from "../facts/contracts";
import type { UserObservationSnapshot } from "../observations/contracts";
import { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json, withDirectoryLock } from "../runtime/fs.mjs";
import type { PlanEvaluationLock } from "./contracts";
import { verifyPlanEvaluationLock } from "./evaluation-lock";
import { authoritativeEvaluationHash } from "./evaluation";
import type {
  AuthoritativeEvaluationReceipt,
  EvaluationTargetBinding,
  LoadedArtifactInput,
  LoadedExternalSnapshot,
} from "../server/evaluation-service";

interface FactSnapshotLookup {
  getSnapshot(snapshotId: string): Promise<FactSnapshot>;
  getSnapshotAtRoot?(activeRoot: string, snapshotId: string): Promise<FactSnapshot | null>;
}

interface ObservationSnapshotLookup {
  getSnapshot(planId: string, snapshotId: string): Promise<UserObservationSnapshot>;
  getSnapshotAtRoot?(activeRoot: string, planId: string, snapshotId: string): Promise<UserObservationSnapshot | null>;
}

export interface EvaluationLockRepositoryOptions {
  root?: string;
  runtimeRoot?: string;
  coordinator?: RuntimeCoordinator;
  facts: FactSnapshotLookup;
  observations: ObservationSnapshotLookup;
  verifyFactSnapshotClosureAtRoot?(activeRoot: string, snapshotId: string, expectedHash: string): boolean | Promise<boolean>;
  verifyObservationSnapshotClosureAtRoot?(
    activeRoot: string,
    planId: string,
    snapshotId: string,
    expectedConfigHash: string,
    expectedHash: string,
  ): boolean | Promise<boolean>;
  verifyArtifact(ref: LockedArtifactRef): boolean | Promise<boolean>;
  verifyArtifactAtRoot?(activeRoot: string, ref: LockedArtifactRef): boolean | Promise<boolean>;
  /** Verifies price, requirement, simulation-input and any other non-repository snapshot authority. */
  verifyExternalSnapshotHashes(hashes: SnapshotHashes): boolean | Promise<boolean>;
  verifyExternalSnapshotHashesAtRoot?(activeRoot: string, hashes: SnapshotHashes): boolean | Promise<boolean>;
}

type Envelope =
  | { schemaVersion: "evaluation-lock-envelope-v1"; kind: "artifact-lockfile"; checksum: string; payload: ArtifactLockfile }
  | { schemaVersion: "evaluation-lock-envelope-v1"; kind: "evaluation-lock"; checksum: string; payload: PlanEvaluationLock }
  | { schemaVersion: "evaluation-lock-envelope-v1"; kind: "evaluation-receipt"; checksum: string; payload: AuthoritativeEvaluationReceipt }
  | { schemaVersion: "evaluation-lock-envelope-v1"; kind: "evaluation-current"; checksum: string; payload: CurrentEvaluationPointer }
  | { schemaVersion: "evaluation-lock-envelope-v1"; kind: "evaluation-artifact"; checksum: string; payload: LoadedArtifactInput }
  | { schemaVersion: "evaluation-lock-envelope-v1"; kind: "evaluation-external"; checksum: string; payload: StoredExternalSnapshot };

interface StoredExternalSnapshot {
  role: "requirementSpec" | "priceSnapshot" | "simulationInput";
  snapshot: LoadedExternalSnapshot;
}

interface CurrentEvaluationPointer {
  schemaVersion: "evaluation-current-v1";
  planId: string;
  target: EvaluationTargetBinding;
  receiptHash: string;
  evaluationLockHash: string;
  evaluationHash: string;
}

export interface IssuedEvaluationProof {
  planId: string;
  target: EvaluationTargetBinding;
  configHash: string;
  evaluationHash: string;
  evaluatedAt: string;
  evaluationLock: PlanEvaluationLock;
}

export type ImmutableVersionEvaluationProof = Omit<IssuedEvaluationProof, "target">;

const SHA256 = /^[a-f0-9]{64}$/;

export class EvaluationLockRepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input", message: string) {
    super(message);
    this.name = "EvaluationLockRepositoryError";
  }
}

export class EvaluationReplayUnavailableError extends Error {
  readonly code = "non_replayable" as const;
  constructor(readonly missingRoles: string[]) {
    super(`evaluation is non_replayable; missingRoles=${missingRoles.join(",")}`);
    this.name = "EvaluationReplayUnavailableError";
  }
}

function clone<T>(value: T): T { return structuredClone(value); }

export class EvaluationLockRepository {
  private readonly root: string;
  private readonly coordinator: RuntimeCoordinator | undefined;

  constructor(private readonly options: EvaluationLockRepositoryOptions) {
    const runtimeRoot = path.resolve(options.runtimeRoot ?? options.coordinator?.root ?? path.join(process.cwd(), "runtime"));
    this.root = path.resolve(options.root ?? path.join(runtimeRoot, "snapshots"));
    this.coordinator = options.root ? undefined : options.coordinator ?? new RuntimeCoordinator({ root: runtimeRoot });
  }

  private artifactFile(root: string, hash: string): string {
    if (!SHA256.test(hash)) throw new EvaluationLockRepositoryError("invalid_input", "artifact lockfile hash invalid");
    return confined(root, "artifact-lockfiles", `${hash}.json`);
  }

  private lockFile(root: string, hash: string): string {
    if (!SHA256.test(hash)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock hash invalid");
    return confined(root, "evaluation-locks", `${hash}.json`);
  }

  private artifactPayloadFile(root: string, hash: string): string {
    if (!SHA256.test(hash)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation artifact identity invalid");
    return confined(root, "evaluation-artifacts", `${hash}.json`);
  }

  private externalSnapshotFile(root: string, role: StoredExternalSnapshot["role"], hash: string): string {
    if (!SHA256.test(hash)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation external identity invalid");
    return confined(root, "evaluation-external", role, `${hash}.json`);
  }

  private targetKey(target: EvaluationTargetBinding): string {
    if (target.kind === "draft") {
      if (!Number.isInteger(target.draftRevision) || target.draftRevision < 0) throw new EvaluationLockRepositoryError("invalid_input", "evaluation receipt draft target invalid");
      return `draft-${target.draftRevision}`;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(target.versionId)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation receipt version target invalid");
    return `version-${target.versionId}`;
  }

  private receiptFile(root: string, planId: string, target: EvaluationTargetBinding, receiptHash: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(planId) || !SHA256.test(receiptHash)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation receipt identity invalid");
    return confined(root, "evaluation-receipts", planId, this.targetKey(target), `${receiptHash}.json`);
  }

  private currentFile(root: string, planId: string, target: EvaluationTargetBinding): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(planId)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation current owner invalid");
    return confined(root, "evaluation-current", planId, `${this.targetKey(target)}.json`);
  }

  private async boundary<T>(write: boolean, operation: (snapshotRoot: string, activeRoot?: string) => Promise<T>): Promise<T> {
    if (this.coordinator) {
      await this.coordinator.initialize();
      if (write) return (await this.coordinator.withWrite(({ activeRoot }: { activeRoot: string }) => operation(confined(activeRoot, "snapshots"), activeRoot))).result as T;
      return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) => operation(confined(activeRoot, "snapshots"), activeRoot))).result as T;
    }
    return withDirectoryLock(confined(this.root, ".locks", "evaluation-locks"), () => operation(this.root));
  }

  private async readEnvelope(file: string, kind: Envelope["kind"], optional = false): Promise<Envelope["payload"] | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return null;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new EvaluationLockRepositoryError("not_found", `${kind} authority was not found`);
      throw new EvaluationLockRepositoryError("corrupt_data", `${kind} authority cannot be read`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvaluationLockRepositoryError("corrupt_data", `${kind} envelope invalid`);
    const envelope = value as Envelope;
    if (envelope.schemaVersion !== "evaluation-lock-envelope-v1" || envelope.kind !== kind
      || envelope.checksum !== sha256Json(envelope.payload)) throw new EvaluationLockRepositoryError("corrupt_data", `${kind} envelope checksum invalid`);
    return clone(envelope.payload);
  }

  private async writeEnvelope(file: string, kind: Envelope["kind"], payload: Envelope["payload"]): Promise<void> {
    await atomicWriteJson(file, { schemaVersion: "evaluation-lock-envelope-v1", kind, checksum: sha256Json(payload), payload });
  }

  private async readArtifactPayloadAt(root: string, hash: string, optional = false): Promise<LoadedArtifactInput | null> {
    const input = await this.readEnvelope(this.artifactPayloadFile(root, hash), "evaluation-artifact", optional) as LoadedArtifactInput | null;
    if (!input) return null;
    const ref = {
      ref: input.ref.ref,
      hashSpecVersion: input.ref.hashSpecVersion,
      algorithm: input.ref.algorithm,
      contentHash: input.ref.contentHash,
      domain: input.ref.domain,
      schemaVersion: input.ref.schemaVersion,
      canonicalizationPolicyId: input.ref.canonicalizationPolicyId,
    };
    if (input.ref.contentHash !== hash || !ARTIFACT_LOCK_ROLES.includes(input.ref.role)
      || !await verifyContentAddressedRef(input.payload, ref)) {
      throw new EvaluationLockRepositoryError("corrupt_data", "persisted evaluation artifact closure invalid");
    }
    return clone(input);
  }

  /** Persists exact replay bytes while the outer evaluation transaction owns the barrier. */
  async putArtifactPayloadAtRoot(activeRoot: string, input: LoadedArtifactInput): Promise<LoadedArtifactInput> {
    const root = confined(activeRoot, "snapshots");
    const candidate = clone(input);
    const ref = {
      ref: candidate.ref.ref,
      hashSpecVersion: candidate.ref.hashSpecVersion,
      algorithm: candidate.ref.algorithm,
      contentHash: candidate.ref.contentHash,
      domain: candidate.ref.domain,
      schemaVersion: candidate.ref.schemaVersion,
      canonicalizationPolicyId: candidate.ref.canonicalizationPolicyId,
    };
    if (!ARTIFACT_LOCK_ROLES.includes(candidate.ref.role)
      || !await verifyContentAddressedRef(candidate.payload, ref)) {
      throw new EvaluationLockRepositoryError("invalid_input", "evaluation artifact payload/ref invalid");
    }
    const file = this.artifactPayloadFile(root, candidate.ref.contentHash);
    const current = await this.readEnvelope(file, "evaluation-artifact", true) as LoadedArtifactInput | null;
    if (current && sha256Json(current) !== sha256Json(candidate)) throw new EvaluationLockRepositoryError("conflict", "evaluation artifact identity collision");
    if (!current) await this.writeEnvelope(file, "evaluation-artifact", candidate);
    return clone((await this.readArtifactPayloadAt(root, candidate.ref.contentHash))!);
  }

  /**
   * Hydrates immutable replay bytes by the issued lock's exact role refs. It
   * never consults the active registry/catalog and reports incomplete portable
   * history as non_replayable instead of silently rebuilding newer artifacts.
   */
  async hydrateArtifactInputsAtRoot(activeRoot: string, lock: PlanEvaluationLock): Promise<Record<(typeof ARTIFACT_LOCK_ROLES)[number], LoadedArtifactInput>> {
    if (!await verifyPlanEvaluationLock(lock)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation replay lock hash invalid");
    const root = confined(activeRoot, "snapshots");
    const lockfile = await this.readEnvelope(this.artifactFile(root, lock.artifactLockfileHash), "artifact-lockfile", true) as ArtifactLockfile | null;
    if (!lockfile || !await verifyArtifactLockfile(lockfile) || lockfile.lockfileHash !== lock.artifactLockfileHash) {
      throw new EvaluationReplayUnavailableError(["artifactLockfile"]);
    }
    const expectedArtifacts: Array<[keyof SnapshotHashes, (typeof ARTIFACT_LOCK_ROLES)[number]]> = [
      ["ruleSetHash", "ruleSet"], ["systemProfileHash", "systemProfile"], ["adapterSnapshotHash", "adapterSnapshot"],
      ["engineHash", "engine"], ["simulationModelHash", "simulationModel"],
    ];
    if (expectedArtifacts.some(([field, role]) => lock.snapshotHashes[field] !== lockfile.artifacts[role].contentHash)) {
      throw new EvaluationLockRepositoryError("corrupt_data", "evaluation replay lock/artifact closure mismatch");
    }
    const result = {} as Record<(typeof ARTIFACT_LOCK_ROLES)[number], LoadedArtifactInput>;
    const missingRoles: string[] = [];
    for (const role of ARTIFACT_LOCK_ROLES) {
      const input = await this.readArtifactPayloadAt(root, lockfile.artifacts[role].contentHash, true);
      if (!input) {
        missingRoles.push(role);
        continue;
      }
      if (sha256Json(input.ref) !== sha256Json(lockfile.artifacts[role])) {
        throw new EvaluationLockRepositoryError("corrupt_data", `evaluation replay ${role} ref mismatch`);
      }
      result[role] = input;
    }
    if (missingRoles.length) throw new EvaluationReplayUnavailableError(missingRoles);
    return clone(result);
  }

  private async readExternalSnapshotAt(
    root: string,
    role: StoredExternalSnapshot["role"],
    hash: string,
    optional = false,
  ): Promise<LoadedExternalSnapshot | null> {
    const stored = await this.readEnvelope(this.externalSnapshotFile(root, role, hash), "evaluation-external", optional) as StoredExternalSnapshot | null;
    if (!stored) return null;
    if (stored.role !== role || stored.snapshot.ref.contentHash !== hash
      || !await verifyContentAddressedRef(stored.snapshot.payload, stored.snapshot.ref)) {
      throw new EvaluationLockRepositoryError("corrupt_data", "persisted evaluation external closure invalid");
    }
    return clone(stored.snapshot);
  }

  /** Called only after the pipeline has performed the role-specific semantic validation. */
  async putExternalSnapshotAtRoot(
    activeRoot: string,
    role: StoredExternalSnapshot["role"],
    snapshot: LoadedExternalSnapshot,
  ): Promise<LoadedExternalSnapshot> {
    const root = confined(activeRoot, "snapshots");
    const candidate: StoredExternalSnapshot = { role, snapshot: clone(snapshot) };
    if (!await verifyContentAddressedRef(candidate.snapshot.payload, candidate.snapshot.ref)) {
      throw new EvaluationLockRepositoryError("invalid_input", "evaluation external payload/ref invalid");
    }
    const file = this.externalSnapshotFile(root, role, candidate.snapshot.ref.contentHash);
    const current = await this.readEnvelope(file, "evaluation-external", true) as StoredExternalSnapshot | null;
    if (current && sha256Json(current) !== sha256Json(candidate)) throw new EvaluationLockRepositoryError("conflict", "evaluation external identity collision");
    if (!current) await this.writeEnvelope(file, "evaluation-external", candidate);
    return clone((await this.readExternalSnapshotAt(root, role, candidate.snapshot.ref.contentHash))!);
  }

  async hydrateExternalInputsAtRoot(activeRoot: string, lock: PlanEvaluationLock): Promise<{
    requirementSpec: LoadedExternalSnapshot;
    priceSnapshot: LoadedExternalSnapshot;
    simulationInput: LoadedExternalSnapshot;
  }> {
    if (!await verifyPlanEvaluationLock(lock)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation replay lock hash invalid");
    const root = confined(activeRoot, "snapshots");
    const bindings = [
      ["requirementSpec", lock.snapshotHashes.requirementSpecHash],
      ["priceSnapshot", lock.snapshotHashes.priceSnapshotHash],
      ["simulationInput", lock.snapshotHashes.simulationInputHash],
    ] as const;
    const result = {} as {
      requirementSpec: LoadedExternalSnapshot;
      priceSnapshot: LoadedExternalSnapshot;
      simulationInput: LoadedExternalSnapshot;
    };
    const missingRoles: string[] = [];
    for (const [role, hash] of bindings) {
      const snapshot = await this.readExternalSnapshotAt(root, role, hash, true);
      if (!snapshot) missingRoles.push(role);
      else result[role] = snapshot;
    }
    if (missingRoles.length) throw new EvaluationReplayUnavailableError(missingRoles);
    return clone(result);
  }

  private async validateArtifactClosure(lockfile: ArtifactLockfile, activeRoot?: string): Promise<void> {
    if (!await verifyArtifactLockfile(lockfile)) throw new EvaluationLockRepositoryError("invalid_input", "artifact lockfile hash invalid");
    const root = activeRoot ? confined(activeRoot, "snapshots") : this.root;
    for (const role of ARTIFACT_LOCK_ROLES) {
      const ref = lockfile.artifacts[role];
      const persisted = await this.readArtifactPayloadAt(root, ref.contentHash, true);
      const valid = persisted
        ? persisted.ref.role === role && sha256Json(persisted.ref) === sha256Json(ref)
        : activeRoot
          ? Boolean(this.options.verifyArtifactAtRoot && await this.options.verifyArtifactAtRoot(activeRoot, ref))
          : await this.options.verifyArtifact(ref);
      if (!valid) throw new EvaluationLockRepositoryError("invalid_input", `artifact lockfile ${role} closure invalid`);
    }
  }

  private async putArtifactLockfileAt(root: string, candidate: ArtifactLockfile, activeRoot?: string): Promise<ArtifactLockfile> {
    await this.validateArtifactClosure(candidate, activeRoot);
    const file = this.artifactFile(root, candidate.lockfileHash);
    const current = await this.readEnvelope(file, "artifact-lockfile", true) as ArtifactLockfile | null;
    if (current) {
      if (sha256Json(current) !== sha256Json(candidate)) throw new EvaluationLockRepositoryError("conflict", "artifact lockfile identity collision");
      return current;
    }
    await this.writeEnvelope(file, "artifact-lockfile", candidate);
    return clone(candidate);
  }

  async putArtifactLockfile(lockfile: ArtifactLockfile): Promise<ArtifactLockfile> {
    const candidate = clone(lockfile);
    return this.boundary(true, (root, activeRoot) => this.putArtifactLockfileAt(root, candidate, activeRoot));
  }

  /**
   * Persists an artifact lock while the caller already owns the shared runtime
   * write barrier. This method never resolves the active pointer or reacquires
   * the coordinator, so every closure lookup stays on the supplied generation.
   */
  async putArtifactLockfileAtRoot(activeRoot: string, lockfile: ArtifactLockfile): Promise<ArtifactLockfile> {
    const candidate = clone(lockfile);
    return this.putArtifactLockfileAt(confined(activeRoot, "snapshots"), candidate, activeRoot);
  }

  private async readArtifactAt(root: string, hash: string, activeRoot?: string): Promise<ArtifactLockfile> {
    const lockfile = await this.readEnvelope(this.artifactFile(root, hash), "artifact-lockfile") as ArtifactLockfile;
    if (!lockfile || lockfile.lockfileHash !== hash) throw new EvaluationLockRepositoryError("corrupt_data", "artifact lockfile path identity invalid");
    await this.validateArtifactClosure(lockfile, activeRoot);
    return lockfile;
  }

  private async validateLockClosure(root: string, lock: PlanEvaluationLock, activeRoot?: string): Promise<void> {
    if (!await verifyPlanEvaluationLock(lock)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock content hash invalid");
    if (activeRoot && (!this.options.facts.getSnapshotAtRoot || !this.options.observations.getSnapshotAtRoot
      || !this.options.verifyFactSnapshotClosureAtRoot || !this.options.verifyObservationSnapshotClosureAtRoot)) {
      throw new EvaluationLockRepositoryError("invalid_input", "coordinated evaluation closure provider unavailable");
    }
    let factSnapshot: FactSnapshot | null;
    let observationSnapshot: UserObservationSnapshot | null;
    try {
      factSnapshot = activeRoot
        ? await this.options.facts.getSnapshotAtRoot!(activeRoot, lock.factSnapshotId)
        : await this.options.facts.getSnapshot(lock.factSnapshotId);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "not_found") throw error;
      factSnapshot = null;
    }
    try {
      observationSnapshot = activeRoot
        ? await this.options.observations.getSnapshotAtRoot!(activeRoot, lock.planId, lock.userObservationSnapshotId)
        : await this.options.observations.getSnapshot(lock.planId, lock.userObservationSnapshotId);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "not_found") throw error;
      observationSnapshot = null;
    }
    if (!factSnapshot || factSnapshot.contentHash !== lock.snapshotHashes.factSnapshotHash) throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock fact snapshot closure invalid");
    if (!observationSnapshot || observationSnapshot.planId !== lock.planId
      || observationSnapshot.contentHash !== lock.snapshotHashes.userObservationSnapshotHash) throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock observation snapshot closure invalid");
    if (activeRoot && (!await this.options.verifyFactSnapshotClosureAtRoot!(activeRoot, lock.factSnapshotId, lock.snapshotHashes.factSnapshotHash)
      || !await this.options.verifyObservationSnapshotClosureAtRoot!(
        activeRoot,
        lock.planId,
        lock.userObservationSnapshotId,
        lock.snapshotHashes.configHash,
        lock.snapshotHashes.userObservationSnapshotHash,
      ))) {
      throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock member payload closure invalid");
    }
    const artifactLockfile = await this.readArtifactAt(root, lock.artifactLockfileHash, activeRoot);
    const expectedArtifacts: Array<[keyof SnapshotHashes, keyof ArtifactLockfile["artifacts"]]> = [
      ["ruleSetHash", "ruleSet"], ["systemProfileHash", "systemProfile"], ["adapterSnapshotHash", "adapterSnapshot"],
      ["engineHash", "engine"], ["simulationModelHash", "simulationModel"],
    ];
    if (expectedArtifacts.some(([snapshotField, role]) => lock.snapshotHashes[snapshotField] !== artifactLockfile.artifacts[role].contentHash)) {
      throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock artifact snapshot hashes do not match lockfile");
    }
    const storedExternal = await Promise.all([
      this.readExternalSnapshotAt(root, "requirementSpec", lock.snapshotHashes.requirementSpecHash, true),
      this.readExternalSnapshotAt(root, "priceSnapshot", lock.snapshotHashes.priceSnapshotHash, true),
      this.readExternalSnapshotAt(root, "simulationInput", lock.snapshotHashes.simulationInputHash, true),
    ]);
    const external = storedExternal.every(Boolean)
      || (activeRoot
        ? Boolean(this.options.verifyExternalSnapshotHashesAtRoot
          && await this.options.verifyExternalSnapshotHashesAtRoot(activeRoot, lock.snapshotHashes))
        : await this.options.verifyExternalSnapshotHashes(lock.snapshotHashes));
    if (!external) throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock external snapshot closure invalid");
  }

  private async putEvaluationLockAt(root: string, candidate: PlanEvaluationLock, activeRoot?: string): Promise<PlanEvaluationLock> {
    await this.validateLockClosure(root, candidate, activeRoot);
    const file = this.lockFile(root, candidate.contentHash);
    const current = await this.readEnvelope(file, "evaluation-lock", true) as PlanEvaluationLock | null;
    if (current) {
      if (sha256Json(current) !== sha256Json(candidate)) throw new EvaluationLockRepositoryError("conflict", "evaluation lock identity collision");
      return current;
    }
    await this.writeEnvelope(file, "evaluation-lock", candidate);
    return clone(candidate);
  }

  async putEvaluationLock(lock: PlanEvaluationLock): Promise<PlanEvaluationLock> {
    const candidate = clone(lock);
    return this.boundary(true, (root, activeRoot) => this.putEvaluationLockAt(root, candidate, activeRoot));
  }

  /** See putArtifactLockfileAtRoot. The lock and every referenced snapshot are verified at exactly this root. */
  async putEvaluationLockAtRoot(activeRoot: string, lock: PlanEvaluationLock): Promise<PlanEvaluationLock> {
    const candidate = clone(lock);
    return this.putEvaluationLockAt(confined(activeRoot, "snapshots"), candidate, activeRoot);
  }

  private async readLockAt(root: string, contentHash: string, activeRoot?: string): Promise<PlanEvaluationLock> {
    const lock = await this.readEnvelope(this.lockFile(root, contentHash), "evaluation-lock") as PlanEvaluationLock;
    if (!lock || lock.contentHash !== contentHash) throw new EvaluationLockRepositoryError("corrupt_data", "evaluation lock path identity invalid");
    await this.validateLockClosure(root, lock, activeRoot);
    return lock;
  }

  async verify(lock: PlanEvaluationLock): Promise<boolean> {
    try { return await this.boundary(false, async (root, activeRoot) => sha256Json(await this.readLockAt(root, lock.contentHash, activeRoot)) === sha256Json(lock)); }
    catch { return false; }
  }

  async verifyAtRoot(activeRoot: string, lock: PlanEvaluationLock): Promise<boolean> {
    try { return sha256Json(await this.readLockAt(confined(activeRoot, "snapshots"), lock.contentHash, activeRoot)) === sha256Json(lock); }
    catch { return false; }
  }

  private async readReceiptAt(root: string, planId: string, target: EvaluationTargetBinding, receiptHash: string): Promise<AuthoritativeEvaluationReceipt> {
    const receipt = await this.readEnvelope(this.receiptFile(root, planId, target, receiptHash), "evaluation-receipt") as AuthoritativeEvaluationReceipt;
    if (!receipt || receipt.schemaVersion !== "authoritative-evaluation-receipt-v1"
      || receipt.planId !== planId || sha256Json(receipt) !== receiptHash
      || sha256Json(receipt.target) !== sha256Json(target)
      || !SHA256.test(receipt.configHash) || !SHA256.test(receipt.evaluationHash)
      || receipt.evaluationHash !== await authoritativeEvaluationHash(receipt.evaluation, receipt.evaluationLock)
      || receipt.evaluationLock.planId !== planId
      || receipt.evaluationLock.snapshotHashes.configHash !== receipt.configHash
      || !Number.isInteger(receipt.runtimeGeneration) || receipt.runtimeGeneration < 1
      || !Number.isInteger(receipt.preparedRevision) || receipt.preparedRevision < 0
      || !Number.isInteger(receipt.committedRevision) || receipt.committedRevision !== receipt.preparedRevision + 1
      || !Number.isFinite(Date.parse(receipt.evaluatedAt))
      || !["hit", "miss"].includes(receipt.cacheStatus)) {
      throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt integrity invalid");
    }
    return receipt;
  }

  /** Called by the authoritative pipeline while its commit barrier is held. */
  async commitAtRoot(
    activeRoot: string,
    receipt: AuthoritativeEvaluationReceipt,
    options: { installCurrent?: boolean } = {},
  ): Promise<AuthoritativeEvaluationReceipt> {
    const root = confined(activeRoot, "snapshots");
    const candidate = clone(receipt);
    if (candidate.schemaVersion !== "authoritative-evaluation-receipt-v1" || candidate.evaluationLock.planId !== candidate.planId
      || candidate.evaluationLock.snapshotHashes.configHash !== candidate.configHash
      || candidate.evaluationHash !== await authoritativeEvaluationHash(candidate.evaluation, candidate.evaluationLock)
      || candidate.committedRevision !== candidate.preparedRevision + 1) {
      throw new EvaluationLockRepositoryError("invalid_input", "evaluation receipt payload invalid");
    }
    await this.readLockAt(root, candidate.evaluationLock.contentHash, activeRoot);
    const receiptHash = sha256Json(candidate);
    const file = this.receiptFile(root, candidate.planId, candidate.target, receiptHash);
    const existing = await this.readEnvelope(file, "evaluation-receipt", true) as AuthoritativeEvaluationReceipt | null;
    if (existing) {
      if (sha256Json(existing) !== receiptHash) throw new EvaluationLockRepositoryError("conflict", "evaluation receipt identity collision");
    } else {
      await this.writeEnvelope(file, "evaluation-receipt", candidate);
    }
    if (options.installCurrent !== false) {
      const pointer: CurrentEvaluationPointer = {
        schemaVersion: "evaluation-current-v1",
        planId: candidate.planId,
        target: clone(candidate.target),
        receiptHash,
        evaluationLockHash: candidate.evaluationLock.contentHash,
        evaluationHash: candidate.evaluationHash,
      };
      await this.writeEnvelope(this.currentFile(root, candidate.planId, candidate.target), "evaluation-current", pointer);
    }
    return clone(await this.readReceiptAt(root, candidate.planId, candidate.target, receiptHash));
  }

  /** Reads an immutable prior result only after its receipt and lock closures validate at this exact root. */
  async getReceiptByLockAtRoot(
    activeRoot: string,
    planId: string,
    target: EvaluationTargetBinding,
    evaluationLockHash: string,
  ): Promise<AuthoritativeEvaluationReceipt | null> {
    if (!SHA256.test(evaluationLockHash)) throw new EvaluationLockRepositoryError("invalid_input", "evaluation lock identity invalid");
    const root = confined(activeRoot, "snapshots");
    const targetRoot = path.dirname(this.receiptFile(root, planId, target, `${"0".repeat(64)}`));
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(targetRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))) {
      throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt target contains unknown authority");
    }
    const matches: Array<{ receiptHash: string; receipt: AuthoritativeEvaluationReceipt }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const receiptHash = entry.name.slice(0, -5);
      const receipt = await this.readReceiptAt(root, planId, target, receiptHash);
      if (receipt.evaluationLock.contentHash === evaluationLockHash) matches.push({ receiptHash, receipt });
    }
    if (!matches.length) return null;
    await this.readLockAt(root, evaluationLockHash, activeRoot);
    matches.sort((left, right) => right.receipt.committedRevision - left.receipt.committedRevision
      || right.receipt.evaluatedAt.localeCompare(left.receipt.evaluatedAt)
      || right.receiptHash.localeCompare(left.receiptHash));
    return clone(matches[0]!.receipt);
  }

  /**
   * Resolves the exact issued receipt tuple embedded by an immutable
   * PlanVersion. A version is normally created from a draft-target receipt, so
   * forcing a fresh version-target evaluation just to read its procedure both
   * changes the receipt target and turns a read into an expensive writer.
   */
  async getIssuedVersionReceiptAtRoot(
    activeRoot: string,
    proof: ImmutableVersionEvaluationProof,
  ): Promise<AuthoritativeEvaluationReceipt | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(proof.planId)
      || !SHA256.test(proof.configHash) || !SHA256.test(proof.evaluationHash)
      || !Number.isFinite(Date.parse(proof.evaluatedAt))
      || !await verifyPlanEvaluationLock(proof.evaluationLock)
      || proof.evaluationLock.planId !== proof.planId
      || proof.evaluationLock.snapshotHashes.configHash !== proof.configHash) {
      throw new EvaluationLockRepositoryError("invalid_input", "immutable version evaluation proof invalid");
    }
    const root = confined(activeRoot, "snapshots");
    const planRoot = confined(root, "evaluation-receipts", proof.planId);
    let targetEntries: import("node:fs").Dirent[];
    try { targetEntries = await readdir(planRoot, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const matches: Array<{ key: string; receiptHash: string; receipt: AuthoritativeEvaluationReceipt }> = [];
    for (const targetEntry of targetEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (targetEntry.isSymbolicLink() || !targetEntry.isDirectory()) {
        throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt plan contains unknown authority");
      }
      const draft = /^draft-(0|[1-9][0-9]*)$/.exec(targetEntry.name);
      const version = /^version-([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(targetEntry.name);
      if (!draft && !version) throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt target directory invalid");
      const target: EvaluationTargetBinding = draft
        ? { kind: "draft", draftRevision: Number(draft[1]) }
        : { kind: "version", versionId: version![1]! };
      const files = await readdir(confined(planRoot, targetEntry.name), { withFileTypes: true });
      if (files.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))) {
        throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt target contains unknown authority");
      }
      for (const entry of files.sort((left, right) => left.name.localeCompare(right.name))) {
        const receiptHash = entry.name.slice(0, -5);
        const receipt = await this.readReceiptAt(root, proof.planId, target, receiptHash);
        if (receipt.configHash === proof.configHash
          && receipt.evaluationHash === proof.evaluationHash
          && receipt.evaluatedAt === proof.evaluatedAt
          && sha256Json(receipt.evaluationLock) === sha256Json(proof.evaluationLock)) {
          matches.push({ key: targetEntry.name, receiptHash, receipt });
        }
      }
    }
    if (!matches.length) return null;
    await this.readLockAt(root, proof.evaluationLock.contentHash, activeRoot);
    matches.sort((left, right) => left.key.localeCompare(right.key) || left.receiptHash.localeCompare(right.receiptHash));
    return clone(matches[0]!.receipt);
  }

  /** Save/version write gate: a self-consistent caller hash is not an issued evaluation. */
  async verifyIssuedEvaluationAtRoot(activeRoot: string, proof: IssuedEvaluationProof): Promise<boolean> {
    try {
      const receipt = await this.getReceiptByLockAtRoot(
        activeRoot,
        proof.planId,
        proof.target,
        proof.evaluationLock.contentHash,
      );
      return Boolean(receipt
        && receipt.planId === proof.planId
        && receipt.configHash === proof.configHash
        && receipt.evaluationHash === proof.evaluationHash
        && receipt.evaluatedAt === proof.evaluatedAt
        && sha256Json(receipt.target) === sha256Json(proof.target)
        && sha256Json(receipt.evaluationLock) === sha256Json(proof.evaluationLock));
    } catch {
      return false;
    }
  }

  /** Resolves currentness from repository state; transport callers cannot nominate a lock. */
  async currentLockAtRoot(activeRoot: string, planId: string, target: EvaluationTargetBinding): Promise<PlanEvaluationLock | null> {
    const root = confined(activeRoot, "snapshots");
    const pointer = await this.readEnvelope(this.currentFile(root, planId, target), "evaluation-current", true) as CurrentEvaluationPointer | null;
    if (!pointer) return null;
    if (pointer.schemaVersion !== "evaluation-current-v1" || pointer.planId !== planId
      || sha256Json(pointer.target) !== sha256Json(target)
      || !SHA256.test(pointer.receiptHash) || !SHA256.test(pointer.evaluationLockHash) || !SHA256.test(pointer.evaluationHash)) {
      throw new EvaluationLockRepositoryError("corrupt_data", "evaluation current pointer invalid");
    }
    const receipt = await this.readReceiptAt(root, planId, target, pointer.receiptHash);
    if (receipt.evaluationLock.contentHash !== pointer.evaluationLockHash || receipt.evaluationHash !== pointer.evaluationHash) {
      throw new EvaluationLockRepositoryError("corrupt_data", "evaluation current pointer closure invalid");
    }
    return clone(await this.readLockAt(root, pointer.evaluationLockHash, activeRoot));
  }

  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "evaluation-locks"; revision: number; manifestHash: string; snapshotPointers: string[]; nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const root = confined(activeRoot, "snapshots");
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await readdir(confined(root, "evaluation-locks"), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))) throw new EvaluationLockRepositoryError("corrupt_data", "evaluation lock root contains unknown authority");
    const locks = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => this.readLockAt(root, entry.name.slice(0, -5), activeRoot)));
    const receipts: Array<{ receiptHash: string; receipt: AuthoritativeEvaluationReceipt }> = [];
    const receiptRoot = confined(root, "evaluation-receipts");
    let planEntries: import("node:fs").Dirent[] = [];
    try { planEntries = await readdir(receiptRoot, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (planEntries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt root contains unknown authority");
    for (const planEntry of planEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      const planRoot = confined(receiptRoot, planEntry.name);
      const targetEntries = await readdir(planRoot, { withFileTypes: true });
      if (targetEntries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt plan contains unknown authority");
      for (const targetEntry of targetEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        const targetRoot = confined(planRoot, targetEntry.name);
        const receiptEntries = await readdir(targetRoot, { withFileTypes: true });
        if (receiptEntries.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))) throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt target contains unknown authority");
        for (const receiptEntry of receiptEntries.sort((a, b) => a.name.localeCompare(b.name))) {
          const receiptHash = receiptEntry.name.slice(0, -5);
          const raw = await this.readEnvelope(confined(targetRoot, receiptEntry.name), "evaluation-receipt") as AuthoritativeEvaluationReceipt;
          if (raw.planId !== planEntry.name || this.targetKey(raw.target) !== targetEntry.name
            || sha256Json(raw) !== receiptHash) throw new EvaluationLockRepositoryError("corrupt_data", "evaluation receipt path identity invalid");
          receipts.push({ receiptHash, receipt: await this.readReceiptAt(root, raw.planId, raw.target, receiptHash) });
        }
      }
    }
    return {
      providerId: "evaluation-locks", revision: locks.length + receipts.length,
      manifestHash: sha256Json({
        locks: locks.map((lock) => ({ contentHash: lock.contentHash, planId: lock.planId })),
        receipts: receipts.map(({ receiptHash, receipt }) => ({ receiptHash, planId: receipt.planId, evaluationHash: receipt.evaluationHash })),
      }),
      snapshotPointers: [...locks.map((lock) => lock.contentHash), ...receipts.map(({ receiptHash }) => receiptHash)],
      nodes: [
        ...locks.map((lock) => `evaluation-lock:${lock.contentHash}`),
        ...receipts.map(({ receiptHash }) => `evaluation-receipt:${receiptHash}`),
      ],
      edges: [
        ...locks.flatMap((lock) => [
        { fromRef: `evaluation-lock:${lock.contentHash}`, toRef: `fact-snapshot:${lock.factSnapshotId}`, necessity: "required_for_replay" as const },
        { fromRef: `evaluation-lock:${lock.contentHash}`, toRef: `observation-snapshot:${lock.planId}:${lock.userObservationSnapshotId}`, necessity: "required_for_replay" as const },
        { fromRef: `evaluation-lock:${lock.contentHash}`, toRef: `artifact-lockfile:${lock.artifactLockfileHash}`, necessity: "required_for_replay" as const },
        ]),
        ...receipts.map(({ receiptHash, receipt }) => ({
          fromRef: `evaluation-receipt:${receiptHash}`,
          toRef: `evaluation-lock:${receipt.evaluationLock.contentHash}`,
          necessity: "required_for_replay" as const,
        })),
      ],
    };
  }
}

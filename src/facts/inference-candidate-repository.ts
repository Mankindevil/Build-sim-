import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeCoordinator } from "../runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Json } from "../runtime/fs.mjs";
import {
  inferenceCandidateReferencesRuntime,
  validateFactInferenceCandidateEnvelopeRuntime,
  validateFactInferenceCandidateRuntime,
  type FactInferenceCandidateRecord,
} from "./inference-candidate-runtime.mjs";

const CANDIDATE_ID = /^fact-inference-candidate-sha256-[a-f0-9]{64}$/;

interface CandidateEnvelope {
  readonly schemaVersion: "fact-inference-candidate-envelope-v1";
  readonly kind: "fact-inference-candidate";
  readonly checksum: string;
  readonly payload: FactInferenceCandidateRecord;
}

export interface InferenceCandidateWriterContext {
  readonly activeRoot: string;
  readonly state: { readonly runtimeGeneration: number };
}

export class InferenceCandidateRepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "corrupt_data" | "invalid_input" | "fenced" | "cross_plan" | "stale",
    message: string,
  ) {
    super(message);
    this.name = "InferenceCandidateRepositoryError";
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return sha256Json(left) === sha256Json(right); }

export class InferenceCandidateRepository {
  constructor(readonly coordinator: RuntimeCoordinator) {}

  private directory(activeRoot: string): string {
    return confined(activeRoot, "facts", "inference-candidates");
  }

  private file(activeRoot: string, candidateId: string): string {
    if (!CANDIDATE_ID.test(candidateId)) {
      throw new InferenceCandidateRepositoryError("invalid_input", "fact inference candidate ID is invalid");
    }
    return confined(this.directory(activeRoot), `${candidateId}.json`);
  }

  async getAtRoot(activeRoot: string, candidateId: string, optional = false): Promise<FactInferenceCandidateRecord | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.file(activeRoot, candidateId), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return null;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new InferenceCandidateRepositoryError("not_found", "fact inference candidate was not found");
      }
      throw new InferenceCandidateRepositoryError("corrupt_data", "fact inference candidate cannot be read");
    }
    const errors = validateFactInferenceCandidateEnvelopeRuntime(value, candidateId);
    if (errors.length) throw new InferenceCandidateRepositoryError("corrupt_data", errors.join("; "));
    return clone((value as CandidateEnvelope).payload);
  }

  /**
   * Writer-only primitive. The service calls this from the same
   * RuntimeCoordinator.withWrite closure that resolved facts and rule bytes.
   */
  async putWithinWriter(
    context: InferenceCandidateWriterContext,
    candidate: FactInferenceCandidateRecord,
  ): Promise<FactInferenceCandidateRecord> {
    const errors = validateFactInferenceCandidateRuntime(candidate);
    if (errors.length) throw new InferenceCandidateRepositoryError("invalid_input", errors.join("; "));
    if (candidate.runtimeGeneration !== context.state.runtimeGeneration) {
      throw new InferenceCandidateRepositoryError("fenced", "fact inference candidate belongs to a stale runtime generation");
    }
    const existing = await this.getAtRoot(context.activeRoot, candidate.candidateId, true);
    if (existing) {
      if (!same(existing, candidate)) {
        throw new InferenceCandidateRepositoryError("conflict", "immutable fact inference candidate ID collision");
      }
      return existing;
    }
    const envelope: CandidateEnvelope = {
      schemaVersion: "fact-inference-candidate-envelope-v1",
      kind: "fact-inference-candidate",
      checksum: sha256Json(candidate),
      payload: clone(candidate),
    };
    await atomicWriteJson(this.file(context.activeRoot, candidate.candidateId), envelope);
    return clone(candidate);
  }

  async get(candidateId: string): Promise<FactInferenceCandidateRecord | null> {
    await this.coordinator.initialize();
    return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) =>
      this.getAtRoot(activeRoot, candidateId, true))).result;
  }

  async listAtRoot(activeRoot: string): Promise<FactInferenceCandidateRecord[]> {
    let entries;
    try { entries = await readdir(this.directory(activeRoot), { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new InferenceCandidateRepositoryError("corrupt_data", "fact inference candidate directory cannot be read");
    }
    const candidates: FactInferenceCandidateRecord[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidateId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
      if (!entry.isFile() || !CANDIDATE_ID.test(candidateId) || path.basename(entry.name) !== entry.name) {
        throw new InferenceCandidateRepositoryError("corrupt_data", "fact inference candidate directory entry is invalid");
      }
      const candidate = await this.getAtRoot(activeRoot, candidateId);
      if (!candidate) throw new InferenceCandidateRepositoryError("corrupt_data", "fact inference candidate disappeared");
      candidates.push(candidate);
    }
    return candidates;
  }

  async list(): Promise<FactInferenceCandidateRecord[]> {
    await this.coordinator.initialize();
    return (await this.coordinator.withConsistentSnapshot(({ activeRoot }: { activeRoot: string }) =>
      this.listAtRoot(activeRoot))).result;
  }

  /** Root-pinned provider shape for production graph/backup wiring. */
  async snapshotReferences(activeRoot: string): Promise<{
    providerId: "fact-inference-candidates";
    revision: 0;
    manifestHash: string;
    snapshotPointers: string[];
    nodes: string[];
    edges: Array<{ fromRef: string; toRef: string; necessity: "required_for_replay" }>;
  }> {
    const candidates = await this.listAtRoot(activeRoot);
    const nodes = candidates.map((candidate) => `fact-inference-candidate:${candidate.candidateId}`);
    return {
      providerId: "fact-inference-candidates",
      revision: 0,
      manifestHash: sha256Json(candidates.map(({ candidateId, contentHash }) => ({ candidateId, contentHash }))),
      snapshotPointers: [...nodes],
      nodes,
      edges: candidates.flatMap((candidate) => {
        const fromRef = `fact-inference-candidate:${candidate.candidateId}`;
        return (inferenceCandidateReferencesRuntime(candidate) ?? []).map(({ ref, necessity }) => ({ fromRef, toRef: ref, necessity }));
      }),
    };
  }
}

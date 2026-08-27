import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { AttachmentRepository } from "../src/attachments/repository";
import { ExecutionRepository } from "../src/build-execution/repository";
import type { BuildProcedure, ExecutionSession, ProcedureDependencyContext } from "../src/build-execution/contracts";
import { hashContent } from "../src/hash";
import { ObservationRepository } from "../src/observations/repository";
import type { UserObservation } from "../src/observations/contracts";
import { canonicalJson } from "../src/plans/canonical";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { createConsistentReferenceGraph, verifyReferenceGraph } from "../src/runtime/reference-graph.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function runtime() { const root = await mkdtemp(path.join(tmpdir(), "buildsim-reference-")); roots.push(root); const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test"); return coordinator; }
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const fixedHash = (letter: string) => letter.repeat(64);
const buildProcedure = (): BuildProcedure => ({ procedureId: "procedure", inputEvaluationHash: fixedHash("a"), procedureSafetyHash: fixedHash("b"), phases: ["mechanical"], steps: [{ stepId: "mount", phase: "mechanical", action: "Mount", dependsOn: [], instanceIds: ["board"], requirementIds: [], expectedResult: "mounted", failureAction: "stop", riskLevel: "normal", stopConditions: [], failureBranchStepIds: [], confirmationPolicy: "observation_required", safetyCritical: false, dependencyHashes: { spatialHash: fixedHash("c") }, dependencyHash: fixedHash("d"), evidenceRefs: ["manual"] }] });
const dependencyContext = (procedure: BuildProcedure, evaluatorArtifactHash = fixedHash("e")): ProcedureDependencyContext => ({ evaluatorArtifactRef: `sha256:${evaluatorArtifactHash}`, evaluatorArtifactHash, evaluatorVersion: "1", expectedInputEvaluationHash: procedure.inputEvaluationHash, expectedProcedureSafetyHash: procedure.procedureSafetyHash, expectedStepDependencyHashes: { mount: fixedHash("d") } });
function userObservation(): UserObservation {
  const base = { observationId: "observation-a", planId: "plan-a", subjectRef: { kind: "placement" as const, placementId: "placement-a" }, fieldId: "physical.clearance" as const, value: 4, unit: "mm" as const, uncertainty: { plusMinus: 0.5 }, method: "photo" as const, attachmentRefs: ["attachment-a"], confirmedByUser: true, observedAgainstConfigHash: fixedHash("a"), subjectRevisionHash: fixedHash("b"), capturedAt: "2026-08-27T00:00:00.000Z", validatedAt: "2026-08-27T00:01:00.000Z", status: "active" as const };
  return { ...base, contentHash: digest(base) };
}

describe("U1 consistent runtime reference graph", () => {
  it("binds provider snapshots, required closure, and the governed graph hash", async () => {
    const coordinator = await runtime();
    const repository = new FileArtifactRepository({ coordinator, now: () => "2026-08-01T00:00:00.000Z" });
    const child = await repository.put({ bytes: Buffer.from("child"), mediaType: "text/plain", privacyClass: "runtime_internal", kind: "fact", references: [] });
    const parent = await repository.put({ bytes: Buffer.from("parent"), mediaType: "text/plain", privacyClass: "private_user", kind: "active_snapshot", references: [{ ref: child.record.ref, necessity: "required_for_replay" }] });
    const graph = await createConsistentReferenceGraph({ coordinator, providers: [repository], requiredRoots: [parent.record.ref], now: () => "2026-08-02T00:00:00.000Z" });

    expect(verifyReferenceGraph(graph)).toEqual([]);
    expect(graph.edges).toContainEqual({ fromRef: parent.record.ref, toRef: child.record.ref, necessity: "required_for_replay" });
    expect(graph.graphHash).toBe(await hashContent(graph, { domain: "portable-reference-graph", schemaVersion: "portable-reference-graph-v1" }));
    expect(verifyReferenceGraph({ ...graph, nodes: graph.nodes.filter((ref: string) => ref !== child.record.ref) })).toEqual(expect.arrayContaining([expect.stringContaining("dangling")]));
  });

  it("holds the writer barrier until every provider snapshot finishes", async () => {
    const coordinator = await runtime();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const graphPromise = createConsistentReferenceGraph({ coordinator, requiredRoots: ["root"], providers: [{
      async snapshotReferences() { entered(); await releasePromise; return { providerId: "slow", revision: 0, manifestHash: "0".repeat(64), nodes: [], edges: [], snapshotPointers: [] }; },
    }] });
    await enteredPromise;
    let wrote = false;
    const writer = coordinator.withWrite(async () => { wrote = true; });
    await Promise.resolve();
    expect(wrote).toBe(false);
    release();
    await graphPromise;
    await writer;
    expect(wrote).toBe(true);
  });

  it("closes execution -> observation -> attachment -> blob references without repository re-entry", async () => {
    const coordinator = await runtime();
    const fixedNow = () => "2026-08-27T00:02:00.000Z";
    const attachments = new AttachmentRepository({ coordinator, now: fixedNow });
    const observations = new ObservationRepository({ coordinator, attachments, now: fixedNow, id: () => "snapshot-a" });
    const executions = new ExecutionRepository({ coordinator, now: fixedNow });
    const artifacts = new FileArtifactRepository({ coordinator, now: fixedNow });
    const evaluatorArtifact = await artifacts.put({ bytes: Buffer.from("evaluator-v1"), mediaType: "application/json", privacyClass: "runtime_internal", kind: "evaluator", references: [] });
    const planEvaluationProvider = {
      async snapshotReferences() {
        return {
          providerId: "plan-evaluation-test", revision: 0, manifestHash: fixedHash("f"), snapshotPointers: ["plan-version:version-a"],
          nodes: ["plan-version:version-a", `evaluation:${fixedHash("a")}`], edges: [],
        };
      },
    };
    await attachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("photo"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    await observations.put({ observation: userObservation() });
    await observations.createSnapshot("plan-a");
    const procedure = buildProcedure();
    const execution: ExecutionSession = { executionSessionId: "session-a", planVersionId: "version-a", procedureId: procedure.procedureId, evaluationHash: fixedHash("a"), procedureSafetyHash: procedure.procedureSafetyHash, status: "active", results: [{ stepId: "mount", result: "confirmed", at: "2026-08-27T00:03:00.000Z", actor: "user", confirmedAgainstDependencyHash: fixedHash("d"), observationIds: ["observation-a"] }] };
    await executions.create({ session: execution, procedure, dependencyContext: dependencyContext(procedure, evaluatorArtifact.record.sha256), leaseToken: "lease", leaseExpiresAt: "2026-08-27T01:00:00.000Z" });

    const graph = await createConsistentReferenceGraph({ coordinator, providers: [attachments, observations, executions, artifacts, planEvaluationProvider], requiredRoots: ["execution-session:session-a", "observation-snapshot:snapshot-a"], now: fixedNow });
    expect(verifyReferenceGraph(graph)).toEqual([]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      { fromRef: "execution-session:session-a", toRef: "observation:observation-a", necessity: "required_for_replay" },
      { fromRef: "execution-session:session-a", toRef: "plan-version:version-a", necessity: "required_for_replay" },
      { fromRef: "execution-session:session-a", toRef: `evaluation:${fixedHash("a")}`, necessity: "required_for_replay" },
      { fromRef: "execution-session:session-a", toRef: evaluatorArtifact.record.ref, necessity: "required_for_replay" },
      { fromRef: "observation:observation-a", toRef: "attachment:attachment-a", necessity: "required_for_replay" },
      { fromRef: "observation-snapshot:snapshot-a", toRef: "observation:observation-a", necessity: "required_for_replay" },
    ]));
    const withoutAttachments = await createConsistentReferenceGraph({ coordinator, providers: [observations, executions, artifacts, planEvaluationProvider], requiredRoots: [] as string[], now: fixedNow }).catch((error) => error as Error);
    expect(withoutAttachments).toBeInstanceOf(Error);
    expect((withoutAttachments as Error).message).toMatch(/dangling/);
    const withoutObservations = await createConsistentReferenceGraph({ coordinator, providers: [attachments, executions, artifacts, planEvaluationProvider], requiredRoots: [] as string[], now: fixedNow }).catch((error) => error as Error);
    expect(withoutObservations).toBeInstanceOf(Error);
    expect((withoutObservations as Error).message).toMatch(/dangling/);
    await expect(createConsistentReferenceGraph({ coordinator, providers: [attachments, observations, executions, planEvaluationProvider], now: fixedNow })).rejects.toThrow(/dangling/);
  });

  it("fails replay closure when an active observation still references a deleted attachment body", async () => {
    const coordinator = await runtime();
    const fixedNow = () => "2026-08-27T00:02:00.000Z";
    const attachments = new AttachmentRepository({ coordinator, now: fixedNow });
    const observations = new ObservationRepository({ coordinator, attachments, now: fixedNow });
    const saved = await attachments.put({ attachmentId: "attachment-a", planId: "plan-a", content: Buffer.from("photo"), mediaType: "image/jpeg", deletionPolicy: "retain_until_user_deletes" });
    await observations.put({ observation: userObservation() });
    await attachments.delete("attachment-a", { expectedRevision: saved.revision, expectedHash: saved.metadataHash });
    await expect(createConsistentReferenceGraph({ coordinator, providers: [attachments, observations] })).rejects.toThrow(/dangling/);
  });
});

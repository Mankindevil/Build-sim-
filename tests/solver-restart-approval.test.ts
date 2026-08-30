import { afterEach, describe, expect, it, vi } from "vitest";
import { solveWholeBuild, type SolverSearchCheckpoint } from "../src/solver/solve";
import { FileJobRepository } from "../src/jobs/repository";
import { DurableJobWorker } from "../src/jobs/worker";
import {
  SOLVER_ACCEPT_APPROVAL_TOOL_DEFINITION_HASH,
  SOLVER_ACCEPT_APPROVAL_TOOL_NAME,
  WholeBuildSolverService,
} from "../src/server/solver-service";
import { canonicalize } from "../src/hash";
import { AgentWriteApprovalAuthority } from "../src/agent/write-approval-authority";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import type { AgentToolContext } from "../src/agent/contracts";
import { createBuildSimTools } from "../src/server/domain-tools";
import { createSolverFixture, type SolverFixture } from "./helpers/solver-fixture";

const fixtures: SolverFixture[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("durable solver restart", () => {
  it("resumes the exact deterministic cursor without reevaluating completed assignments", async () => {
    const fixture = await createSolverFixture(); fixtures.push(fixture);
    const solveInput = {
      planId: fixture.baseConfig.id,
      request: {
        basePlanVersionId: "version-solver-1", baseConfigHash: fixture.snapshotHashes.configHash,
        baseSnapshotHashes: fixture.snapshotHashes, lockedInstanceIds: [], requirementSpecId: "requirements-solver",
        limits: { maxEvaluations: 10, maxDurationMs: 60_000, maxCandidatesPerRequirement: 10 },
      },
      baseConfig: fixture.baseConfig, requirements: fixture.requirements, candidateService: fixture.candidateService,
      evaluator: fixture.evaluator, artifacts: fixture.artifacts.writer(), solverVersion: "solver-test-v1",
    };
    let durable: SolverSearchCheckpoint | undefined;
    await expect(solveWholeBuild({
      ...solveInput,
      checkpoint(value) { durable = structuredClone(value); throw new Error("simulated worker crash"); },
    })).rejects.toThrow("simulated worker crash");
    expect(durable?.nextAssignment).toBe(1);
    if (!durable) throw new Error("checkpoint was not persisted");
    const resumed = await solveWholeBuild({ ...solveInput, resumeFrom: durable });
    expect(resumed.result.status).toBe("feasible_complete");
    expect(resumed.checkpoint.nextAssignment).toBe(2);
    expect(fixture.evaluationCalls).toHaveLength(2);
  });

  it("persists enqueue under one root, rejects forged approval, and commits only a durable human proof", async () => {
    const fixture = await createSolverFixture(); fixtures.push(fixture);
    const authorityArtifact = async (kind: string, value: unknown) => (await fixture.artifactRepository.put({
      bytes: Buffer.from(canonicalize(value)), mediaType: "application/json", privacyClass: "runtime_internal",
      kind, references: [], createdAt: "2026-08-28T00:00:00.000Z",
    })).record.ref;
    const basePlanVersionRef = await authorityArtifact("fixture-plan-version", { versionId: "version-solver-1" });
    const evaluationLockRef = await authorityArtifact("fixture-evaluation-lock", fixture.snapshotHashes);
    const requirementClosureRef = await authorityArtifact("fixture-requirement-closure", { requirements: fixture.requirements });
    const jobs = new FileJobRepository({ coordinator: fixture.coordinator, now: () => "2026-08-28T00:00:00.000Z" });
    let baseAvailable = true;
    const service = new WholeBuildSolverService({
      coordinator: fixture.coordinator, jobs, artifacts: fixture.artifacts,
      baseAuthority: {
        authorityKind: "solver-base-authority-v1",
        async resolveCurrentAtRoot() {
          if (!baseAvailable) return null;
          return {
            planId: fixture.baseConfig.id, basePlanVersionId: "version-solver-1", config: structuredClone(fixture.baseConfig),
            configHash: fixture.snapshotHashes.configHash, snapshotHashes: fixture.snapshotHashes, draftRevision: 0,
            basePlanVersionRef, evaluationLockRef,
          };
        },
      },
      requirementAuthority: {
        authorityKind: "solver-requirement-authority-v1",
        async resolveAtRoot() { return { requirements: fixture.requirements, requirementClosureRef }; },
      },
      candidateService: fixture.candidateService, evaluator: fixture.evaluator,
      solverVersion: "solver-test-v1", now: () => "2026-08-28T00:00:00.000Z",
    });
    const enqueued = await service.enqueue({
      planId: fixture.baseConfig.id, basePlanVersionId: "version-solver-1", lockedInstanceIds: [],
      requirementSpecId: "requirements-solver", limits: { maxEvaluations: 10, maxDurationMs: 60_000, maxCandidatesPerRequirement: 10 },
    });
    expect(enqueued.job.runtimeGeneration).toBe(1);
    const worker = new DurableJobWorker({ repository: jobs, workerId: "solver-worker", handlers: service.handlers(), types: ["solver.whole-build"] });
    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "waiting_user" });
    let waiting = await jobs.get(enqueued.job.jobId);
    await jobs.resume(waiting.jobId, waiting.revision, { checkpointRef: waiting.checkpointRef! });
    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "waiting_user" });
    waiting = await jobs.get(enqueued.job.jobId);
    const context = await service.approvalPlanContext(waiting.jobId, (await service.result(waiting.jobId))!.result.candidates[0]!.candidateId);
    const registry = new AgentToolRegistry(createBuildSimTools({
      wholeBuildSolverActions: {
        async getJob() { return { job: await jobs.get(waiting.jobId), result: await service.result(waiting.jobId) }; },
        async acceptCandidate(input, toolContext) {
          if (!toolContext.writeApprovalProof) throw new Error("solver approval proof missing");
          return service.approve({
            jobId: input.jobId,
            expectedRevision: input.expectedRevision,
            candidateId: input.candidateId,
            approvalProof: toolContext.writeApprovalProof,
          });
        },
      },
    }));
    expect(registry.definitionHash(SOLVER_ACCEPT_APPROVAL_TOOL_NAME)).toBe(SOLVER_ACCEPT_APPROVAL_TOOL_DEFINITION_HASH);
    const beforeArtifacts = await fixture.artifactRepository.list();
    await expect(service.approve({
      jobId: waiting.jobId, expectedRevision: waiting.revision, candidateId: context.context.candidateId,
      approvalProof: {
        schemaVersion: "agent-write-approval-proof-v1", authorityRef: `sha256:${"a".repeat(64)}`,
        approvalId: "approval-forged", approvedBy: "reviewer-forged", idempotencyKey: "forged",
        execution: {
          toolName: context.toolName, toolDefinitionHash: context.toolDefinitionHash, inputHash: context.inputHash,
          sessionId: "session-forged", runId: "run-forged", callId: "call-forged",
        },
      } as never,
    })).rejects.toThrow(/server-issued Agent write approval proof is required/);
    expect((await fixture.artifactRepository.list()).records).toEqual(beforeArtifacts.records);
    await expect(jobs.get(waiting.jobId)).resolves.toEqual(waiting);
    baseAvailable = false;
    await expect(service.approve({
      jobId: waiting.jobId, expectedRevision: waiting.revision, candidateId: context.context.candidateId,
      approvalProof: {} as never,
    })).rejects.toThrow(/base is stale/);
    expect((await fixture.artifactRepository.list()).records).toEqual(beforeArtifacts.records);
    await expect(jobs.get(waiting.jobId)).resolves.toEqual(waiting);
    baseAvailable = true;

    const runId = "solver-approval-run";
    const sessionId = "solver-approval-session";
    const callId = "solver-approval-call";
    const approvalPayloadRef = await authorityArtifact("fixture-agent-run-payload", { runId, sessionId });
    await jobs.create({
      type: "agent.run", handlerVersion: "1", idempotencyKey: `agent-run:${runId}`,
      inputHash: context.inputHash, payloadRef: approvalPayloadRef,
    });
    const firstLease = await jobs.claimNext("solver-approval-agent", { types: ["agent.run"] });
    if (!firstLease) throw new Error("approval Agent job was not claimable");
    const agentApproval = new AgentWriteApprovalAuthority(fixture.artifactRepository, {
      jobs, now: () => "2026-08-28T00:00:00.000Z", token: () => "1".repeat(64),
    });
    const requested = await agentApproval.request({
      runId, sessionId,
      call: { id: callId, name: SOLVER_ACCEPT_APPROVAL_TOOL_NAME, input: context.context },
      toolTitle: "Accept solver feasibility candidate",
      toolDefinitionHash: SOLVER_ACCEPT_APPROVAL_TOOL_DEFINITION_HASH,
    }, { jobId: firstLease.job.jobId, ...firstLease.lease });
    const checkpointed = await jobs.checkpoint(firstLease.job.jobId, firstLease.lease, requested.authorityRef);
    const paused = await jobs.pauseForUser(checkpointed.job.jobId, checkpointed.lease);
    const confirmed = await agentApproval.confirm({
      authorityRef: requested.authorityRef, runId, approvalId: requested.pending.approvalId,
      nonce: requested.pending.nonce, approvedBy: "human-solver-reviewer",
    });
    await jobs.resume(paused.jobId, paused.revision, { checkpointRef: confirmed.authorityRef });
    const resumedApprovalJob = await jobs.claimNext("solver-approval-agent", { types: ["agent.run"] });
    if (!resumedApprovalJob) throw new Error("confirmed approval Agent job was not claimable");
    const authorized = await agentApproval.authorize(confirmed.authorityRef, {
      toolName: SOLVER_ACCEPT_APPROVAL_TOOL_NAME,
      toolDefinitionHash: SOLVER_ACCEPT_APPROVAL_TOOL_DEFINITION_HASH,
      sessionId, runId, inputHash: context.inputHash, callId,
    });
    if (!authorized) throw new Error("confirmed Agent approval did not produce a proof");
    const toolContext: AgentToolContext = {
      sessionId,
      runId,
      buildConfig: fixture.baseConfig,
      signal: new AbortController().signal,
      approval: authorized.envelope,
      writeApprovalProof: authorized.proof,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const dispatched = await registry.dispatch(
      SOLVER_ACCEPT_APPROVAL_TOOL_NAME,
      context.context,
      toolContext,
      new Set([SOLVER_ACCEPT_APPROVAL_TOOL_NAME]),
    );
    expect(dispatched.result.ok, JSON.stringify(dispatched.result)).toBe(true);
    const committed = dispatched.result.content as Awaited<ReturnType<WholeBuildSolverService["approve"]>>;
    expect(committed.approval).toMatchObject({
      status: "committed", approvedBy: "human-solver-reviewer", candidateId: context.context.candidateId,
      writeApprovalBinding: { toolName: SOLVER_ACCEPT_APPROVAL_TOOL_NAME, inputHash: context.inputHash },
    });
    expect(committed.proposal).toMatchObject({ kind: "v3-change", candidateId: context.context.candidateId });
    expect(committed.resumedJob).toMatchObject({ status: "queued", checkpointRef: committed.approvalRef });
    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(jobs.get(waiting.jobId)).resolves.toMatchObject({ status: "succeeded", checkpointRef: committed.approvalRef });
  });
});

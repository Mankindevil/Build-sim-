import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agent/runtime";
import { sealAgentRunAudit } from "../src/agent/audit";
import type { ProviderAdapter, ProviderTurnResult } from "../src/agent/contracts";
import { FileArtifactRepository } from "../src/artifacts/repository.mjs";
import { FileJobRepository, quarantineRestoredJobs } from "../src/jobs/repository";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { FileAgentSessionStore } from "../src/server/file-session-store";
import { FileAgentRunAuditStore } from "../src/server/file-audit-store";
import { createAdviceJob, getAdviceJob, waitForAdviceJob } from "../scripts/deepseek/advice.mjs";
import { DurableJobAdapter } from "../scripts/deepseek/durable-job-adapter.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function fixture(prefix: string) { const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function provider(turn: (request: Parameters<ProviderAdapter["createTurn"]>[0]) => Promise<ProviderTurnResult>): ProviderAdapter {
  return {
    id: "deepseek",
    models: [{ provider: "deepseek", id: "fixture", label: "Fixture", capabilities: { streaming: false, tools: false, parallelTools: false, structuredOutput: false, thinking: false } }],
    createTurn: turn,
  };
}

const providerResult = (content = "durable answer"): ProviderTurnResult => ({
  provider: "deepseek", providerRequestId: "fixture-request", model: "fixture", content,
  toolCalls: [], stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  latencyMs: 1,
});

function adviceInput(requestId = "advice-durable-fixture") {
  return {
    requestId, locale: "zh-CN", userGoal: "保持未知项",
    buildConfig: { schemaVersion: "2.0.0", id: "fixture", name: "Fixture", updatedAt: "2026-08-27", caseId: "case.fixture", boardId: "board.fixture", cpuId: "cpu.fixture", selection: {}, bom: [] },
    evaluation: {
      findings: [{ id: "fit.bad", verdict: "bad", evidence: "official", message: "fixture conflict", related: [] }],
      occupancy: { verdict: "bad", findings: [], conflicts: [] }, wiring: {}, routing: {}, bom: [], unknown: ["thermal.evidence"],
      physical: { hash: "physical-fixture" }, calibration: { hash: "calibration-fixture" },
    },
    selectedSkuFacts: [],
    constraints: { cannotDowngradeBad: true, unknownMustStayUnknown: true, citeSourceFields: true },
  };
}

function adviceResult() {
  return {
    schemaVersion: "1.0.0", model: "deepseek-chat", generatedAt: "2026-08-27T00:00:00.000Z", summary: "基于确定性冲突给出条件建议。",
    recommendation: { verdict: "conditional", reasons: [{ text: "存在确定性冲突。", kind: "engine-finding", refs: ["fit.bad"] }] },
    risks: [{ level: "high", category: "mechanical", text: "冲突保持阻断。", refs: ["fit.bad"] }],
    actions: [{ priority: 1, action: "先复核冲突。", blocking: true, refs: ["fit.bad"] }],
    alternatives: [], unknowns: ["thermal.evidence"], sourceRefs: ["fit.bad"],
  };
}

describe("Agent and advice durable job integration", () => {
  it("uses the shared job repository as Agent run authority and deduplicates two starters", async () => {
    const root = await fixture("buildsim-agent-durable-");
    const coordinator = new RuntimeCoordinator({ root });
    const repository = new FileJobRepository({ coordinator, leaseDurationMs: 180_000 });
    const artifacts = new FileArtifactRepository({ coordinator });
    const sessions = new FileAgentSessionStore({ coordinator });
    const audits = new FileAgentRunAuditStore({ coordinator });
    let calls = 0;
    const runtime = new AgentRuntime([provider(async () => { calls += 1; return providerResult(); })], sessions, {
      auditStore: audits, durableJobs: { repository, artifacts, workerId: "agent-worker" },
      now: () => "2026-08-27T00:00:00.000Z", id: () => "fixture-id",
    });
    const session = await runtime.createSession({ model: "fixture" });
    const first = await runtime.startRun(session.id, { content: "diagnose", idempotencyKey: "same-browser-retry" });
    const second = await runtime.startRun(session.id, { content: "diagnose", idempotencyKey: "same-browser-retry" });
    expect(second.runId).toBe(first.runId);
    await runtime.waitForRun(first.runId);
    expect(calls).toBe(1);
    expect((await repository.list()).filter((job) => job.type === "agent.run")).toEqual([
      expect.objectContaining({ status: "succeeded", attempt: 1, resultRefs: expect.arrayContaining([`agent-audit:${first.runId}`]) }),
    ]);
    expect((await sessions.get(session.id))?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect((await sessions.get(session.id))?.messages.at(-1)?.content).toBe("durable answer");
    expect((await audits.get(first.runId))?.status).toBe("completed");
    const restartedRuntime = new AgentRuntime([provider(async () => providerResult())], sessions, {
      auditStore: audits, durableJobs: { repository: new FileJobRepository({ coordinator }), artifacts },
    });
    expect(await restartedRuntime.getRunState(first.runId)).toMatchObject({ status: "completed", durableStatus: "succeeded", events: [] });
  });

  it("recovers the private user input when the process dies after queuing but before the session write", async () => {
    const root = await fixture("buildsim-agent-input-crash-");
    const coordinator = new RuntimeCoordinator({ root });
    const repository = new FileJobRepository({ coordinator, leaseDurationMs: 180_000 });
    const artifacts = new FileArtifactRepository({ coordinator });
    const persistedSessions = new FileAgentSessionStore({ coordinator });
    let puts = 0;
    const crashAfterQueue = {
      get: (sessionId: string) => persistedSessions.get(sessionId),
      put: async (session: Parameters<FileAgentSessionStore["put"]>[0], fence?: Parameters<FileAgentSessionStore["put"]>[1]) => {
        puts += 1;
        if (puts === 2) throw new Error("simulated process crash before session commit");
        await persistedSessions.put(session, fence);
      },
    };
    const seenMessages: string[][] = [];
    const interrupted = new AgentRuntime([provider(async (request) => {
      seenMessages.push(request.messages.map((message) => message.content));
      return providerResult();
    })], crashAfterQueue, {
      durableJobs: { repository, artifacts, workerId: "interrupted-worker" },
      now: () => "2026-08-27T00:00:00.000Z", id: () => "input-crash",
    });
    const session = await interrupted.createSession({ model: "fixture" });
    await expect(interrupted.startRun(session.id, {
      content: "must survive the queue/session crash", idempotencyKey: "input-crash-window",
    })).rejects.toThrow(/simulated process crash/);
    expect((await persistedSessions.get(session.id))?.messages).toHaveLength(0);

    const restarted = new AgentRuntime([provider(async (request) => {
      seenMessages.push(request.messages.map((message) => message.content));
      return providerResult("recovered answer");
    })], persistedSessions, {
      durableJobs: { repository: new FileJobRepository({ coordinator }), artifacts, workerId: "restarted-worker" },
      now: () => "2026-08-27T00:00:01.000Z",
    });
    await restarted.initializeDurableRuns();

    expect(seenMessages).toEqual([["must survive the queue/session crash"]]);
    expect((await persistedSessions.get(session.id))?.messages.map((message) => message.content)).toEqual([
      "must survive the queue/session crash", "recovered answer",
    ]);
    expect((await repository.list()).find((job) => job.type === "agent.run")).toMatchObject({ status: "succeeded", attempt: 1 });
  });

  it("fails closed when a prepared Agent session journal does not match its target", async () => {
    const root = await fixture("buildsim-agent-partial-journal-");
    const store = new FileAgentSessionStore(root);
    const session = { contractVersion: "1.0.0" as const, id: "session-partial", provider: "deepseek" as const, model: "fixture", messages: [], buildConfig: null, createdAt: "now", updatedAt: "now" };
    await store.put(session);
    const manifestFile = path.join(root, "rollback", "sessions-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const entries = manifest.entries.map((entry: Record<string, unknown>, index: number) => index === manifest.entries.length - 1
      ? { ...entry, state: "prepared", nextHash: "0".repeat(64) } : entry);
    const unsigned = { schemaVersion: manifest.schemaVersion, entries };
    const checksum = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    await writeFile(manifestFile, JSON.stringify({ ...unsigned, checksum }), "utf8");
    await expect(store.get(session.id)).rejects.toThrow(/corrupt or incomplete/);
  });

  it("fails closed when an advice rollback journal is left partial", async () => {
    const root = await fixture("buildsim-advice-partial-journal-");
    const auditRoot = path.join(root, "events");
    const jobRoot = path.join(root, "jobs");
    const created = await createAdviceJob(adviceInput("advice-partial-journal"), {
      flags: { adviceEnabled: false }, config: { enabled: false, model: "deepseek-chat" }, auditRoot, jobRoot,
    });
    const manifestFile = path.join(root, "rollback", "advice-manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const index = manifest.entries.findIndex((entry: { operation?: string }) => entry.operation === "advice-job");
    manifest.entries[index] = { ...manifest.entries[index], state: "prepared", nextHash: "0".repeat(64) };
    await writeFile(manifestFile, JSON.stringify(manifest), "utf8");
    await expect(getAdviceJob(created.requestId, { auditRoot, jobRoot })).rejects.toThrow(/corrupt or incomplete/);
  });

  it("rejects every durable side effect after its job lease expires", async () => {
    const root = await fixture("buildsim-expired-side-effect-");
    const coordinator = new RuntimeCoordinator({ root });
    await coordinator.initialize("test");
    let now = "2026-08-27T00:00:00.000Z";
    const repository = new FileJobRepository({ coordinator, now: () => now, leaseDurationMs: 1_000, leaseToken: () => "expired-side-effect-lease" });
    const artifacts = new FileArtifactRepository({ coordinator, now: () => now });
    const sessions = new FileAgentSessionStore({ coordinator, now: () => now });
    const audits = new FileAgentRunAuditStore({ coordinator, now: () => now });
    const payload = await artifacts.put({
      bytes: Buffer.from("durable-input"), mediaType: "application/json", privacyClass: "private_user", kind: "job-payload", references: [],
    });
    await repository.create({
      type: "agent.run", handlerVersion: "1", idempotencyKey: "expired-side-effect",
      inputHash: "a".repeat(64), payloadRef: payload.record.ref,
    });
    const claimed = await repository.claimNext("expired-worker");
    expect(claimed).not.toBeNull();
    const fence = {
      runtimeGeneration: claimed!.job.runtimeGeneration,
      jobId: claimed!.job.jobId,
      expectedRevision: claimed!.lease.expectedRevision,
      leaseToken: claimed!.lease.leaseToken,
    };
    now = "2026-08-27T00:00:02.000Z";

    await expect(artifacts.put({
      bytes: Buffer.from("late-result"), mediaType: "application/json", privacyClass: "private_user", kind: "agent-result", references: [],
    }, { expectedRuntimeGeneration: fence.runtimeGeneration, expectedJobLease: fence })).rejects.toThrow(/stale job lease/);
    await expect(sessions.put({
      contractVersion: "1.0.0", id: "session-expired", provider: "deepseek", model: "fixture", messages: [], buildConfig: null,
      createdAt: now, updatedAt: now,
    }, fence)).rejects.toThrow(/stale job lease/);
    const audit = sealAgentRunAudit({
      contractVersion: "1.0.0", runId: "run-expired", sessionId: "session-expired", provider: "deepseek", model: "fixture",
      status: "running", startedAt: now, finishedAt: null, buildConfigHash: null, skill: null, providerTurns: [], toolCalls: [], error: null,
    });
    await expect(audits.put(audit, fence)).rejects.toThrow(/stale job lease/);

    expect((await artifacts.list()).records.map((record: { kind: string }) => record.kind)).toEqual(["job-payload"]);
    expect(await sessions.get("session-expired")).toBeNull();
    expect(await audits.get("run-expired")).toBeNull();
  });

  it("fences an old Agent worker after a restored generation becomes active", async () => {
    const root = await fixture("buildsim-agent-restore-fence-");
    const coordinator = new RuntimeCoordinator({ root });
    const now = "2026-08-27T00:00:00.000Z";
    const repository = new FileJobRepository({ coordinator, now: () => now, leaseDurationMs: 180_000, leaseToken: () => "old-agent-lease" });
    const artifacts = new FileArtifactRepository({ coordinator, now: () => now });
    const gate = deferred<ProviderTurnResult>();
    const started = deferred<void>();
    const runtime = new AgentRuntime([provider(async () => { started.resolve(); return gate.promise; })], new FileAgentSessionStore({ coordinator, now: () => now }), {
      auditStore: new FileAgentRunAuditStore({ coordinator, now: () => now }), durableJobs: { repository, artifacts, workerId: "old-worker" },
      now: () => now, id: () => "restore-fixture",
    });
    const session = await runtime.createSession({ model: "fixture" });
    const run = await runtime.startRun(session.id, { content: "long request" });
    await started.promise;

    const lease = await coordinator.acquireMaintenanceLease("restore", { ttlMs: 60_000 });
    const state = await coordinator.readState();
    const staging = await coordinator.createStagingGeneration(lease.token);
    for (const child of ["agent", "jobs", "artifacts"]) await cp(path.join(coordinator.activeRoot(state), child), path.join(staging, child), { recursive: true });
    await quarantineRestoredJobs(staging, state.runtimeGeneration + 1, now);
    await coordinator.activateStagingGeneration(staging, state.runtimeGeneration, lease.token);
    gate.resolve(providerResult("must-not-commit"));
    await runtime.waitForRun(run.runId);

    const restoredRepository = new FileJobRepository({ coordinator, now: () => now });
    const restoredJob = (await restoredRepository.list()).find((job) => job.type === "agent.run");
    expect(restoredJob?.status).toBe("paused_restore_review");
    const restoredSession = await new FileAgentSessionStore({ coordinator }).get(session.id);
    expect(restoredSession?.messages.some((message) => message.content === "must-not-commit")).toBe(false);
    expect((await new FileAgentRunAuditStore({ coordinator }).get(run.runId))?.status).toBe("running");
  });

  it("lets a restarted worker resume an expired run while the stale lease commits nothing", async () => {
    const root = await fixture("buildsim-agent-restart-lease-");
    const coordinator = new RuntimeCoordinator({ root });
    let now = "2026-08-27T00:00:00.000Z";
    const oldGate = deferred<ProviderTurnResult>();
    const oldStarted = deferred<void>();
    const oldRepository = new FileJobRepository({ coordinator, now: () => now, leaseDurationMs: 1_000, leaseToken: () => "old-lease" });
    const artifacts = new FileArtifactRepository({ coordinator, now: () => now });
    const sessions = new FileAgentSessionStore({ coordinator, now: () => now });
    const audits = new FileAgentRunAuditStore({ coordinator, now: () => now });
    const oldRuntime = new AgentRuntime([provider(async () => { oldStarted.resolve(); return oldGate.promise; })], sessions, {
      auditStore: audits, durableJobs: { repository: oldRepository, artifacts, workerId: "old-worker" }, now: () => now,
    });
    const session = await oldRuntime.createSession({ model: "fixture" });
    const run = await oldRuntime.startRun(session.id, { content: "resume me", idempotencyKey: "restart-once" });
    await oldStarted.promise;

    now = "2026-08-27T00:00:02.000Z";
    const freshRepository = new FileJobRepository({ coordinator, now: () => now, leaseDurationMs: 30_000, leaseToken: () => "fresh-lease" });
    const freshRuntime = new AgentRuntime([provider(async () => providerResult("fresh-worker-answer"))], sessions, {
      auditStore: audits, durableJobs: { repository: freshRepository, artifacts, workerId: "fresh-worker" }, now: () => now,
    });
    await freshRuntime.initializeDurableRuns();
    oldGate.resolve(providerResult("stale-worker-answer"));
    await oldRuntime.waitForRun(run.runId);

    const persisted = await sessions.get(session.id);
    expect(persisted?.messages.some((message) => message.content === "fresh-worker-answer")).toBe(true);
    expect(persisted?.messages.some((message) => message.content === "stale-worker-answer")).toBe(false);
    expect((await freshRepository.list()).find((job) => job.type === "agent.run")).toMatchObject({ status: "succeeded", attempt: 2 });
    expect((await audits.get(run.runId))?.status).toBe("completed");
  });

  it("persists advice payload/results as artifacts and performs one provider effect for duplicate requests", async () => {
    const root = await fixture("buildsim-advice-durable-");
    const coordinator = new RuntimeCoordinator({ root });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "advice-provider-request", model: "deepseek-chat", choices: [{ message: { content: JSON.stringify(adviceResult()) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const options = {
      coordinator, flags: { adviceEnabled: true },
      config: { enabled: true, apiKey: "fixture-secret", apiUrl: "https://api.deepseek.com", model: "deepseek-chat", timeoutMs: 1_000, maxTokens: 100, temperature: 0.2 },
      fetchImpl, now: () => new Date("2026-08-27T00:00:00.000Z"),
    };
    const first = await createAdviceJob(adviceInput(), options);
    const duplicate = await createAdviceJob(adviceInput(), options);
    expect(duplicate.requestId).toBe(first.requestId);
    const completed = await waitForAdviceJob(first.requestId, { ...options, timeoutMs: 2_000 });
    expect(completed?.status).toBe("completed");
    expect(calls).toBe(1);
    const jobs = (await new FileJobRepository({ coordinator }).list()).filter((job) => job.type === "agent.advice");
    expect(jobs).toEqual([expect.objectContaining({ status: "succeeded", attempt: 1, resultRefs: [expect.stringMatching(/^sha256:/)] })]);
    const adapter = new DurableJobAdapter({ coordinator });
    await expect(adapter.succeed(jobs[0]!.jobId, {
      expectedRevision: 0, leaseToken: "forged-terminal-retry", runtimeGeneration: 999,
    }, jobs[0]!.resultRefs, jobs[0]!.resultCommitHash)).rejects.toThrow(/fenced/);
    expect(jobs[0]?.payloadRef).toMatch(/^sha256:/);
    expect(await getAdviceJob(first.requestId, { coordinator })).toMatchObject({ status: "completed", advice: { recommendation: { verdict: "conditional" } } });
    expect(createHash("sha256").update(JSON.stringify(completed)).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects Advice records that violate the shared durable job contract", async () => {
    const root = await fixture("buildsim-advice-job-contract-");
    const adapter = new DurableJobAdapter({ coordinator: new RuntimeCoordinator({ root }) });
    await adapter.initialize();
    await expect(adapter.create({
      type: "agent.advice", handlerVersion: "1", idempotencyKey: "invalid-advice-job",
      inputHash: "a".repeat(64), payloadRef: `sha256:${"b".repeat(64)}`,
      maxAttempts: 0, networkRequired: "yes",
    })).rejects.toThrow(/invalid durable job input/);
    expect(await adapter.list("agent.advice")).toEqual([]);
  });

  it("keeps restored advice paused and fences the pre-restore provider result", async () => {
    const root = await fixture("buildsim-advice-restore-fence-");
    const coordinator = new RuntimeCoordinator({ root });
    let now = "2026-08-27T00:00:00.000Z";
    const responseGate = deferred<Response>();
    const fetchStarted = deferred<void>();
    const workerSettled = deferred<string>();
    const options = {
      coordinator, flags: { adviceEnabled: true },
      config: { enabled: true, apiKey: "fixture-secret", apiUrl: "https://api.deepseek.com", model: "deepseek-chat", timeoutMs: 10_000, maxTokens: 100, temperature: 0.2 },
      fetchImpl: async () => { fetchStarted.resolve(); return responseGate.promise; },
      now: () => new Date(now),
      onDurableWorkerSettled: (jobId: string) => workerSettled.resolve(jobId),
    };
    const created = await createAdviceJob({ ...adviceInput("advice-restore-fence"), userGoal: "restore fence distinct input" }, options);
    await fetchStarted.promise;
    const lease = await coordinator.acquireMaintenanceLease("restore", { ttlMs: 60_000 });
    const state = await coordinator.readState();
    const staging = await coordinator.createStagingGeneration(lease.token);
    for (const child of ["jobs", "artifacts", "audit"]) await cp(path.join(coordinator.activeRoot(state), child), path.join(staging, child), { recursive: true });
    await quarantineRestoredJobs(staging, state.runtimeGeneration + 1, now);
    await coordinator.activateStagingGeneration(staging, state.runtimeGeneration, lease.token);
    responseGate.resolve(new Response(JSON.stringify({ id: "stale-provider", model: "deepseek-chat", choices: [{ message: { content: JSON.stringify(adviceResult()) } }] }), { status: 200 }));
    await workerSettled.promise;

    const restored = await getAdviceJob(created.requestId, { coordinator, now: () => new Date(now) });
    expect(restored).toMatchObject({ status: "paused_restore_review", runtimeGeneration: 2 });
    const job = (await new FileJobRepository({ coordinator, now: () => now }).list()).find((item) => item.type === "agent.advice");
    expect(job).toMatchObject({ status: "paused_restore_review", resultRefs: [] });
    const artifactList = await new FileArtifactRepository({ coordinator, now: () => now }).list();
    expect(artifactList.records.filter((record: { kind: string }) => record.kind === "advice-result")).toHaveLength(0);
  });
});

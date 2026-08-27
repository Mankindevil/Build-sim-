import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { FileAgentSessionStore } from "../src/server/file-session-store";
import { FileAgentRunAuditStore } from "../src/server/file-audit-store";
import { parseAgentRuntimeConfig } from "../src/server/agent-env";
import { sealAgentRunAudit } from "../src/agent/audit";
import { archiveTransaction, listTransactionArchives } from "../scripts/price-server/transactions/archive.mjs";
import { createBackup } from "../src/backup/runtime.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "build-sim-runtime-agent-tx-")); roots.push(root); return root; }

describe("runtime generation persistence for agent and transactions", () => {
  it("treats deployed legacy child-root aliases as coordinator paths", () => {
    const config = parseAgentRuntimeConfig({ RUNTIME_ROOT: "/app/runtime", AGENT_SESSION_ROOT: "/app/runtime/agent/sessions", AGENT_AUDIT_ROOT: "/app/runtime/agent/audit" });
    expect(config.sessionRootConfigured).toBe(false);
    expect(config.auditRootConfigured).toBe(false);
  });

  it("resolves stores from the active generation and fences writes with a maintenance lease", async () => {
    const root = await fixture();
    const coordinator = new RuntimeCoordinator({ root });
    await coordinator.initialize("test");
    const session = { contractVersion: "1.0.0" as const, id: "session-fixture", provider: "deepseek" as const, model: "fixture", messages: [], buildConfig: null, createdAt: "now", updatedAt: "now" };
    const sessions = new FileAgentSessionStore({ coordinator });
    await sessions.put(session);
    expect(await sessions.get(session.id)).toEqual(session);
    const backup = await createBackup({ coordinator, outputFile: path.join(root, "agent.backup"), password: "correct horse battery staple", backupId: "agent-runtime-test" });
    expect(backup.manifest.entries.some((entry: { logicalPath: string }) => entry.logicalPath === "agent/sessions/session-fixture.json")).toBe(true);
    const lease = await coordinator.acquireMaintenanceLease("backup");
    await expect(sessions.put(session)).rejects.toThrow(/fenced/);
    const staging = await coordinator.createStagingGeneration(lease.token);
    await cp(path.join(root, "generations", "1", "agent"), path.join(staging, "agent"), { recursive: true });
    await coordinator.activateStagingGeneration(staging, 1, lease.token);
    expect(await new FileAgentSessionStore({ coordinator }).get(session.id)).toEqual(session);
  });

  it("fails closed on corrupt transaction metadata and keeps records plan-scoped", async () => {
    const root = await fixture();
    const coordinator = new RuntimeCoordinator({ root });
    await coordinator.initialize("test");
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const contentHash = createHash("sha256").update(image).digest("hex");
    const receiptId = "receipt-runtime-fixture";
    const archived = await archiveTransaction({ receiptId, screenshotDataUrl: `data:image/png;base64,${image.toString("base64")}`, link: { planId: "plan-runtime", planItemId: "psu.primary", linkStatus: "linked" }, item: { id: "transaction-runtime", name: "Fixture PSU", category: "psu", qty: 1, stage: "purchased", source: "transaction", transaction: { receiptId, fileName: "order.png", contentHash, capturedAt: "2026-08-27T00:00:00.000Z", ocrEngine: "fixture", excerpt: "收货人：张三，手机 13812345678", verification: "review" } } }, { coordinator });
    expect(archived.result?.item?.transaction?.excerpt ?? archived.item?.transaction?.excerpt).not.toContain("13812345678");
    expect((await listTransactionArchives({ coordinator })).at(0)?.link.planId).toBe("plan-runtime");
    const state = await coordinator.readState();
    await writeFile(path.join(root, state.activeRoot, "transactions", "plans", "plan-runtime", `${receiptId}.json`), "{broken", "utf8");
    await expect(listTransactionArchives({ coordinator })).rejects.toThrow();
    expect(JSON.stringify(await readFile(path.join(root, state.activeRoot, "transactions", "rollback", "transactions-manifest.json"), "utf8"))).toContain("transaction-archive");
  });

  it("rejects tampered Agent audit records", async () => {
    const root = await fixture(); const coordinator = new RuntimeCoordinator({ root }); await coordinator.initialize("test");
    const audit = sealAgentRunAudit({ contractVersion: "1.0.0", runId: "run-fixture", sessionId: "session-fixture", provider: "deepseek", model: "fixture", status: "completed", startedAt: "now", finishedAt: "now", buildConfigHash: null, skill: null, providerTurns: [], toolCalls: [], error: null });
    const store = new FileAgentRunAuditStore({ coordinator }); await store.put(audit);
    const state = await coordinator.readState(); const file = path.join(root, state.activeRoot, "agent", "audit", "run-fixture.json");
    await writeFile(file, JSON.stringify({ ...audit, status: "failed" }), "utf8");
    await expect(store.get(audit.runId)).rejects.toThrow(/integrity/);
  });
});

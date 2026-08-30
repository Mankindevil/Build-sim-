// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountJobStatusPanel } from "../src/lab/job-status";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import type { WorkspaceJobStatus } from "../src/server/job-center-production";

afterEach(() => document.body.replaceChildren());

function job(jobId: string, status: WorkspaceJobStatus["status"], revision: number): WorkspaceJobStatus {
  return {
    schemaVersion: "workspace-job-status-v1", jobId, planId: "plan-jobs", type: "evidence.fetch", status, revision,
    attempt: status === "running" ? 1 : 0, maxAttempts: 3, runAfter: "2026-08-30T00:00:00.000Z",
    networkRequired: true, dependencyJobIds: ["job-dependency"], progress: { stage: "official_discovery", completed: 1, total: 3 },
    lastError: status === "dead_letter" ? { code: "parser_unavailable", message: "已脱敏的任务说明", redacted: true } : null,
    createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:01:00.000Z",
  };
}

describe("U11 job center UI", () => {
  it("renders durable states and sends exact revision controls without exposing execution internals", async () => {
    let rows = [job("job-waiting", "waiting_user", 4), job("job-restored", "paused_restore_review", 7), job("job-dead", "dead_letter", 9)];
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/job-waiting/resume")) rows = rows.map((entry) => entry.jobId === "job-waiting" ? { ...entry, status: "queued", revision: 5 } : entry);
      return new Response(JSON.stringify(init?.method === "POST" ? rows.find((entry) => url.includes(entry.jobId)) : { jobs: rows }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountJobStatusPanel(host, { enabled: true, getPlanId: () => "plan-jobs", subscribe: () => () => undefined, fetchImpl, pollIntervalMs: 0 });
    await vi.waitFor(() => expect(host.querySelectorAll("[data-job-id]")).toHaveLength(3));

    expect(host.textContent).toContain("等待用户确认");
    expect(host.textContent).toContain("恢复后待审阅");
    expect(host.textContent).toContain("需要人工处理");
    expect(host.textContent).toContain("parser_unavailable：已脱敏的任务说明");
    expect(host.textContent).not.toContain("leaseToken");
    host.querySelector<HTMLButtonElement>("[data-resume-job='job-waiting']")!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-job-id='job-waiting']")?.getAttribute("data-job-status")).toBe("queued"));
    expect(requests.find(({ url }) => url.endsWith("/job-waiting/resume"))?.body).toEqual({ expectedRevision: 4 });
    controller.dispose();
  });

  it("derives plan ownership from the route and disappears when disabled", async () => {
    const center = {
      list: vi.fn(async () => [job("job-route", "queued", 0)]),
      cancel: vi.fn(async () => job("job-route", "cancelled", 1)),
      resume: vi.fn(async () => job("job-route", "queued", 1)),
    };
    await expect(handleWorkspaceRoute("GET", "/api/workspace/plans/plan%20jobs/jobs", {}, {} as never, { jobCenter: center, jobCenterEnabled: true }))
      .resolves.toMatchObject({ status: 200, payload: { jobs: [{ jobId: "job-route" }] } });
    expect(center.list).toHaveBeenCalledWith("plan jobs");
    await expect(handleWorkspaceRoute("POST", "/api/workspace/plans/plan%20jobs/jobs/job-route/resume", { expectedRevision: 5 }, {} as never, { jobCenter: center, jobCenterEnabled: true }))
      .resolves.toMatchObject({ status: 200, payload: { revision: 1 } });
    expect(center.resume).toHaveBeenCalledWith("plan jobs", "job-route", 5);
    await expect(handleWorkspaceRoute("GET", "/api/workspace/plans/plan-jobs/jobs", {}, {} as never, { jobCenterEnabled: false }))
      .resolves.toEqual({ status: 404, payload: { error: "job_center_disabled" } });
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountBackupPanel } from "../src/lab/backup-panel";
import { mountPortabilityPanel } from "../src/lab/portability-panel";
import { handleWorkspaceRoute } from "../src/server/workspace-routes";
import type { WorkspaceBackupSummary } from "../src/server/operations-production";
import type { DoctorReport } from "../src/doctor/contracts";

afterEach(() => document.body.replaceChildren());

const first: WorkspaceBackupSummary = {
  schemaVersion: "workspace-backup-summary-v1", backupId: "backup-old", manifestHash: "a".repeat(64),
  createdAt: "2026-08-29T00:00:00.000Z", verifiedAt: "2026-08-29T00:01:00.000Z", runtimeGeneration: 3, entryCount: 42, result: "pass",
};
const second: WorkspaceBackupSummary = { ...first, backupId: "backup-new", manifestHash: "b".repeat(64), verifiedAt: "2026-08-30T00:01:00.000Z", runtimeGeneration: 4 };

describe("U11 backup and portability entry UI", () => {
  it("keeps complete runtime backup distinct from single-plan export and clears the password after verified creation", async () => {
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { requests.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(second), { status: 201, headers: { "Content-Type": "application/json" } }); }
      return new Response(JSON.stringify({ backups: [first] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountBackupPanel(host, { enabled: true, fetchImpl });
    await vi.waitFor(() => expect(host.textContent).toContain("最近校验：2026-08-29T00:01:00.000Z"));
    expect(host.textContent).toContain("单方案下载会使用独立的 .buildsim 入口");
    const password = host.querySelector<HTMLInputElement>("input[name='password']")!; password.value = "local-passphrase-123";
    host.querySelector<HTMLInputElement>("input[name='confirmation']")!.checked = true;
    host.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.textContent).toContain("已创建并校验 backup-new"));
    expect(requests).toEqual([{ password: "local-passphrase-123", confirmation: true }]);
    expect(host.querySelector<HTMLInputElement>("input[name='password']")!.value).toBe("");
    expect(host.textContent).not.toContain("local-passphrase-123");
    controller.dispose();
  });

  it("exports a real plan package, previews a raw upload, and applies only after explicit review", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const manifestHash = "c".repeat(64);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/exports")) return new Response(JSON.stringify({
        schemaVersion: "portable-export-summary-v1", exportId: "12345678-1234-1234-1234-123456789012", planId: "plan-current",
        manifestHash, portableProfile: "complete", resultMode: "exact_replay", redacted: true, entryCount: 18,
        createdAt: "2026-08-30T00:00:00.000Z", downloadUrl: "/api/workspace/portability/exports/12345678-1234-1234-1234-123456789012/download",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/dry-run")) return new Response(JSON.stringify({
        schemaVersion: "portable-import-preview-v1", uploadId: "d".repeat(40), sourcePlanId: "plan-source", sourcePlanName: "Imported build",
        sourcePlanHash: "e".repeat(64), manifestHash, portableProfile: "complete", exactReplayReady: false,
        importPlan: { importPlanId: "preview", mode: "dry_run", manifestHash, portableProfile: "complete", resultMode: "reevaluate_with_current_runtime", conflicts: [{ existingId: "plan-source", incomingHash: "e".repeat(64), existingHash: "f".repeat(64) }], idRemap: { "plan-source": "plan-copy" }, action: "copy_as_new_plan" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ schemaVersion: "portable-import-result-v1", action: "copy_as_new_plan", sourcePlanId: "plan-source", importedPlanId: "plan-copy", manifestHash, resultMode: "reevaluate_with_current_runtime", runtimeGeneration: 7 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const imported: string[] = [];
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountPortabilityPanel(host, { enabled: true, getPlanId: () => "plan-current", fetchImpl, onImported: (planId) => { imported.push(planId); } });

    const exportForm = host.querySelector<HTMLFormElement>("[data-portable-export]")!;
    exportForm.querySelector<HTMLInputElement>("input[name='exportPassword']")!.value = "portable-ui-password";
    exportForm.querySelector<HTMLInputElement>("input[name='exportConfirmation']")!.checked = true;
    exportForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector<HTMLAnchorElement>("a[download]")?.href).toContain("/api/workspace/portability/exports/"));
    expect(host.textContent).toContain("闭包校验通过");
    expect(host.textContent).not.toContain("portable-ui-password");

    const importForm = host.querySelector<HTMLFormElement>("[data-portable-import]")!;
    const fileInput = importForm.querySelector<HTMLInputElement>("input[type='file']")!;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["encrypted"], "source.buildsim", { type: "application/vnd.buildsim.plan+json" })] });
    const passwords = importForm.querySelectorAll<HTMLInputElement>("input[type='password']"); passwords[0]!.value = "portable-ui-password";
    const strategy = importForm.querySelector<HTMLSelectElement>("select")!; strategy.value = "copy_as_new_plan";
    const newId = importForm.querySelector<HTMLInputElement>("input[placeholder*='plan-imported']")!; newId.value = "plan-copy";
    importForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.textContent).toContain("导入后重新评估"));
    const dryRunCall = calls.find(({ url }) => url.endsWith("/dry-run"))!;
    expect(dryRunCall.init?.body).toBeInstanceOf(File);
    expect(new Headers(dryRunCall.init?.headers).get("x-buildsim-conflict-strategy")).toBe("copy_as_new_plan");

    importForm.querySelector<HTMLButtonElement>("button[type='button']")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("已导入 plan-copy"));
    expect(imported).toEqual(["plan-copy"]);
    const applyBody = JSON.parse(String(calls.find(({ url }) => url.endsWith("/apply"))!.init?.body));
    expect(applyBody).toMatchObject({ uploadId: "d".repeat(40), expectedManifestHash: manifestHash, strategy: "copy_as_new_plan", newPlanId: "plan-copy", confirmation: true });
    controller.dispose();
  });

  it("exposes only gated local operations routes and rejects incomplete confirmation", async () => {
    const operations = {
      doctor: vi.fn(async () => ({} as unknown as DoctorReport)),
      listBackups: vi.fn(async () => [first]),
      createFullBackup: vi.fn(async () => second),
      createDiagnostic: vi.fn(async () => ({ diagnosticId: "diagnostic-fixture" } as never)),
      prepareRepair: vi.fn(async () => ({ repairPlanId: "repair-fixture" } as never)),
      applyRepair: vi.fn(async () => ({ applied: true } as never)),
    };
    await expect(handleWorkspaceRoute("GET", "/api/workspace/backups", {}, {} as never, { operations, backupRestoreEnabled: true }))
      .resolves.toEqual({ status: 200, payload: { backups: [first] } });
    await expect(handleWorkspaceRoute("POST", "/api/workspace/backups", { password: "short", confirmation: true }, {} as never, { operations, backupRestoreEnabled: true }))
      .resolves.toMatchObject({ status: 400 });
    expect(operations.createFullBackup).not.toHaveBeenCalled();
    await expect(handleWorkspaceRoute("GET", "/api/workspace/doctor", {}, {} as never, { operations, doctorEnabled: false }))
      .resolves.toEqual({ status: 404, payload: { error: "doctor_disabled" } });
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOCTOR_CHECK_REGISTRY, type DoctorReport } from "../src/doctor/contracts";
import { mountDoctorPanel } from "../src/lab/doctor-panel";

afterEach(() => document.body.replaceChildren());

const hash = "d".repeat(64);
const artifactRef = {
  ref: `sha256:${hash}`, hashSpecVersion: "hash-spec-v1", algorithm: "sha256", contentHash: hash,
  domain: "artifact", schemaVersion: "artifact-payload-v1", canonicalizationPolicyId: "artifact-payload-v1",
} as const;

function report(): DoctorReport {
  return {
    schemaVersion: "doctor-v1", doctorVersion: "doctor-v1", checkRegistryVersion: "doctor-check-registry-v1",
    runtimeGeneration: 4, generatedAt: "2026-08-30T00:00:00.000Z", appVersion: "test", overall: "degraded", reportHash: "a".repeat(64),
    checks: DEFAULT_DOCTOR_CHECK_REGISTRY.map((entry, index) => ({
      ...entry,
      status: index === 0 ? "warn" as const : "pass" as const,
      severity: index === 0 ? "degraded" as const : "info" as const,
      summary: index === 0 ? "最近一次检查需要人工复核。" : "检查通过。",
      evidence: [{ code: index === 0 ? "review_needed" : "ok", redactedDisplay: "仅显示脱敏摘要" }],
      evidenceArtifactRefs: [artifactRef],
      ...(index === 0 ? { remediation: "先查看影响预览。" } : {}),
      repairable: index === 0,
    })),
  };
}

describe("U11 Doctor UI", () => {
  it("renders the complete read-only report and never exposes a direct repair action", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/diagnostics")
      ? { downloadUrl: "/api/workspace/diagnostics/fixture/download", bundleHash: "b".repeat(64) }
      : report()), { status: String(input).endsWith("/diagnostics") ? 201 : 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountDoctorPanel(host, { enabled: true, fetchImpl });
    await vi.waitFor(() => expect(host.querySelectorAll("[data-doctor-check]")).toHaveLength(DEFAULT_DOCTOR_CHECK_REGISTRY.length));
    expect(host.querySelector("[data-doctor-overall='degraded']")).not.toBeNull();
    expect(host.textContent).toContain("页面只投影服务端报告；不会自动修改文件");
    expect(host.textContent).toContain("执行前仍需影响预览、完整备份和再次确认");
    expect(host.querySelector("[data-repair]")).toBeNull();
    (host.querySelector("[data-export-diagnostic]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector<HTMLAnchorElement>("a[download]")?.href).toContain("/api/workspace/diagnostics/fixture/download"));
    expect(host.textContent).toContain("诊断包已验证");
    controller.dispose();
  });

  it("requires backup confirmation, renders an impact preview, and asks again before applying", async () => {
    const unhealthy = report();
    unhealthy.overall = "unhealthy";
    unhealthy.checks[0] = {
      ...unhealthy.checks[0]!, status: "fail", severity: "blocking", repairable: true,
      summary: "运行目录权限过宽。", remediation: "先备份，再收紧权限。",
    };
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.endsWith("/repairs/preview")) return new Response(JSON.stringify({
        repairPlanId: "11111111-1111-4111-8111-111111111111",
        planHash: "c".repeat(64), impactSummary: "仅收紧本地运行目录权限。",
        backupId: "backup-ui-fixture", requiresSecondConfirmation: true,
      }), { status: 201, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/repairs/apply")) return new Response(JSON.stringify({
        applied: true, idempotentReplay: false, rolledBack: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(unhealthy), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountDoctorPanel(host, { enabled: true, fetchImpl });
    await vi.waitFor(() => expect(host.querySelector("[data-prepare-doctor-repair]")).not.toBeNull());
    const form = host.querySelector<HTMLFormElement>("[data-prepare-doctor-repair]")!;
    form.querySelector<HTMLInputElement>("input[type='password']")!.value = "doctor ui repair password";
    form.querySelector<HTMLInputElement>("input[type='checkbox']")!.checked = true;
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector("[data-doctor-repair-preview]")).not.toBeNull());
    expect(host.textContent).toContain("已验证备份 backup-ui-fixture");
    expect(calls.find(({ url }) => url.endsWith("/repairs/preview"))?.body).toEqual({
      actionIds: ["restrict-runtime-permissions"], password: "doctor ui repair password", confirmation: true,
    });
    host.querySelector<HTMLButtonElement>("[data-apply-doctor-repair]")!.click();
    await vi.waitFor(() => expect(host.textContent).toContain("修复已完成并重新运行诊断"));
    expect(calls.find(({ url }) => url.endsWith("/repairs/apply"))?.body).toEqual({
      repairPlanId: "11111111-1111-4111-8111-111111111111",
      planHash: "c".repeat(64), password: "doctor ui repair password", confirmation: true,
    });
    controller.dispose();
  });
});

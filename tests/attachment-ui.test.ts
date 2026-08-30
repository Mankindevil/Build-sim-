// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAttachmentsPanel } from "../src/lab/attachments-panel";

afterEach(() => document.body.replaceChildren());

describe("U11 attachment and observation UI", () => {
  it("uploads only bounded local media and hands a server-owned upload ID to the ordinary Agent review flow", async () => {
    const prompt = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      uploadId: "upload-attachment-ui", mediaType: "image/jpeg", size: 4,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    const controller = mountAttachmentsPanel(host, {
      ensureSessionId: async () => "session-attachment-ui",
      getPlanId: () => "plan-attachment-ui",
      openAgentPrompt: prompt,
      fetchImpl,
    });
    const fileInput = host.querySelector<HTMLInputElement>("input[type='file']")!;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [new File([new Uint8Array([1, 2, 3, 4])], "bios-label.jpg", { type: "image/jpeg" })] });
    host.querySelector<HTMLSelectElement>("select[name='scope']")!.value = "firmware";
    host.querySelector<HTMLInputElement>("input[name='subject']")!.value = "motherboard-main";
    host.querySelector<HTMLInputElement>("input[name='measurement']")!.value = "标签版本 1600，方向由左向右";
    host.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/agent/sessions/session-attachment-ui/uploads", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ "Content-Type": "image/jpeg" }),
    }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Uint8Array(request.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(prompt.mock.calls[0]?.[0]).toContain("upload-attachment-ui");
    expect(prompt.mock.calls[0]?.[0]).toContain("当前方案 plan-attachment-ui");
    expect(prompt.mock.calls[0]?.[0]).toContain("firmware，对象 motherboard-main");
    expect(prompt.mock.calls[0]?.[0]).toContain("待确认观察提案");
    expect(host.textContent).toContain("私有附件");
    expect(host.textContent).toContain("逐项审阅并批准");
    expect(host.textContent).not.toContain("sha256");
    controller.dispose();
  });

  it("rejects unsupported files before creating an Agent session or request", async () => {
    const ensureSessionId = vi.fn(async () => "session-never");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const host = document.createElement("section"); document.body.append(host);
    mountAttachmentsPanel(host, { ensureSessionId, getPlanId: () => "plan-attachment-ui", openAgentPrompt: vi.fn(), fetchImpl });
    const fileInput = host.querySelector<HTMLInputElement>("input[type='file']")!;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["x"], "notes.txt", { type: "text/plain" })] });
    host.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.textContent).toContain("请选择 PNG、JPEG 或 PDF 文件"));
    expect(ensureSessionId).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

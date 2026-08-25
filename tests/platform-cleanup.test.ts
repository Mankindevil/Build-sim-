// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentPanel } from "../src/lab/agent-panel";
import { initTransactionImport } from "../src/lab/transaction-import";

function agentDom() {
  document.body.innerHTML = `<p id="agent-status"></p><select id="agent-model"></select><select id="agent-skill"></select><button id="agent-new-session"></button><div id="agent-transcript"></div><ul id="agent-events"></ul><p id="agent-usage"></p><form id="agent-form"><textarea id="agent-input"></textarea><button id="agent-cancel" type="button"></button><button id="agent-send"></button></form>`;
}

describe("R10 browser resource cleanup", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("unsubscribes plan context and closes an active Agent event stream on dispose", async () => {
    agentDom();
    const close = vi.fn();
    const unsubscribe = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ models: [{ provider: "fixture", id: "model", label: "Model", capabilities: { streaming: true, tools: true, parallelTools: false, structuredOutput: true, thinking: false } }] }));
      if (url.endsWith("/skills")) return new Response(JSON.stringify({ skills: [] }));
      if (url.endsWith("/sessions") && init?.method === "POST") return new Response(JSON.stringify({ id: "session", provider: "fixture", model: "model", messages: [], createdAt: "now", updatedAt: "now" }), { status: 201 });
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ runId: "run-cleanup" }), { status: 202 });
      return new Response(JSON.stringify({}));
    });
    const controller = await initAgentPanel({ getBuildConfig: () => ({}), subscribePlanContext: () => unsubscribe, fetchImpl: fetchImpl as typeof fetch, eventSourceFactory: () => ({ addEventListener: vi.fn(), close }) });
    (document.querySelector("#agent-input") as HTMLTextAreaElement).value = "start";
    document.querySelector("#agent-form")!.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/messages"), expect.anything()));
    controller?.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-agent-plan-proposals]")).toBeNull();
  });

  it("aborts OCR and revokes the transaction preview object URL on dispose", async () => {
    document.body.innerHTML = `<label id="transaction-screenshot-drop"><input id="transaction-screenshot-input" type="file"><img id="transaction-screenshot-preview"><span></span></label><p id="transaction-screenshot-status"></p><div id="transaction-screenshot-result"></div>`;
    const revoke = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cleanup");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))));
    const controller = initTransactionImport({ onImport: vi.fn() });
    const input = document.querySelector<HTMLInputElement>("#transaction-screenshot-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File([new Uint8Array([1])], "receipt.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    controller?.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:cleanup");
    expect(document.querySelector("[data-transaction-cancel]")).toBeNull();
  });
});

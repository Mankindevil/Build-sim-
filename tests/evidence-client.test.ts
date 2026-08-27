import { describe, expect, it, vi } from "vitest";
import { WorkspaceApiClient } from "../src/plans/client";
import { EvidenceApiClient, EvidenceApiError } from "../src/plans/evidence-client";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("evidence browser clients", () => {
  it("uses the evidence discovery/acquisition/document routes with JSON write gates", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/discover")) return json({ startUrl: "https://vendor.test/p", finalUrl: "https://vendor.test/p", officialBrand: "Vendor", candidates: [], pagesInspected: 1, warnings: [] });
      if (url.endsWith("/acquisitions")) return json({ document: { id: "doc-sha256-a" }, capture: { id: "capture-sha256-b" }, reusedDocument: false, reusedCapture: false, cacheStatus: "miss" });
      if (url.includes("/documents/")) return json({ document: { id: "doc-sha256-a" }, captures: [] });
      return json({ error: "route_not_found" }, 404);
    });
    const client = new EvidenceApiClient(fetchMock as unknown as typeof fetch);

    await client.discover({ skuId: "case.vendor-model" });
    await client.acquire({ url: "https://vendor.test/manual.pdf", skuId: "case.vendor-model", kind: "manufacturer-manual", title: "Manual" });
    await client.getDocument("doc-sha256-a");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/evidence/discover",
      "/api/evidence/acquisitions",
      "/api/evidence/documents/doc-sha256-a",
    ]);
    for (const call of fetchMock.mock.calls.slice(0, 2)) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    }
    expect(client.contentUrl("doc-sha256-a")).toBe("/api/evidence/documents/doc-sha256-a/content");
  });

  it("surfaces manual recovery instructions returned by the evidence service", async () => {
    const fetchMock = vi.fn(async () => json({ error: "official_url_required", message: "无法确认官网", manualAction: "请粘贴厂商手册 URL" }, 422));
    const client = new EvidenceApiClient(fetchMock as unknown as typeof fetch);
    await expect(client.discover({ skuId: "case.unknown" })).rejects.toEqual(expect.objectContaining({
      name: "EvidenceApiError",
      status: 422,
      code: "official_url_required",
      manualAction: "请粘贴厂商手册 URL",
    } satisfies Partial<EvidenceApiError>));
  });

  it("calls the many-to-many plan binding routes and sends revision JSON on unbind", async () => {
    const binding = { id: "binding-sha256-c" };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return json(binding, 201);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ bindings: [binding] });
    });
    const client = new WorkspaceApiClient(fetchMock as unknown as typeof fetch);

    await client.listEvidenceBindings("plan-12345678");
    await client.bindEvidence("plan-12345678", {
      expectedRevision: 4,
      documentId: "doc-sha256-a",
      subject: { kind: "sku", id: "case.vendor-model", category: "case" },
      purposes: ["geometry"],
      idempotencyKey: "bind-once",
    });
    await client.unbindEvidence("plan-12345678", {
      expectedRevision: 5,
      bindingId: "binding-sha256-c",
      idempotencyKey: "unbind-once",
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/workspace/plans/plan-12345678/evidence-bindings",
      "/api/workspace/plans/plan-12345678/evidence-bindings",
      "/api/workspace/plans/plan-12345678/evidence-bindings/binding-sha256-c",
    ]);
    const unbindInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(unbindInit.method).toBe("DELETE");
    expect(new Headers(unbindInit.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(unbindInit.body))).toEqual({ expectedRevision: 5, idempotencyKey: "unbind-once" });
  });
});

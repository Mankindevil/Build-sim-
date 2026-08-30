import { describe, expect, it, vi } from "vitest";
import { probeProductionDoctorCapabilities } from "../src/doctor/production-probes.mjs";

function jsonResponse(payload: unknown, date: string): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", Date: date },
  });
}

describe("U12 production Doctor probes", () => {
  it("verifies exact loopback service identities and local process capabilities", async () => {
    const date = "Sun, 30 Aug 2026 09:00:00 GMT";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/price/health")) return jsonResponse({ ok: true, service: "build-sim-price", version: "0.2.0-alpha" }, date);
      if (url.endsWith("/api/agent/health")) return jsonResponse({ ok: true, service: "build-sim-agent", version: "0.2.0-alpha" }, date);
      if (url.endsWith("/api/workspace/health")) return jsonResponse({ ok: true, service: "build-sim-workspace", version: "0.2.0-alpha" }, date);
      return new Response("ready", { status: 200, headers: { Date: date } });
    });
    const result = await probeProductionDoctorCapabilities({
      coordinator: { readState: async () => ({ appVersion: "0.2.0-alpha" }) },
      environment: {
        PRICE_SERVER_PORT: "5174",
        AGENT_SERVER_PORT: "5175",
        WORKSPACE_SERVER_PORT: "5176",
        SEARXNG_BASE_URL: "http://127.0.0.1:18080/",
      },
      fetchImpl: fetchImpl as typeof fetch,
      browserWebglProbe: async () => true,
      pdfParserProbe: async () => true,
      offline: false,
    });

    expect(result).toEqual({
      serviceVersionsVerified: true,
      browserWebglAvailable: true,
      pdfParserAvailable: true,
      searxngAvailable: true,
      referenceClockMs: Date.parse(date),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("fails closed without contacting non-loopback probe URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 200 }));
    const result = await probeProductionDoctorCapabilities({
      coordinator: { readState: async () => ({ appVersion: "0.2.0-alpha" }) },
      environment: {
        DOCTOR_PRICE_HEALTH_URL: "https://example.invalid/api/price/health",
        DOCTOR_AGENT_HEALTH_URL: "http://192.0.2.1/api/agent/health",
        DOCTOR_WORKSPACE_HEALTH_URL: "http://[2001:db8::1]/api/workspace/health",
        SEARXNG_BASE_URL: "https://example.invalid/",
      },
      fetchImpl: fetchImpl as typeof fetch,
      browserWebglProbe: async () => false,
      pdfParserProbe: async () => false,
      offline: false,
    });

    expect(result).toMatchObject({
      serviceVersionsVerified: false,
      browserWebglAvailable: false,
      pdfParserAvailable: false,
      searxngAvailable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

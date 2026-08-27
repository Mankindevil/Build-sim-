import { describe, expect, it } from "vitest";
import {
  createAuthoritativeResolver,
  isTrustedResolution,
  resolveAuthoritativeContext,
  type AuthoritativeResolver,
} from "../src/contracts/trusted-context";

describe("U0 server-issued authoritative context", () => {
  it("rejects structural fakes and JSON clones at runtime", async () => {
    const resolver = createAuthoritativeResolver("listing-capture", async (ref) => ref === "capture" ? { source: "repository" } : undefined);
    const resolution = await resolver.resolve("capture");
    expect(isTrustedResolution(resolution, "capture")).toBe(true);
    expect(isTrustedResolution(JSON.parse(JSON.stringify(resolution)), "capture")).toBe(false);

    const fakeResolver = {
      authorityKind: "listing-capture",
      async resolve(ref: string) { return { ref, value: { source: "request-json" } }; },
    } as unknown as AuthoritativeResolver<{ source: string }, "listing-capture">;
    await expect(resolveAuthoritativeContext(fakeResolver, "listing-capture", "capture"))
      .resolves.toEqual({ ok: false, error: "resolver was not issued by the server composition root" });
    await expect(resolveAuthoritativeContext(JSON.parse(JSON.stringify(resolver)), "listing-capture", "capture"))
      .resolves.toEqual({ ok: false, error: "resolver was not issued by the server composition root" });
  });

  it("rejects missing refs, mismatched authority and resolver tampering", async () => {
    const resolver = createAuthoritativeResolver("listing-capture", (ref) => ref === "capture" ? { source: "repository" } : undefined);
    await expect(resolveAuthoritativeContext(resolver, "listing-capture", "missing"))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("authoritative reference not found") });
    await expect(resolveAuthoritativeContext(resolver, "doctor-verification-context", "capture"))
      .resolves.toEqual({ ok: false, error: "resolver authority mismatch: expected doctor-verification-context" });
    expect(() => Object.assign(resolver, { resolve: async () => ({}) })).toThrow();
  });
});

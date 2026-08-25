import { describe, expect, it } from "vitest";
import { detectWebGl, shouldUseSpatialFallback } from "../src/spatial/fallback";

describe("R5 spatial fallback", () => {
  it("falls back without a canvas or context", () => {
    expect(detectWebGl(null)).toEqual({ available: false, reason: "no-canvas" });
    const capability = detectWebGl(() => ({ getContext: () => null }) as unknown as HTMLCanvasElement);
    expect(capability).toEqual({ available: false, reason: "no-context" });
    expect(shouldUseSpatialFallback(capability)).toBe(true);
  });

  it("supports explicit fallback and a valid WebGL context", () => {
    expect(detectWebGl(() => ({ getContext: () => ({}) }) as unknown as HTMLCanvasElement)).toEqual({ available: true, reason: "supported" });
    expect(detectWebGl(() => ({ getContext: () => ({}) }) as unknown as HTMLCanvasElement, true)).toEqual({ available: false, reason: "forced" });
  });
});

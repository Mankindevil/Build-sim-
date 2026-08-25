export interface WebGlCapability {
  available: boolean;
  reason: "supported" | "no-canvas" | "no-context" | "context-error" | "forced";
}

export function detectWebGl(
  createCanvas: (() => Pick<HTMLCanvasElement, "getContext">) | null = typeof document === "undefined" ? null : () => document.createElement("canvas"),
  forceFallback = false,
): WebGlCapability {
  if (forceFallback) return { available: false, reason: "forced" };
  if (!createCanvas) return { available: false, reason: "no-canvas" };
  try {
    const canvas = createCanvas();
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return context ? { available: true, reason: "supported" } : { available: false, reason: "no-context" };
  } catch {
    return { available: false, reason: "context-error" };
  }
}

export function shouldUseSpatialFallback(capability: WebGlCapability): boolean {
  return !capability.available;
}

import { describe, expect, it, vi } from "vitest";
import { parseWorkspaceRoute, WorkspaceRouter } from "../src/lab/workspace-router";

describe("R2 workspace routing", () => {
  it("parses deep links and falls back to the workspace", () => {
    expect(parseWorkspaceRoute("#/spatial")).toBe("spatial");
    expect(parseWorkspaceRoute("#/editor?field=psu")).toBe("editor");
    expect(parseWorkspaceRoute("#unknown")).toBe("workspace");
  });

  it("uses browser history and exposes stable section targets", () => {
    const listeners = new Map<string, EventListener>();
    const location = { hash: "#/workspace" } as Location;
    const history = { pushState: vi.fn((_state, _title, url) => { location.hash = String(url); }), replaceState: vi.fn() } as unknown as History;
    const windowRef = { location, history, addEventListener: vi.fn((type, listener) => listeners.set(type, listener as EventListener)), removeEventListener: vi.fn() } as unknown as Window;
    const router = new WorkspaceRouter(windowRef);
    const routes: string[] = [];
    router.subscribe((route) => routes.push(route));
    router.start();
    router.navigate("agent");
    expect(history.pushState).toHaveBeenCalledWith({}, "", "#/agent");
    expect(router.target()).toBe("workspace-page-agent");
    expect(routes).toEqual(["workspace", "agent"]);
    router.stop();
  });
});

export const WORKSPACE_ROUTES = ["workspace", "editor", "evaluation", "spatial", "purchases", "build", "agent"] as const;
export type WorkspaceRoute = (typeof WORKSPACE_ROUTES)[number];

const routeTargets: Record<WorkspaceRoute, string> = {
  workspace: "top",
  editor: "lab-config-title",
  evaluation: "workspace-results",
  spatial: "spatial-stage",
  purchases: "build-base-dialog",
  build: "build-progress-summary",
  agent: "agent-title",
};

export function parseWorkspaceRoute(hash: string): WorkspaceRoute {
  const route = hash.replace(/^#\/?/, "").split(/[/?]/, 1)[0];
  return WORKSPACE_ROUTES.includes(route as WorkspaceRoute) ? route as WorkspaceRoute : "workspace";
}

export class WorkspaceRouter {
  private listeners = new Set<(route: WorkspaceRoute) => void>();
  private route: WorkspaceRoute;

  constructor(private readonly windowRef: Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener"> = window) {
    this.route = parseWorkspaceRoute(windowRef.location.hash);
  }

  private readonly onPop = () => {
    this.route = parseWorkspaceRoute(this.windowRef.location.hash);
    this.emit();
  };

  start(): void {
    this.windowRef.addEventListener("popstate", this.onPop);
    this.windowRef.addEventListener("hashchange", this.onPop);
  }

  stop(): void {
    this.windowRef.removeEventListener("popstate", this.onPop);
    this.windowRef.removeEventListener("hashchange", this.onPop);
  }

  current(): WorkspaceRoute { return this.route; }

  navigate(route: WorkspaceRoute, replace = false): void {
    const url = `#/${route}`;
    if (replace) this.windowRef.history.replaceState({}, "", url);
    else this.windowRef.history.pushState({}, "", url);
    this.route = route;
    this.emit();
  }

  subscribe(listener: (route: WorkspaceRoute) => void): () => void {
    this.listeners.add(listener);
    listener(this.route);
    return () => this.listeners.delete(listener);
  }

  target(route = this.route): string { return routeTargets[route]; }

  private emit(): void {
    for (const listener of this.listeners) listener(this.route);
  }
}


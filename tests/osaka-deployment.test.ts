import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Osaka lifecycle deployment", () => {
  it("runs the workspace service against the persistent runtime mount", async () => {
    const compose = await readFile("deploy/osaka/compose.yaml", "utf8");
    const env = await readFile("deploy/osaka/env.remote.example", "utf8");
    expect(compose).toContain("workspace:");
    expect(compose).toContain('["node", "dist-workspace/workspace-server.js"]');
    expect(compose).toContain("../../runtime:/app/runtime");
    expect(env).toContain("WORKSPACE_SERVER_PORT=5176");
    expect(env).toContain("PLAN_REPOSITORY_ROOT=/app/runtime/plans");
  });

  it("publishes the authenticated workspace API through host Nginx", async () => {
    const nginx = await readFile("deploy/osaka/nginx-build-sim.conf", "utf8");
    expect(nginx).toContain("location /api/workspace/");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:5176;");
  });

  it("ships a rollback-capable deployment script with bounded health checks", async () => {
    const script = await readFile("deploy/osaka/deploy.sh", "utf8");
    expect(script).toContain("git merge-base --is-ancestor");
    expect(script).toContain("build-sim-web:rollback");
    expect(script).toContain("build-sim-runtime:rollback");
    expect(script).toContain("BUILD_SIM_HEALTH_ATTEMPTS");
    expect(script).toContain("restore_previous_release");
    expect(script).toContain("/api/workspace/plans");
  });
});

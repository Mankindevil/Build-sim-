import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function serviceBlock(compose: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) return "";
  const tail = compose.slice(start + marker.length);
  const next = /^  [a-z0-9-]+:\n/m.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}

describe("Osaka lifecycle deployment", () => {
  it("runs the workspace service against the persistent runtime mount", async () => {
    const compose = await readFile("deploy/osaka/compose.yaml", "utf8");
    const env = await readFile("deploy/osaka/env.remote.example", "utf8");
    expect(compose).toContain("workspace:");
    expect(serviceBlock(compose, "workspace")).toContain('["node", "dist-workspace/workspace-server.js"]');
    expect(compose).toContain("../../runtime:/app/runtime");
    expect(env).toContain("WORKSPACE_SERVER_PORT=5176");
    expect(env).toContain("PLAN_REPOSITORY_ROOT=/app/runtime/plans");
  });

  it("runs one preflight before every runtime-backed business service", async () => {
    const compose = await readFile("deploy/osaka/compose.yaml", "utf8");
    const preflight = serviceBlock(compose, "runtime-preflight");
    const price = serviceBlock(compose, "price");
    const workspace = serviceBlock(compose, "workspace");
    const agent = serviceBlock(compose, "agent");

    expect(compose.match(/migrate-runtime-v1\.mjs/g)).toHaveLength(1);
    expect(preflight).toContain('["node", "scripts/migrations/migrate-runtime-v1.mjs", "--preflight", "--runtime-root", "/app/runtime"]');
    expect(preflight).toContain("../../runtime:/app/runtime");
    expect(preflight).toContain('restart: "no"');
    for (const block of [price, workspace]) {
      expect(block).toContain("runtime-preflight:");
      expect(block).toContain("condition: service_completed_successfully");
      expect(block).not.toContain("--preflight");
    }
    expect(agent).toContain("price:");
    expect(agent).toContain("condition: service_started");
    expect(agent).not.toContain("--preflight");
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
    expect(script).toContain("/api/workspace/health");
    expect(script).toContain("scripts/backup/create.mjs");
    expect(script).toContain("scripts/backup/verify.mjs");
    expect(script).toContain("scripts/doctor.mjs --runtime-root /app/runtime --strict");
  });

  it("blocks release startup until the universal canary and independent holdouts pass", async () => {
    const script = await readFile("deploy/osaka/deploy.sh", "utf8");
    const canary = script.indexOf("npm run release:canary");
    const holdouts = script.indexOf("npm run release:holdouts -- /app/runtime/release-evidence/physical-holdouts");
    const backup = script.indexOf("node scripts/backup/create.mjs");
    const releaseStart = script.indexOf("RELEASE_STARTED=1", holdouts);
    const startup = script.indexOf('"${COMPOSE[@]}" up -d --force-recreate', backup);

    expect(canary).toBeGreaterThan(-1);
    expect(script).toContain("npm run release:canary -- --source-runtime-root /app/runtime");
    expect(holdouts).toBeGreaterThan(canary);
    expect(backup).toBeGreaterThan(holdouts);
    expect(releaseStart).toBeGreaterThan(backup);
    expect(startup).toBeGreaterThan(releaseStart);
    expect(script).toContain("if ((IMAGES_CHANGED)); then");
    expect(script).toContain("if ((RELEASE_STARTED)); then");
  });
});

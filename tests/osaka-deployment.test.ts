import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

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

  it("rotates the host login from a private deployment-only environment file", async () => {
    const script = await readFile("deploy/osaka/deploy.sh", "utf8");
    const updater = await readFile("deploy/osaka/update-basic-auth.sh", "utf8");
    const example = await readFile("deploy/osaka/auth.env.example", "utf8");
    const compose = await readFile("deploy/osaka/compose.yaml", "utf8");

    expect(example).toContain("BUILD_SIM_BASIC_AUTH_USERNAME=buildsim");
    expect(example).toContain("BUILD_SIM_BASIC_AUTH_PASSWORD=");
    expect(script).toContain('AUTH_ENV_FILE="${AUTH_ENV_FILE:-$APP_DIR/.env.auth}"');
    expect(script).toContain("Site-login environment must have mode 600");
    expect(script).toContain("Deployment environment must have mode 600");
    expect(script).toContain('update-basic-auth.sh" "$AUTH_ENV_FILE"');
    expect(updater).toContain("htpasswd -ciB");
    expect(updater).toContain("htpasswd -vi");
    expect(updater).toContain("systemctl reload nginx");
    expect(updater).not.toContain('htpasswd -b');
    expect(compose).not.toContain(".env.auth");
  });

  it("atomically replaces the configured login without exposing the password in updater output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-auth-test-"));
    const fakeBin = path.join(root, "bin");
    const authEnv = path.join(root, ".env.auth");
    const authFile = path.join(root, ".htpasswd-build-sim");
    const firstPassword = "first-local-password-123";
    const secondPassword = "second-local-password-456";
    const [{ stdout: owner }, { stdout: group }] = await Promise.all([
      execFileAsync("id", ["-un"]),
      execFileAsync("id", ["-gn"]),
    ]);
    await mkdir(fakeBin);
    await writeFile(path.join(fakeBin, "sudo"), "#!/usr/bin/env bash\n[[ \"$1\" == \"-n\" ]] && shift\nexec \"$@\"\n", { mode: 0o755 });
    await writeFile(path.join(fakeBin, "nginx"), "#!/usr/bin/env bash\n[[ \"$1\" == \"-t\" ]]\n", { mode: 0o755 });
    await writeFile(path.join(fakeBin, "systemctl"), "#!/usr/bin/env bash\n[[ \"$1\" == \"reload\" && \"$2\" == \"nginx\" ]]\n", { mode: 0o755 });

    const runUpdate = async (password: string) => {
      await writeFile(authEnv, `BUILD_SIM_BASIC_AUTH_USERNAME=buildsim\nBUILD_SIM_BASIC_AUTH_PASSWORD=${password}\n`, { mode: 0o600 });
      await chmod(authEnv, 0o600);
      return execFileAsync("bash", ["deploy/osaka/update-basic-auth.sh", authEnv], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          BUILD_SIM_BASIC_AUTH_FILE: authFile,
          BUILD_SIM_BASIC_AUTH_OWNER: owner.trim(),
          BUILD_SIM_BASIC_AUTH_GROUP: group.trim(),
        },
      });
    };

    const first = await runUpdate(firstPassword);
    expect(first.stdout).not.toContain(firstPassword);
    await expect(execFileAsync("htpasswd", ["-vb", authFile, "buildsim", firstPassword])).resolves.toBeDefined();

    const second = await runUpdate(secondPassword);
    expect(second.stdout).not.toContain(secondPassword);
    await expect(execFileAsync("htpasswd", ["-vb", authFile, "buildsim", secondPassword])).resolves.toBeDefined();
    await expect(execFileAsync("htpasswd", ["-vb", authFile, "buildsim", firstPassword])).rejects.toBeDefined();
    expect((await readFile(authFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("ships a rollback-capable deployment script with bounded health checks", async () => {
    const script = await readFile("deploy/osaka/deploy.sh", "utf8");
    expect(script).toContain("git merge-base --is-ancestor");
    expect(script).toContain("build-sim-web:rollback");
    expect(script).toContain("build-sim-runtime:rollback");
    expect(script).toContain("container inspect --format '{{.Image}}' build-sim-osaka-price-1");
    expect(script).toContain("container inspect --format '{{.Image}}' build-sim-osaka-web-1");
    expect(script).toContain("BUILD_SIM_HEALTH_ATTEMPTS");
    expect(script).toContain("restore_previous_release");
    expect(script).toContain("/api/workspace/health");
    expect(script).toContain("scripts/backup/create.mjs");
    expect(script).toContain("scripts/backup/verify.mjs");
    expect(script).toContain("scripts/runtime/initialize-artifact-repository.mjs --runtime-root /app/runtime");
    expect(script).toContain("scripts/runtime/persist-reference-graph.mjs --runtime-root /app/runtime");
    expect(script).toContain("scripts/doctor.mjs --runtime-root /app/runtime --strict");
  });

  it("blocks release startup until the universal canary and independent professional review validation pass", async () => {
    const script = await readFile("deploy/osaka/deploy.sh", "utf8");
    const canary = script.indexOf("npm run release:canary");
    const holdouts = script.indexOf("npm run release:external-reviews -- /app/runtime/release-evidence/external-reviews");
    const backup = script.indexOf("node scripts/backup/create.mjs");
    const releaseStart = script.indexOf("RELEASE_STARTED=1", holdouts);
    const startup = script.indexOf('"${COMPOSE[@]}" up -d --force-recreate', backup);
    const initializeArtifacts = script.indexOf("scripts/runtime/initialize-artifact-repository.mjs --runtime-root /app/runtime", startup);
    const refreshGraph = script.indexOf("scripts/runtime/persist-reference-graph.mjs --runtime-root /app/runtime", initializeArtifacts);
    const doctor = script.indexOf("scripts/doctor.mjs --runtime-root /app/runtime --strict", refreshGraph);

    expect(canary).toBeGreaterThan(-1);
    expect(script).toContain("npm run release:canary -- --source-runtime-root /app/runtime --generic-platform");
    expect(holdouts).toBeGreaterThan(canary);
    expect(backup).toBeGreaterThan(holdouts);
    expect(releaseStart).toBeGreaterThan(backup);
    expect(startup).toBeGreaterThan(releaseStart);
    expect(initializeArtifacts).toBeGreaterThan(startup);
    expect(refreshGraph).toBeGreaterThan(startup);
    expect(doctor).toBeGreaterThan(refreshGraph);
    expect(script).toContain("if ((IMAGES_CHANGED)); then");
    expect(script).toContain("if ((RELEASE_STARTED)); then");
  });
});

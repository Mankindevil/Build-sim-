import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "infra/searxng/compose.yaml");
const command = process.argv[2] ?? "status";
const endpoint = "http://127.0.0.1:8080";

function docker(args, { secret = process.env.SEARXNG_SECRET } = {}) {
  return new Promise((resolve, reject) => {
    const runtimeSecret = secret || crypto.randomBytes(32).toString("hex");
    const child = spawn("docker", ["compose", "-f", composeFile, ...args], {
      cwd: root,
      env: { ...process.env, SEARXNG_SECRET: runtimeSecret },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker compose exited with ${code}`)));
  });
}

async function health(timeoutMs = 60_000) {
  const started = Date.now();
  let last = "not reachable";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${endpoint}/search?q=build-sim-health&format=json`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      const text = await response.text();
      if (response.ok && JSON.parse(text)?.results instanceof Array) {
        process.stdout.write(`${JSON.stringify({ ok: true, endpoint, jsonApi: true })}\n`);
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error?.message ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`SearXNG health check failed: ${last}`);
}

if (command === "up") {
  const secret = process.env.SEARXNG_SECRET || crypto.randomBytes(32).toString("hex");
  await docker(["up", "-d", "--wait"], { secret });
  await health();
} else if (command === "health") {
  await health(10_000);
} else if (command === "status") {
  await docker(["ps"]);
} else if (command === "stop") {
  await docker(["stop"]);
} else {
  throw new Error("usage: node scripts/searxng-local.mjs <up|health|status|stop>");
}

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enumerateSecretScanFiles,
  listSecretScanFilesFromFilesystem,
  scanAgentSecrets,
} from "../scripts/agent-secret-scan.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "buildsim-secret-scan-"));
  roots.push(root);
  await writeFile(path.join(root, ".gitignore"), [
    "node_modules/", "dist/", ".env", ".env.*", "!.env.example", "*.log", "",
  ].join("\n"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "src", "safe.ts"), "export const value = 'safe';\n");
  await writeFile(path.join(root, "src", "new.ts"), `const token = '${["sk-", "abcdefghijklmnopqrstuvwxyz"].join("")}';\n`);
  await writeFile(path.join(root, "dist", "ignored.js"), `const token = '${["sk-", "ignoredignoredignoredignored"].join("")}';\n`);
  await writeFile(path.join(root, ".env.remote"), "DEEPSEEK_API_KEY=ignored-local-value\n");
  await writeFile(path.join(root, ".env.example"), "DEEPSEEK_API_KEY=<set-me>\n");
  await writeFile(path.join(root, "debug.log"), `${["sk-", "ignoredignoredignoredignored"].join("")}\n`);
  return root;
}

describe("agent secret scan", () => {
  it("uses a deterministic no-child-process fallback that honors root ignore rules", async () => {
    const root = await fixture();
    const files = await listSecretScanFilesFromFilesystem(root);
    expect(files).toEqual([".env.example", ".gitignore", "src/new.ts", "src/safe.ts"]);
    const enumerated = await enumerateSecretScanFiles(root, { forceFilesystemFallback: true });
    expect(enumerated).toEqual({ source: "filesystem_fallback", files });
    const result = await scanAgentSecrets({ root, forceFilesystemFallback: true });
    expect(result).toMatchObject({ ok: false, filesScanned: 4, enumeration: "filesystem_fallback" });
    expect(result.findings).toEqual([{ file: "src/new.ts", line: 1, rule: "key-like-token" }]);
  });

  it("never follows symlinks and rejects unsafe caller-provided paths", async () => {
    const root = await fixture();
    await symlink(path.join(root, "src", "new.ts"), path.join(root, "linked.ts"));
    expect(await listSecretScanFilesFromFilesystem(root)).not.toContain("linked.ts");
    await expect(scanAgentSecrets({ root, files: ["../outside"] })).rejects.toThrow(/unsafe path/);
  });

  it("preserves the established finding rules without printing secret contents", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "rules.ts"), [
      `const ${["VITE_", "SERVICE_TOKEN"].join("")} = 'public-bundle-secret';`,
      ["ANTHROPIC_API", "KEY=real-looking-value"].join("_"),
      `const value = '${["ds-", "abcdefghijklmnopqrstuvwxyz"].join("")}';`,
      "",
    ].join("\n"));
    const result = await scanAgentSecrets({ root, files: ["src/rules.ts"] });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      { file: "src/rules.ts", line: 1, rule: "client-secret-name" },
      { file: "src/rules.ts", line: 2, rule: "committed-provider-key" },
      { file: "src/rules.ts", line: 3, rule: "key-like-token" },
    ]);
    expect(JSON.stringify(result)).not.toContain("real-looking-value");
  });
});

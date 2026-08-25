#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root });
const files = listed.toString("utf8").split("\0").filter(Boolean);
const findings = [];
let filesScanned = 0;

for (const relative of files) {
  const file = path.resolve(root, relative);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > 2_000_000) continue;
  const buffer = await readFile(file);
  if (buffer.includes(0)) continue;
  filesScanned += 1;
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/VITE_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)/.test(line)) {
      findings.push({ file: relative, line: index + 1, rule: "client-secret-name" });
    }
    const assignment = line.match(/^\s*(DEEPSEEK_API_KEY|ANTHROPIC_API_KEY)\s*=\s*(.*?)\s*$/);
    if (assignment?.[2] && !/^<[^>]+>$/.test(assignment[2])) {
      findings.push({ file: relative, line: index + 1, rule: "committed-provider-key" });
    }
    if (/\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/.test(line)) {
      findings.push({ file: relative, line: index + 1, rule: "key-like-token" });
    }
  });
}

const result = { ok: findings.length === 0, filesScanned, findings };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

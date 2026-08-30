#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE_BYTES = 2_000_000;
const MAX_IGNORE_BYTES = 256_000;

function portable(relative) {
  return relative.split(path.sep).join("/");
}

function safeRelative(relative) {
  return typeof relative === "string"
    && relative.length > 0
    && !path.isAbsolute(relative)
    && !portable(relative).split("/").includes("..");
}

function globExpression(pattern) {
  let value = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      value += ".*";
      index += 1;
    } else if (character === "*") value += "[^/]*";
    else if (character === "?") value += "[^/]";
    else value += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`^${value}$`, "u");
}

function ignoreMatch(relative, isDirectory, rawPattern) {
  const directoryOnly = rawPattern.endsWith("/");
  if (directoryOnly && !isDirectory) return false;
  let pattern = directoryOnly ? rawPattern.slice(0, -1) : rawPattern;
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (!pattern) return false;
  const expression = globExpression(pattern);
  if (anchored || pattern.includes("/")) return expression.test(relative);
  return relative.split("/").some((segment) => expression.test(segment));
}

function ignored(relative, isDirectory, patterns) {
  let result = false;
  for (const entry of patterns) {
    const negated = entry.startsWith("!");
    const pattern = negated ? entry.slice(1) : entry;
    if (ignoreMatch(relative, isDirectory, pattern)) result = !negated;
  }
  return result;
}

async function readRootIgnorePatterns(root) {
  const file = path.join(root, ".gitignore");
  const info = await lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_IGNORE_BYTES) {
    throw new Error("secret scan root .gitignore must be a bounded regular file");
  }
  return (await readFile(file, "utf8")).split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export async function listSecretScanFilesFromFilesystem(rootValue) {
  const root = path.resolve(rootValue);
  const patterns = await readRootIgnorePatterns(root);
  const files = [];
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop();
    const absolute = path.join(root, directory);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).reverse()) {
      const relative = portable(path.join(directory, entry.name));
      if (!safeRelative(relative) || relative === ".git" || relative.startsWith(".git/")) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignored(relative, true, patterns)) pending.push(relative);
      } else if (entry.isFile() && !ignored(relative, false, patterns)) files.push(relative);
    }
  }
  return files.sort();
}

function listSecretScanFilesWithGit(root) {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = listed.split("\0").filter(Boolean);
  if (files.some((relative) => !safeRelative(relative))) throw new Error("git returned an unsafe secret-scan path");
  return [...new Set(files.map(portable))].sort();
}

export async function enumerateSecretScanFiles(rootValue, options = {}) {
  const root = path.resolve(rootValue);
  if (options.forceFilesystemFallback !== true) {
    try {
      return { source: "git", files: listSecretScanFilesWithGit(root) };
    } catch {
      // Restricted production and CI sandboxes can forbid child processes even
      // when the repository itself is readable. The local walker applies this
      // repository's root ignore rules and never follows symbolic links.
    }
  }
  return { source: "filesystem_fallback", files: await listSecretScanFilesFromFilesystem(root) };
}

export async function scanAgentSecrets(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const enumeration = options.files === undefined
    ? await enumerateSecretScanFiles(root, { forceFilesystemFallback: options.forceFilesystemFallback === true })
    : { source: "provided", files: [...options.files].sort() };
  const findings = [];
  let filesScanned = 0;

  for (const relative of enumeration.files) {
    if (!safeRelative(relative)) throw new Error("secret scan file list contains an unsafe path");
    const file = path.resolve(root, relative);
    if (path.relative(root, file).startsWith("..")) throw new Error("secret scan file escaped its root");
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) continue;
    const buffer = await readFile(file);
    if (buffer.includes(0)) continue;
    filesScanned += 1;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (/VITE_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)/u.test(line)) {
        findings.push({ file: relative, line: index + 1, rule: "client-secret-name" });
      }
      const assignment = line.match(/^\s*(DEEPSEEK_API_KEY|ANTHROPIC_API_KEY)\s*=\s*(.*?)\s*$/u);
      if (assignment?.[2] && !/^<[^>]+>$/u.test(assignment[2])) {
        findings.push({ file: relative, line: index + 1, rule: "committed-provider-key" });
      }
      if (/\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/u.test(line)) {
        findings.push({ file: relative, line: index + 1, rule: "key-like-token" });
      }
    });
  }

  return { ok: findings.length === 0, filesScanned, findings, enumeration: enumeration.source };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await scanAgentSecrets();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

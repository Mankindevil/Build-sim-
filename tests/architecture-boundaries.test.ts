import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import baseline from "./fixtures/baseline/n6-core-imports.json";

type DebtKind = "static-import" | "concrete-reference";
type Debt = { path: string; line: number; kind: DebtKind };
type DebtLimit = { path: string; kind: DebtKind; maxOccurrences: number };
type SourceText = { path: string; content: string };

const testsDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(testsDir, "../src");
const sourceExtensions = /\.(?:[cm]?[jt]sx?|mjs|css|html)$/;
const tokenPattern = new RegExp(baseline.tokenPattern);
const explicitCompositionFiles = new Set(["src/adapters/legacy-runtime-bootstrap.ts"]);
const caseSpecificFiles = new Set([
  ...(baseline.caseSpecificFiles as string[]),
  "src/adapters/jonsbo-n6/runtime-registration.ts",
]);
const strictGenericPrefixes = ["src/core/", "src/config/", "src/spatial/", "src/wiring/", "src/server/"] as const;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(root, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : sourceExtensions.test(entry.name) ? [file] : [];
  });
}

function scanDebt(sources: readonly SourceText[]): Debt[] {
  const debt: Debt[] = [];
  for (const source of sources) {
    // Only the concrete adapter implementation is exempt. Legacy lab/spatial
    // files remain scanned and ratcheted even when they are already N6-heavy.
    if (caseSpecificFiles.has(source.path) || explicitCompositionFiles.has(source.path)) continue;
    source.content.split(/\r?\n/).forEach((line, index) => {
      const text = line.trim();
      if (!text || text.startsWith("//") || text.startsWith("/*") || text.startsWith("*")) return;
      if (!tokenPattern.test(line)) return;
      const kind: DebtKind = /^\s*import\b|\bfrom\s+["']/.test(line) ? "static-import" : "concrete-reference";
      debt.push({ path: source.path, line: index + 1, kind });
    });
  }
  return debt;
}

function isStrictGenericPath(path: string): boolean {
  return strictGenericPrefixes.some((prefix) => path.startsWith(prefix))
    || (path.startsWith("src/adapters/")
      && !caseSpecificFiles.has(path)
      && !explicitCompositionFiles.has(path));
}

function strictGenericDebt(debt: readonly Debt[]): Debt[] {
  return debt.filter((entry) => isStrictGenericPath(entry.path));
}

function currentDebt(): Debt[] {
  return scanDebt(sourceFiles(sourceRoot).map((file) => ({
    path: relative(resolve(sourceRoot, ".."), file).split("\\").join("/"),
    content: readFileSync(file, "utf8"),
  })));
}

function ratchetErrors(debt: readonly Debt[]): string[] {
  const limits = new Map((baseline.maxDebt as DebtLimit[]).map((entry) => [`${entry.path}\0${entry.kind}`, entry.maxOccurrences]));
  const counts = new Map<string, number>();
  for (const entry of debt) {
    const key = `${entry.path}\0${entry.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const errors: string[] = [];
  for (const [key, count] of counts) {
    const limit = limits.get(key);
    if (limit === undefined) errors.push(`unregistered N6/JONSBO debt: ${key.replace("\0", ":")}`);
    else if (count > limit) errors.push(`N6/JONSBO debt increased: ${key.replace("\0", ":")} ${count} > ${limit}`);
  }
  return errors;
}

describe("universal architecture boundaries", () => {
  it("keeps generic core, config, spatial, wiring, server and adapters at absolute zero", () => {
    expect([...explicitCompositionFiles]).toEqual(["src/adapters/legacy-runtime-bootstrap.ts"]);
    expect(strictGenericDebt(currentDebt())).toEqual([]);

    const injected = scanDebt([{
      path: "src/core/new-case-default.ts",
      content: "export const concreteCase = 'case.jonsbo-n6';",
    }]);
    expect(strictGenericDebt(injected)).toEqual([
      { path: "src/core/new-case-default.ts", line: 1, kind: "concrete-reference" },
    ]);
  });

  it("exempts only exact case-adapter implementations and ratchets every legacy file", () => {
    expect(baseline.schemaVersion).toBe("u0.n6-core-import-baseline/3.0.0");
    expect(baseline.scope).toContain("every legacy lab/spatial");
    expect(new Set(baseline.caseSpecificFiles).size).toBe(baseline.caseSpecificFiles.length);
    expect((baseline.maxDebt as DebtLimit[]).some((entry) => entry.path === "src/lab/boot.ts")).toBe(true);
    expect((baseline.maxDebt as DebtLimit[]).some((entry) => entry.path === "src/spatial/model.ts")).toBe(true);
    expect(ratchetErrors(currentDebt())).toEqual([]);
    expect(currentDebt().some((entry) => entry.kind === "static-import")).toBe(true);

    // Removing debt never requires raising or rewriting the baseline.
    expect(ratchetErrors(currentDebt().slice(1))).toEqual([]);
  });

  it("closes directory-prefix and same-file count bypasses", () => {
    const newLabFile = scanDebt([{
      path: "src/lab/new-universal-panel.ts",
      content: "export const caseId = 'case.jonsbo-n6';",
    }]);
    expect(ratchetErrors(newLabFile)).toEqual([
      "unregistered N6/JONSBO debt: src/lab/new-universal-panel.ts:concrete-reference",
    ]);

    const lookalikeAllowedPath = scanDebt([{
      path: "src/lab/boot.ts.backup.ts",
      content: "import profile from '../../data/cases/jonsbo-n6/profile.json';",
    }]);
    expect(ratchetErrors(lookalikeAllowedPath)).toEqual([
      "unregistered N6/JONSBO debt: src/lab/boot.ts.backup.ts:static-import",
    ]);

    const existing = currentDebt();
    const bootInjected = scanDebt([{
      path: "src/lab/boot.ts",
      content: `${readFileSync(resolve(sourceRoot, "lab/boot.ts"), "utf8")}\nimport extraN6Profile from '../../data/cases/jonsbo-n6/profile.json';`,
    }]);
    expect(ratchetErrors([...existing.filter((entry) => entry.path !== "src/lab/boot.ts"), ...bootInjected]))
      .toContain("N6/JONSBO debt increased: src/lab/boot.ts:static-import 4 > 3");

    const spatialInjected = scanDebt([{
      path: "src/spatial/model.ts",
      content: `${readFileSync(resolve(sourceRoot, "spatial/model.ts"), "utf8")}\nexport const extraN6SpatialDefault = 'jonsbo-n6';`,
    }]);
    expect(strictGenericDebt(spatialInjected)).toEqual([
      expect.objectContaining({ path: "src/spatial/model.ts", kind: "concrete-reference" }),
    ]);

    const oneLimit = (baseline.maxDebt as DebtLimit[]).find((entry) => entry.path === "src/config/io.ts" && entry.kind === "concrete-reference");
    expect(oneLimit).toBeDefined();
    const injected = Array.from({ length: (oneLimit?.maxOccurrences ?? 0) + 1 }, (_, line) => ({
      path: "src/config/io.ts", line: line + 1, kind: "concrete-reference" as const,
    }));
    expect(ratchetErrors([...existing.filter((entry) => entry.path !== "src/config/io.ts"), ...injected]))
      .toContain("N6/JONSBO debt increased: src/config/io.ts:concrete-reference 2 > 1");
  });

  it("keeps the true case-specific exemption list narrow and reviewable", () => {
    expect(baseline.caseSpecificFiles).toEqual([
      "src/adapters/jonsbo-n6/assembly.ts",
      "src/adapters/jonsbo-n6/geometry.ts",
      "src/adapters/jonsbo-n6/occupancy.ts",
      "src/adapters/jonsbo-n6/routing.ts",
    ]);
    for (const path of baseline.caseSpecificFiles) {
      expect(path.startsWith("src/adapters/jonsbo-n6/")).toBe(true);
      expect(sourceExtensions.test(path)).toBe(true);
    }
  });
});

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("R10 app shell and legacy isolation", () => {
  it("keeps index.html as a minimal loader and the compatibility template inert", async () => {
    const [index, template, loader] = await Promise.all([
      readFile("index.html", "utf8"), readFile("src/lab/app-document.html", "utf8"), readFile("src/lab/shell-loader.ts", "utf8"),
    ]);
    expect(index.split("\n").length).toBeLessThan(25);
    expect(index).toContain("/src/lab/shell-loader.ts");
    expect(index).not.toContain("id=\"n6-lab\"");
    expect(template).toContain("id=\"n6-lab\"");
    expect(template).not.toContain("class=\"app-bar\"");
    expect(template).not.toContain("/src/lab/boot.ts");
    expect(loader).toContain("document.body.replaceChildren");
    expect(loader).toContain('await import("./boot")');
  });

  it("prevents the legacy runtime from owning migrated persistence or services", async () => {
    const runtime = await readFile("src/lab/v1-runtime.js", "utf8");
    expect(runtime).not.toContain("localStorage");
    expect(runtime).not.toMatch(/\bfetch\s*\(/);
    expect(runtime).not.toContain("build-sim.workspace");
    expect(runtime).not.toContain("/api/workspace");
    expect(runtime).toContain("window.__N6_LAB_API__");
  });
});

#!/usr/bin/env -S vite-node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validatePhysicalHoldoutReleaseSet } from "../../src/release/physical-holdout";

const directory = path.resolve(process.argv[2] ?? "data/holdouts");
let values: unknown[] = [];
try {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  values = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const report = await validatePhysicalHoldoutReleaseSet(values);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "pass") process.exitCode = 2;

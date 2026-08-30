#!/usr/bin/env -S vite-node

import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createUniversalJourneyEvidenceManifest,
  validateUniversalJourneyEvidenceManifest,
  type UniversalJourneyEvidenceManifest,
  type UniversalJourneyEvidenceMaterial,
} from "../../src/release/universal-journey";
import { atomicWriteFile } from "../../src/runtime/fs.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;

function parseArguments(argv: readonly string[]): { input: string; output?: string; replace: boolean } {
  let input: string | undefined;
  let output: string | undefined;
  let replace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replace") {
      if (replace) throw new TypeError("--replace may only be provided once");
      replace = true;
      continue;
    }
    if (argument !== "--input" && argument !== "--output") throw new TypeError(`unknown journey manifest argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a path`);
    if (argument === "--input") {
      if (input !== undefined) throw new TypeError("--input may only be provided once");
      input = value;
    } else {
      if (output !== undefined) throw new TypeError("--output may only be provided once");
      output = value;
    }
    index += 1;
  }
  if (!input) throw new TypeError("--input is required");
  if (replace && output === undefined) throw new TypeError("--replace requires --output");
  return { input: path.resolve(input), ...(output === undefined ? {} : { output: path.resolve(output) }), replace };
}

async function readMaterial(input: string): Promise<UniversalJourneyEvidenceMaterial> {
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_INPUT_BYTES) {
    throw new TypeError("journey evidence input must be a bounded regular file");
  }
  const value: unknown = JSON.parse(await readFile(input, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "contentHash")) {
    throw new TypeError("journey evidence input must be unhashed material");
  }
  return structuredClone(value) as UniversalJourneyEvidenceMaterial;
}

export async function runUniversalJourneyManifestCli(argv = process.argv.slice(2)): Promise<UniversalJourneyEvidenceManifest> {
  const options = parseArguments(argv);
  const manifest = await createUniversalJourneyEvidenceManifest(await readMaterial(options.input));
  const errors = await validateUniversalJourneyEvidenceManifest(manifest);
  if (errors.length) throw new TypeError(`journey evidence input is invalid: ${errors.join("; ")}`);
  if (options.output !== undefined) {
    if (options.output === options.input) throw new TypeError("journey evidence output must differ from its material input");
    const existing = await lstat(options.output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null && !options.replace) throw new TypeError("journey evidence output already exists; pass --replace after review");
    await mkdir(path.dirname(options.output), { recursive: true, mode: 0o700 });
    await atomicWriteFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }
  return manifest;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runUniversalJourneyManifestCli().then((manifest) => {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "journey evidence manifest generation failed"}\n`);
    process.exitCode = 1;
  });
}

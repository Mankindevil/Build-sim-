#!/usr/bin/env -S vite-node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  validateExternalReviewValidationDataset,
  validateExternalReviewValidationSet,
  type ExternalReviewValidationDataset,
} from "../../src/release/external-review-validation";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

async function readDataset(file: string): Promise<unknown> {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 1024 * 1024) {
    throw new TypeError(`external review dataset is not a bounded regular file: ${file}`);
  }
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function verifyArchive(directory: string, value: unknown): Promise<string[]> {
  const datasetErrors = await validateExternalReviewValidationDataset(value);
  if (datasetErrors.length) return datasetErrors;
  const dataset = value as ExternalReviewValidationDataset;
  const archiveRoot = path.join(directory, "archives");
  const archiveFile = path.resolve(directory, dataset.source.archiveFile);
  if (path.dirname(archiveFile) !== archiveRoot) return ["external review archive path escapes its archive directory"];
  let stats;
  try { stats = await lstat(archiveFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ["external review archive is missing"];
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_ARCHIVE_BYTES) {
    return ["external review archive is not a bounded regular file"];
  }
  const bytes = await readFile(archiveFile);
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  if (archiveSha256 !== dataset.source.archiveSha256) return ["external review archive hash mismatch"];
  const body = bytes.toString("utf8");
  const missingLocators = dataset.observations
    .filter(({ status }) => status !== "not_reported")
    .filter(({ locatorText }) => !body.includes(locatorText));
  return missingLocators.map(({ domain }) => `external review ${domain} locator is absent from its archived source`);
}

export async function validateExternalReviewDirectory(directoryValue: string): Promise<Awaited<ReturnType<typeof validateExternalReviewValidationSet>>> {
  const directory = path.resolve(directoryValue);
  let files: string[] = [];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".json") && file !== "report.json").sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const values = await Promise.all(files.map((file) => readDataset(path.join(directory, file))));
  const archiveErrors = (await Promise.all(values.map((value) => verifyArchive(directory, value)))).flat();
  const report = await validateExternalReviewValidationSet(values);
  if (archiveErrors.length === 0) return report;
  return {
    ...report,
    status: "blocked",
    errors: [...new Set([...report.errors, ...archiveErrors])].sort(),
  };
}

const directory = path.resolve(process.argv[2] ?? "data/external-reviews");
validateExternalReviewDirectory(directory).then((report) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "external review validation failed"}\n`);
  process.exitCode = 1;
});

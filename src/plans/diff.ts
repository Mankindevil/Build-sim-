import type { BuildConfig } from "../config/types";

export interface ConfigFieldDiff {
  path: string;
  before: unknown;
  after: unknown;
}

function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  const output = new Map<string, unknown>();
  if (Array.isArray(value)) {
    output.set(prefix || "/", value);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, `${prefix}/${key}`).forEach((entry, path) => output.set(path, entry));
    }
    return output;
  }
  output.set(prefix || "/", value);
  return output;
}

export function diffBuildConfigs(before: BuildConfig, after: BuildConfig): ConfigFieldDiff[] {
  const left = flatten(before);
  const right = flatten(after);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths
    .filter((path) => JSON.stringify(left.get(path)) !== JSON.stringify(right.get(path)))
    .map((path) => ({ path, before: left.get(path), after: right.get(path) }));
}

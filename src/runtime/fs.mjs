import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("value is not finite JSON");
  return encoded;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value).normalize("NFC"), "utf8"));
}

export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function confined(root, ...parts) {
  const target = path.resolve(root, ...parts);
  if (!isInside(root, target)) throw new Error("runtime path escapes its configured root");
  return target;
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export async function atomicWriteFile(target, bytes, options = {}) {
  const mode = options.mode ?? PRIVATE_FILE_MODE;
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, target);
    await chmod(target, mode);
    const directory = await open(path.dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(target, value, options = {}) {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Cross-process mutex based on atomic directory creation. */
export async function withDirectoryLock(lockDirectory, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const started = Date.now();
  await ensurePrivateDirectory(path.dirname(lockDirectory));
  while (true) {
    try {
      await mkdir(lockDirectory, { mode: PRIVATE_DIRECTORY_MODE });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // Never infer abandonment from mtime: a valid large snapshot/backup may
      // hold the barrier for minutes. Stale-lock removal is an explicit repair.
      if (Date.now() - started >= timeoutMs) throw new Error("runtime coordination lock timeout");
      await wait(10);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export async function listRegularFiles(root) {
  const files = [];
  if (!await pathExists(root)) return files;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = confined(root, path.relative(root, directory), entry.name);
      if (entry.isSymbolicLink()) {
        files.push({ absolutePath: target, logicalPath: path.relative(root, target).split(path.sep).join("/"), symlink: true });
      } else if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        files.push({ absolutePath: target, logicalPath: path.relative(root, target).split(path.sep).join("/"), symlink: false });
      }
    }
  }
  await visit(path.resolve(root));
  return files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

export async function privateMode(target) {
  return (await lstat(target)).mode & 0o777;
}

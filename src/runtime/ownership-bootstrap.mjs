import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, isInside, sha256Json } from "./fs.mjs";

export const OWNERSHIP_BOOTSTRAP_PLAN_SCHEMA = "runtime-ownership-bootstrap-plan-v1";
export const OWNERSHIP_BOOTSTRAP_ROLLBACK_SCHEMA = "runtime-ownership-bootstrap-rollback-v1";
export const OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION = "RESTORE_RUNTIME_READ_ACCESS";
export const OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION = "ROLLBACK_RUNTIME_READ_ACCESS";

const HASH = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const ACTIVE_ROOT = /^generations\/[1-9][0-9]*$/u;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, fields) {
  return Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function safeId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
    && !value.split("/").includes("..") && value === slash(path.normalize(value));
}

function decimal(value) {
  return typeof value === "string" && DECIMAL.test(value);
}

function metadata(info) {
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    mode: Number(info.mode & 0o7777n),
    uid: Number(info.uid),
    gid: Number(info.gid),
    nlink: info.nlink.toString(),
  };
}

function planMaterial(value) {
  const { contentHash: _contentHash, ...material } = value;
  return material;
}

function contentHash(domain, material) {
  return sha256Json({ domain, material });
}

function allowedTargetPaths(activeRoot) {
  return new Set([
    `${activeRoot}/plans/.locks`,
    "plans/.agent-context-audit",
    "transactions",
  ]);
}

function targetShape(value) {
  return record(value) && exact(value, [
    "relativePath", "device", "inode", "mode", "uid", "gid", "ownershipChangeRequired",
  ]);
}

export function validateOwnershipBootstrapPlan(value) {
  if (!record(value) || !exact(value, [
    "schemaVersion", "runtimeGeneration", "activeRoot", "pointerHash", "runtimeDevice", "runtimeInode",
    "targetUid", "targetGid", "targets", "createdAt", "contentHash",
  ])) return ["ownership bootstrap plan fields are invalid"];
  const errors = [];
  if (value.schemaVersion !== OWNERSHIP_BOOTSTRAP_PLAN_SCHEMA || !Number.isSafeInteger(value.runtimeGeneration)
    || value.runtimeGeneration < 1 || typeof value.activeRoot !== "string" || !ACTIVE_ROOT.test(value.activeRoot)
    || typeof value.pointerHash !== "string" || !HASH.test(value.pointerHash)
    || !decimal(value.runtimeDevice) || !decimal(value.runtimeInode) || !safeId(value.targetUid) || !safeId(value.targetGid)
    || !iso(value.createdAt) || typeof value.contentHash !== "string" || !HASH.test(value.contentHash)) {
    errors.push("ownership bootstrap plan identity is invalid");
  }
  const targets = Array.isArray(value.targets) ? value.targets : [];
  if (!Array.isArray(value.targets)) errors.push("ownership bootstrap plan targets are invalid");
  const allowed = typeof value.activeRoot === "string" ? allowedTargetPaths(value.activeRoot) : new Set();
  const paths = [];
  for (const target of targets) {
    if (!targetShape(target) || !safeRelative(target.relativePath) || !allowed.has(target.relativePath)
      || !decimal(target.device) || !decimal(target.inode) || !Number.isInteger(target.mode) || target.mode < 0 || target.mode > 0o7777
      || !Number.isSafeInteger(target.uid) || target.uid < 0 || !Number.isSafeInteger(target.gid) || target.gid < 0
      || typeof target.ownershipChangeRequired !== "boolean") {
      errors.push("ownership bootstrap target is invalid");
      continue;
    }
    if (target.device !== value.runtimeDevice) errors.push("ownership bootstrap target crosses the runtime device boundary");
    if (target.ownershipChangeRequired !== (target.uid !== value.targetUid || target.gid !== value.targetGid)) {
      errors.push("ownership bootstrap target change status is invalid");
    }
    paths.push(target.relativePath);
  }
  if (new Set(paths).size !== paths.length || paths.join("\0") !== [...paths].sort().join("\0")) {
    errors.push("ownership bootstrap target paths must be unique and sorted");
  }
  if (typeof value.contentHash === "string" && HASH.test(value.contentHash)
    && contentHash("runtime-ownership-bootstrap-plan", planMaterial(value)) !== value.contentHash) {
    errors.push("ownership bootstrap plan contentHash mismatch");
  }
  return [...new Set(errors)].sort();
}

function rollbackEntryShape(value) {
  return record(value) && exact(value, [
    "relativePath", "kind", "device", "inode", "mode", "uid", "gid", "nlink",
  ]);
}

function pathUnderTargets(relativePath, targets) {
  return targets.some((target) => relativePath === target || relativePath.startsWith(`${target}/`));
}

export function validateOwnershipBootstrapRollback(value) {
  if (!record(value) || !exact(value, [
    "schemaVersion", "planHash", "runtimeGeneration", "activeRoot", "pointerHash", "runtimeDevice", "runtimeInode",
    "targetUid", "targetGid", "targetPaths", "entries", "createdAt", "contentHash",
  ])) return ["ownership bootstrap rollback fields are invalid"];
  const errors = [];
  if (value.schemaVersion !== OWNERSHIP_BOOTSTRAP_ROLLBACK_SCHEMA || typeof value.planHash !== "string" || !HASH.test(value.planHash)
    || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1
    || typeof value.activeRoot !== "string" || !ACTIVE_ROOT.test(value.activeRoot)
    || typeof value.pointerHash !== "string" || !HASH.test(value.pointerHash)
    || !decimal(value.runtimeDevice) || !decimal(value.runtimeInode) || !safeId(value.targetUid) || !safeId(value.targetGid)
    || !iso(value.createdAt) || typeof value.contentHash !== "string" || !HASH.test(value.contentHash)) {
    errors.push("ownership bootstrap rollback identity is invalid");
  }
  const allowed = typeof value.activeRoot === "string" ? allowedTargetPaths(value.activeRoot) : new Set();
  const targetPaths = Array.isArray(value.targetPaths) ? value.targetPaths : [];
  if (!Array.isArray(value.targetPaths) || targetPaths.length === 0 || targetPaths.some((entry) => !safeRelative(entry) || !allowed.has(entry))
    || new Set(targetPaths).size !== targetPaths.length || targetPaths.join("\0") !== [...targetPaths].sort().join("\0")) {
    errors.push("ownership bootstrap rollback targets are invalid");
  }
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const paths = [];
  if (!Array.isArray(value.entries) || entries.length < targetPaths.length) errors.push("ownership bootstrap rollback entries are invalid");
  for (const entry of entries) {
    if (!rollbackEntryShape(entry) || !safeRelative(entry.relativePath) || !pathUnderTargets(entry.relativePath, targetPaths)
      || !["file", "directory"].includes(entry.kind) || !decimal(entry.device) || !decimal(entry.inode) || !decimal(entry.nlink)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
      || !Number.isSafeInteger(entry.uid) || entry.uid < 0 || !Number.isSafeInteger(entry.gid) || entry.gid < 0) {
      errors.push("ownership bootstrap rollback entry is invalid");
      continue;
    }
    if (entry.device !== value.runtimeDevice || (entry.kind === "file" && entry.nlink !== "1")) {
      errors.push("ownership bootstrap rollback entry crosses a filesystem identity boundary");
    }
    paths.push(entry.relativePath);
  }
  if (new Set(paths).size !== paths.length || paths.join("\0") !== [...paths].sort().join("\0")
    || targetPaths.some((target) => !paths.includes(target))) {
    errors.push("ownership bootstrap rollback entry paths must be complete, unique and sorted");
  }
  if (typeof value.contentHash === "string" && HASH.test(value.contentHash)
    && contentHash("runtime-ownership-bootstrap-rollback", planMaterial(value)) !== value.contentHash) {
    errors.push("ownership bootstrap rollback contentHash mismatch");
  }
  return [...new Set(errors)].sort();
}

async function runtimeBinding(runtimeRootValue) {
  const runtimeRoot = await realpath(path.resolve(runtimeRootValue));
  const rootInfo = await lstat(runtimeRoot, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("runtime root must resolve to one directory");
  const pointerFile = path.join(runtimeRoot, "control", "active-pointer.json");
  const pointerInfo = await lstat(pointerFile, { bigint: true });
  if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink() || pointerInfo.size <= 0n || pointerInfo.size > 1024n * 1024n) {
    throw new Error("runtime active pointer must be a bounded regular file");
  }
  const pointerBytes = await readFile(pointerFile);
  let pointer;
  try { pointer = JSON.parse(pointerBytes.toString("utf8")); } catch { throw new Error("runtime active pointer is invalid JSON"); }
  if (!record(pointer) || pointer.schemaVersion !== "runtime-state-v1" || !Number.isSafeInteger(pointer.runtimeGeneration)
    || pointer.runtimeGeneration < 1 || typeof pointer.activeRoot !== "string" || !ACTIVE_ROOT.test(pointer.activeRoot)) {
    throw new Error("runtime active pointer is invalid");
  }
  const activeRootPath = path.resolve(runtimeRoot, pointer.activeRoot);
  if (!isInside(runtimeRoot, activeRootPath) || await realpath(activeRootPath) !== activeRootPath) {
    throw new Error("runtime active generation is not one confined real directory");
  }
  return {
    runtimeRoot,
    runtimeDevice: rootInfo.dev.toString(),
    runtimeInode: rootInfo.ino.toString(),
    pointerHash: sha256Json(JSON.parse(pointerBytes.toString("utf8"))),
    runtimeGeneration: pointer.runtimeGeneration,
    activeRoot: pointer.activeRoot,
  };
}

async function targetMetadata(runtimeRoot, relativePath) {
  const absolute = path.resolve(runtimeRoot, relativePath);
  if (!isInside(runtimeRoot, absolute)) throw new Error("ownership bootstrap target escaped runtime root");
  let info;
  try { info = await lstat(absolute, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("ownership bootstrap target must be one real directory");
  return { absolute, info, ...metadata(info) };
}

export async function createOwnershipBootstrapPlan(options) {
  if (!options || !safeId(options.targetUid) || !safeId(options.targetGid)) {
    throw new TypeError("ownership bootstrap target uid and gid must be non-root integer identities");
  }
  const binding = await runtimeBinding(options.runtimeRoot);
  const targets = [];
  for (const relativePath of [...allowedTargetPaths(binding.activeRoot)].sort()) {
    const current = await targetMetadata(binding.runtimeRoot, relativePath);
    if (!current) continue;
    if (current.device !== binding.runtimeDevice) throw new Error("ownership bootstrap target crosses the runtime device boundary");
    targets.push({
      relativePath,
      device: current.device,
      inode: current.inode,
      mode: current.mode,
      uid: current.uid,
      gid: current.gid,
      ownershipChangeRequired: current.uid !== options.targetUid || current.gid !== options.targetGid,
    });
  }
  const material = {
    schemaVersion: OWNERSHIP_BOOTSTRAP_PLAN_SCHEMA,
    runtimeGeneration: binding.runtimeGeneration,
    activeRoot: binding.activeRoot,
    pointerHash: binding.pointerHash,
    runtimeDevice: binding.runtimeDevice,
    runtimeInode: binding.runtimeInode,
    targetUid: options.targetUid,
    targetGid: options.targetGid,
    targets,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  const plan = { ...material, contentHash: contentHash("runtime-ownership-bootstrap-plan", material) };
  const errors = validateOwnershipBootstrapPlan(plan);
  if (errors.length) throw new Error(errors.join("; "));
  return Object.freeze(structuredClone(plan));
}

async function assertRuntimeBinding(runtimeRootValue, authority) {
  const binding = await runtimeBinding(runtimeRootValue);
  for (const field of ["runtimeGeneration", "activeRoot", "pointerHash", "runtimeDevice", "runtimeInode"]) {
    if (binding[field] !== authority[field]) throw new Error(`runtime ownership bootstrap ${field} precondition changed`);
  }
  return binding;
}

async function assertPlanTargets(binding, plan) {
  for (const target of plan.targets) {
    const current = await targetMetadata(binding.runtimeRoot, target.relativePath);
    if (!current || current.device !== target.device || current.inode !== target.inode || current.mode !== target.mode
      || current.uid !== target.uid || current.gid !== target.gid) {
      throw new Error("runtime ownership bootstrap target precondition changed");
    }
  }
}

async function walkTarget(binding, target) {
  const entries = [];
  const pending = [target.relativePath];
  while (pending.length > 0) {
    const relativePath = pending.pop();
    const absolute = path.resolve(binding.runtimeRoot, relativePath);
    if (!isInside(binding.runtimeRoot, absolute)) throw new Error("runtime ownership bootstrap entry escaped runtime root");
    const info = await lstat(absolute, { bigint: true });
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error("runtime ownership bootstrap refuses symlinks and special files");
    }
    if (info.dev.toString() !== binding.runtimeDevice) throw new Error("runtime ownership bootstrap refuses cross-device entries");
    if (info.isFile() && info.nlink !== 1n) throw new Error("runtime ownership bootstrap refuses hard-linked files");
    const current = metadata(info);
    entries.push({ relativePath, kind: info.isDirectory() ? "directory" : "file", ...current });
    if (info.isDirectory()) {
      const children = await readdir(absolute, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name)).reverse()) {
        if (child.name === "." || child.name === ".." || child.name.includes(path.sep)) throw new Error("runtime ownership bootstrap entry name is invalid");
        pending.push(slash(path.join(relativePath, child.name)));
      }
    }
  }
  return entries;
}

async function collectRollbackEntries(binding, plan) {
  const groups = await Promise.all(plan.targets.map((target) => walkTarget(binding, target)));
  const entries = groups.flat().sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(entries.map(({ relativePath }) => relativePath)).size !== entries.length) {
    throw new Error("runtime ownership bootstrap targets overlap");
  }
  return entries;
}

async function assertCompleteEntrySet(binding, targetPaths, expectedEntries, ownerFor) {
  const currentEntries = await collectRollbackEntries(binding, {
    targets: targetPaths.map((relativePath) => ({ relativePath })),
  });
  if (currentEntries.length !== expectedEntries.length) throw new Error("runtime ownership bootstrap entry set changed");
  for (let index = 0; index < expectedEntries.length; index += 1) {
    const expected = expectedEntries[index];
    const current = currentEntries[index];
    const owner = ownerFor(expected);
    if (!expected || !current || current.relativePath !== expected.relativePath || current.kind !== expected.kind
      || current.device !== expected.device || current.inode !== expected.inode || current.mode !== expected.mode
      || current.nlink !== expected.nlink || current.uid !== owner.uid || current.gid !== owner.gid) {
      throw new Error("runtime ownership bootstrap entry set changed");
    }
  }
}

async function ensurePrivateOutputParent(outputFile) {
  const parent = path.dirname(outputFile);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error("ownership bootstrap artifact parent must not traverse symbolic links");
  const info = await lstat(parent, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink() || Number(info.mode & 0o077n) !== 0
    || (currentUid !== null && Number(info.uid) !== currentUid)) {
    throw new Error("ownership bootstrap artifact parent must be a private directory owned by the current operator");
  }
}

export async function writeOwnershipBootstrapArtifact(outputFileValue, value, runtimeRootValue) {
  const outputFile = path.resolve(outputFileValue);
  const runtimeRoot = await realpath(path.resolve(runtimeRootValue));
  if (isInside(runtimeRoot, outputFile)) throw new Error("ownership bootstrap artifacts must be stored outside the runtime root");
  await ensurePrivateOutputParent(outputFile);
  try { await lstat(outputFile); throw new Error("ownership bootstrap artifact already exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = `${outputFile}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await link(temporary, outputFile);
    await unlink(temporary);
    const directory = await open(path.dirname(outputFile), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readBoundedArtifact(fileValue) {
  const file = path.resolve(fileValue);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new Error("ownership bootstrap artifact must be a bounded regular file");
    }
    if (Number(before.mode & 0o077n) !== 0) throw new Error("ownership bootstrap artifact must use private permissions");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("ownership bootstrap artifact changed while being read");
    }
    return { value: JSON.parse(bytes.toString("utf8")), ownerUid: Number(before.uid) };
  } finally { await handle.close(); }
}

export async function readOwnershipBootstrapPlan(file) {
  const { value, ownerUid } = await readBoundedArtifact(file);
  const errors = validateOwnershipBootstrapPlan(value);
  if (errors.length) throw new Error(errors.join("; "));
  if (ownerUid !== 0 && ownerUid !== value.targetUid) throw new Error("ownership bootstrap plan owner is not the administrator or target runtime user");
  return value;
}

export async function readOwnershipBootstrapRollback(file) {
  const { value, ownerUid } = await readBoundedArtifact(file);
  const errors = validateOwnershipBootstrapRollback(value);
  if (errors.length) throw new Error(errors.join("; "));
  const currentUid = typeof process.getuid === "function" ? process.getuid() : ownerUid;
  if (ownerUid !== 0 && ownerUid !== currentUid) throw new Error("ownership bootstrap rollback owner is not the current administrator");
  return value;
}

function assertRollbackPlanBinding(plan, rollback) {
  const planErrors = validateOwnershipBootstrapPlan(plan);
  if (planErrors.length) throw new Error(planErrors.join("; "));
  if (rollback.planHash !== plan.contentHash || rollback.runtimeGeneration !== plan.runtimeGeneration
    || rollback.activeRoot !== plan.activeRoot || rollback.pointerHash !== plan.pointerHash
    || rollback.runtimeDevice !== plan.runtimeDevice || rollback.runtimeInode !== plan.runtimeInode
    || rollback.targetUid !== plan.targetUid || rollback.targetGid !== plan.targetGid
    || rollback.targetPaths.join("\0") !== plan.targets.map(({ relativePath }) => relativePath).join("\0")) {
    throw new Error("ownership bootstrap rollback does not match its reviewed plan");
  }
  const entries = new Map(rollback.entries.map((entry) => [entry.relativePath, entry]));
  for (const target of plan.targets) {
    const entry = entries.get(target.relativePath);
    if (!entry || entry.kind !== "directory" || entry.device !== target.device || entry.inode !== target.inode
      || entry.mode !== target.mode || entry.uid !== target.uid || entry.gid !== target.gid) {
      throw new Error("ownership bootstrap rollback root metadata does not match its reviewed plan");
    }
  }
}

function depth(relativePath) {
  return relativePath.split("/").length;
}

async function assertEntryMetadata(binding, entry, expectedUid, expectedGid) {
  const absolute = path.resolve(binding.runtimeRoot, entry.relativePath);
  if (!isInside(binding.runtimeRoot, absolute)) throw new Error("runtime ownership bootstrap entry escaped runtime root");
  const info = await lstat(absolute, { bigint: true });
  const current = metadata(info);
  if ((entry.kind === "directory") !== info.isDirectory() || (entry.kind === "file") !== info.isFile() || info.isSymbolicLink()
    || current.device !== entry.device || current.inode !== entry.inode || current.mode !== entry.mode
    || current.nlink !== entry.nlink || current.uid !== expectedUid || current.gid !== expectedGid) {
    throw new Error("runtime ownership bootstrap entry precondition changed");
  }
  return absolute;
}

function sameEntryStat(info, entry, expectedUid, expectedGid) {
  const current = metadata(info);
  return (entry.kind === "directory") === info.isDirectory() && (entry.kind === "file") === info.isFile()
    && !info.isSymbolicLink() && current.device === entry.device && current.inode === entry.inode
    && current.mode === entry.mode && current.nlink === entry.nlink && current.uid === expectedUid && current.gid === expectedGid;
}

async function changeEntryOwnership(binding, entry, expectedUid, expectedGid, nextUid, nextGid, writer) {
  const absolute = await assertEntryMetadata(binding, entry, expectedUid, expectedGid);
  if (writer) {
    await writer(absolute, nextUid, nextGid);
    return absolute;
  }
  const directoryFlag = entry.kind === "directory" ? constants.O_DIRECTORY : 0;
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | directoryFlag);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameEntryStat(before, entry, expectedUid, expectedGid)) throw new Error("runtime ownership bootstrap entry changed before descriptor-bound write");
    await handle.chown(nextUid, nextGid);
    const after = await handle.stat({ bigint: true });
    if (!sameEntryStat(after, entry, nextUid, nextGid)) throw new Error("runtime ownership bootstrap descriptor-bound write did not produce the expected owner");
  } finally { await handle.close(); }
  return absolute;
}

function assertPrivileged(options) {
  if (options.requirePrivileged === false) return;
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("runtime ownership bootstrap apply/rollback requires an administrator process");
  }
}

export async function applyOwnershipBootstrapPlan(options) {
  assertPrivileged(options);
  if (options.confirmation !== OWNERSHIP_BOOTSTRAP_APPLY_CONFIRMATION) throw new TypeError("ownership bootstrap apply confirmation is invalid");
  const plan = options.plan;
  const errors = validateOwnershipBootstrapPlan(plan);
  if (errors.length) throw new Error(errors.join("; "));
  if (options.expectedPlanHash !== plan.contentHash) throw new Error("ownership bootstrap apply expected plan hash mismatch");
  if (plan.targets.length === 0) throw new Error("ownership bootstrap plan has no legacy targets");
  const binding = await assertRuntimeBinding(options.runtimeRoot, plan);
  await assertPlanTargets(binding, plan);
  const entries = await collectRollbackEntries(binding, plan);
  const material = {
    schemaVersion: OWNERSHIP_BOOTSTRAP_ROLLBACK_SCHEMA,
    planHash: plan.contentHash,
    runtimeGeneration: plan.runtimeGeneration,
    activeRoot: plan.activeRoot,
    pointerHash: plan.pointerHash,
    runtimeDevice: plan.runtimeDevice,
    runtimeInode: plan.runtimeInode,
    targetUid: plan.targetUid,
    targetGid: plan.targetGid,
    targetPaths: plan.targets.map(({ relativePath }) => relativePath),
    entries,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  const rollback = { ...material, contentHash: contentHash("runtime-ownership-bootstrap-rollback", material) };
  const rollbackErrors = validateOwnershipBootstrapRollback(rollback);
  if (rollbackErrors.length) throw new Error(rollbackErrors.join("; "));
  await writeOwnershipBootstrapArtifact(options.rollbackOutput, rollback, binding.runtimeRoot);
  const writer = options.ownershipWriter;
  const ordered = [...entries].sort((left, right) => depth(right.relativePath) - depth(left.relativePath)
    || right.relativePath.localeCompare(left.relativePath));
  const changed = [];
  try {
    for (const entry of ordered) {
      if (!writer && entry.uid === plan.targetUid && entry.gid === plan.targetGid) continue;
      const absolute = await changeEntryOwnership(binding, entry, entry.uid, entry.gid, plan.targetUid, plan.targetGid, writer);
      changed.push({ absolute, entry });
    }
    await assertCompleteEntrySet(binding, rollback.targetPaths, entries, () => ({ uid: plan.targetUid, gid: plan.targetGid }));
  } catch (error) {
    const rollbackErrorsCaught = [];
    for (const { entry } of [...changed].reverse()) {
      try { await changeEntryOwnership(binding, entry, plan.targetUid, plan.targetGid, entry.uid, entry.gid, writer); }
      catch (rollbackError) { rollbackErrorsCaught.push(rollbackError); }
    }
    try {
      await assertCompleteEntrySet(binding, rollback.targetPaths, entries, (entry) => ({ uid: entry.uid, gid: entry.gid }));
    } catch (rollbackError) { rollbackErrorsCaught.push(rollbackError); }
    if (rollbackErrorsCaught.length) throw new Error("ownership bootstrap apply failed and metadata rollback was incomplete", { cause: error });
    throw error;
  }
  return Object.freeze({
    schemaVersion: "runtime-ownership-bootstrap-result-v1",
    planHash: plan.contentHash,
    rollbackHash: rollback.contentHash,
    runtimeGeneration: plan.runtimeGeneration,
    entryCount: entries.length,
    changedEntryCount: entries.filter(({ uid, gid }) => uid !== plan.targetUid || gid !== plan.targetGid).length,
  });
}

export async function rollbackOwnershipBootstrap(options) {
  assertPrivileged(options);
  if (options.confirmation !== OWNERSHIP_BOOTSTRAP_ROLLBACK_CONFIRMATION) throw new TypeError("ownership bootstrap rollback confirmation is invalid");
  const rollback = options.rollback;
  const errors = validateOwnershipBootstrapRollback(rollback);
  if (errors.length) throw new Error(errors.join("; "));
  assertRollbackPlanBinding(options.plan, rollback);
  if (options.expectedPlanHash !== options.plan.contentHash) throw new Error("ownership bootstrap rollback expected plan hash mismatch");
  if (options.expectedRollbackHash !== rollback.contentHash) throw new Error("ownership bootstrap rollback expected manifest hash mismatch");
  const binding = await assertRuntimeBinding(options.runtimeRoot, rollback);
  const writer = options.ownershipWriter;
  const ordered = [...rollback.entries].sort((left, right) => depth(right.relativePath) - depth(left.relativePath)
    || right.relativePath.localeCompare(left.relativePath));
  const restored = [];
  try {
    for (const entry of ordered) {
      if (!writer && entry.uid === rollback.targetUid && entry.gid === rollback.targetGid) continue;
      const absolute = await changeEntryOwnership(binding, entry, rollback.targetUid, rollback.targetGid, entry.uid, entry.gid, writer);
      restored.push({ absolute, entry });
    }
    await assertCompleteEntrySet(binding, rollback.targetPaths, rollback.entries, (entry) => ({ uid: entry.uid, gid: entry.gid }));
  } catch (error) {
    const compensationErrors = [];
    for (const { entry } of [...restored].reverse()) {
      try { await changeEntryOwnership(binding, entry, entry.uid, entry.gid, rollback.targetUid, rollback.targetGid, writer); }
      catch (compensationError) { compensationErrors.push(compensationError); }
    }
    try {
      await assertCompleteEntrySet(binding, rollback.targetPaths, rollback.entries, () => ({ uid: rollback.targetUid, gid: rollback.targetGid }));
    } catch (compensationError) { compensationErrors.push(compensationError); }
    if (compensationErrors.length) throw new Error("ownership bootstrap rollback failed and apply-state restoration was incomplete", { cause: error });
    throw error;
  }
  return Object.freeze({
    schemaVersion: "runtime-ownership-bootstrap-rollback-result-v1",
    planHash: rollback.planHash,
    rollbackHash: rollback.contentHash,
    runtimeGeneration: rollback.runtimeGeneration,
    restoredEntryCount: rollback.entries.length,
  });
}

export function canonicalOwnershipBootstrapArtifact(value) {
  return canonicalJson(value);
}

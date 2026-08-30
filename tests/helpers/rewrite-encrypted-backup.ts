import { createCipheriv, scrypt as scryptCallback } from "node:crypto";
import { openBackup } from "../../src/backup/runtime.mjs";
import { openPortablePlanPackage } from "../../src/portability/runtime";
import {
  atomicWriteFile,
  canonicalJson,
  sha256Bytes,
} from "../../src/runtime/fs.mjs";

interface BackupJsonFile {
  logicalPath: string;
  dataBase64: string;
}

/** Test-only authenticated portable-package mutation helper. */
export async function rewriteEncryptedPortablePackage(options: {
  inputFile: string;
  outputFile: string;
  password: string;
  mutate(payload: Record<string, unknown>): void;
}): Promise<void> {
  const opened = await openPortablePlanPackage(options.inputFile, options.password);
  const payload = structuredClone(opened.payload) as unknown as Record<string, unknown>;
  options.mutate(payload);
  const manifest = payload.manifest as Record<string, unknown>;
  const { manifestHash: _prior, ...manifestMaterial } = manifest;
  manifest.manifestHash = sha256Bytes(Buffer.from(
    `buildsim\0hash-spec-v1\0backup-manifest\0backup-v1\0${canonicalJson(manifestMaterial).normalize("NFC")}`,
    "utf8",
  ));
  const encryption = opened.envelope.encryption;
  if (encryption.mode !== "authenticated") throw new Error("portable rewrite requires authenticated encryption");
  const { authTagBase64: _oldTag, aadSha256: _oldAadHash, ...publicParameters } = encryption;
  const aad = Buffer.from(canonicalJson({
    formatVersion: opened.envelope.formatVersion,
    manifestHash: manifest.manifestHash,
    encryption: publicParameters,
  }).normalize("NFC"), "utf8");
  const salt = Buffer.from(encryption.kdfParams.saltBase64, "base64");
  const nonce = Buffer.from(encryption.nonceBase64, "base64");
  const key = await new Promise<Buffer>((resolve, reject) => scryptCallback(options.password, salt, 32, {
    N: encryption.kdfParams.n,
    r: encryption.kdfParams.r,
    p: encryption.kdfParams.p,
    maxmem: 64 * 1024 * 1024,
  }, (error, derived) => error ? reject(error) : resolve(Buffer.from(derived))));
  let ciphertext: Buffer; let authTag: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalJson(payload).normalize("NFC"), "utf8")), cipher.final()]);
    authTag = cipher.getAuthTag();
  } finally { key.fill(0); }
  const envelope = {
    ...opened.envelope,
    manifestHash: manifest.manifestHash,
    payloadSha256: sha256Bytes(ciphertext),
    encryption: { ...publicParameters, authTagBase64: authTag.toString("base64"), aadSha256: sha256Bytes(aad) },
  };
  await atomicWriteFile(options.outputFile, `${JSON.stringify({
    schemaVersion: "buildsim-plan-portable-package-v1",
    envelope,
    ciphertextBase64: ciphertext.toString("base64"),
  })}\n`, { mode: 0o600 });
}

interface BackupManifestEntry {
  logicalPath: string;
  kind: string;
  byteLength: number;
  sha256: string;
  privacyClass: string;
}

/**
 * Test-only authenticated package rewriter. It appends an exact JSON authority,
 * updates every transport/content checksum, and therefore leaves only the
 * production semantic validator—not encryption or an outer checksum—to reject
 * the forged payload.
 */
export async function appendJsonAuthorityToEncryptedBackup(options: {
  inputFile: string;
  outputFile: string;
  password: string;
  logicalPath: string;
  value: unknown;
  templateLogicalPath: string;
}): Promise<void> {
  const opened = await openBackup(options.inputFile, options.password);
  const inner = structuredClone(opened.inner) as {
    manifest: { entries: BackupManifestEntry[]; manifestHash: string } & Record<string, unknown>;
    files: BackupJsonFile[];
  } & Record<string, unknown>;
  if (inner.files.some((file) => file.logicalPath === options.logicalPath)
    || inner.manifest.entries.some((entry) => entry.logicalPath === options.logicalPath)) {
    throw new Error(`backup append fixture path already exists: ${options.logicalPath}`);
  }
  const template = inner.manifest.entries.find((entry) => entry.logicalPath === options.templateLogicalPath);
  if (!template) throw new Error(`backup append fixture template is missing: ${options.templateLogicalPath}`);
  const bytes = Buffer.from(`${JSON.stringify(options.value, null, 2)}\n`, "utf8");
  inner.files.push({ logicalPath: options.logicalPath, dataBase64: bytes.toString("base64") });
  inner.manifest.entries.push({
    ...template,
    logicalPath: options.logicalPath,
    byteLength: bytes.length,
    sha256: sha256Bytes(bytes),
  });
  inner.files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  inner.manifest.entries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const { manifestHash: _oldManifestHash, ...manifestMaterial } = inner.manifest;
  inner.manifest.manifestHash = sha256Bytes(Buffer.from(
    `buildsim\0hash-spec-v1\0backup-manifest\0backup-v1\0${canonicalJson(manifestMaterial).normalize("NFC")}`,
    "utf8",
  ));

  const encryption = opened.envelope.encryption;
  const { authTagBase64: _oldTag, aadSha256: _oldAadHash, ...publicParameters } = encryption;
  const aad = Buffer.from(canonicalJson({
    formatVersion: "buildsim-backup-envelope-v1",
    manifestHash: inner.manifest.manifestHash,
    encryption: publicParameters,
  }).normalize("NFC"), "utf8");
  const salt = Buffer.from(encryption.kdfParams.saltBase64, "base64");
  const nonce = Buffer.from(encryption.nonceBase64, "base64");
  const key = await new Promise<Buffer>((resolve, reject) => scryptCallback(options.password, salt, 32, {
    N: encryption.kdfParams.n,
    r: encryption.kdfParams.r,
    p: encryption.kdfParams.p,
    maxmem: 64 * 1024 * 1024,
  }, (error, derived) => error ? reject(error) : resolve(Buffer.from(derived))));
  let ciphertext: Buffer;
  let authTag: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(inner).normalize("NFC"), "utf8")),
      cipher.final(),
    ]);
    authTag = cipher.getAuthTag();
  } finally {
    key.fill(0);
  }
  const nextEnvelope = {
    ...opened.envelope,
    manifestHash: inner.manifest.manifestHash,
    payloadSha256: sha256Bytes(ciphertext),
    encryption: {
      ...publicParameters,
      authTagBase64: authTag.toString("base64"),
      aadSha256: sha256Bytes(aad),
    },
  };
  await atomicWriteFile(options.outputFile, `${JSON.stringify({
    schemaVersion: "buildsim-backup-package-v1",
    envelope: nextEnvelope,
    ciphertextBase64: ciphertext.toString("base64"),
  })}\n`, { mode: 0o600 });
}

import { createCipheriv, createDecipheriv, scrypt as scryptCallback } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPortablePlanPackage, openPortablePlanPackage } from "../src/portability";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, canonicalJson, confined, sha256Bytes, sha256Json } from "../src/runtime/fs.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";

const roots: string[] = [];
const password = "malicious portable password";
const MANIFEST_PREFIX = "buildsim\0hash-spec-v1\0backup-manifest\0backup-v1\0";

async function key(secret: string, salt: Buffer, params: { n: number; r: number; p: number }): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => scryptCallback(secret, salt, 32, { N: params.n, r: params.r, p: params.p, maxmem: 128 * params.n * params.r + 16 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
}

async function authenticatedRewrite(source: string, target: string, mutate: (payload: Record<string, unknown>) => void): Promise<void> {
  const packageValue = JSON.parse(await readFile(source, "utf8")); const encryption = packageValue.envelope.encryption;
  const salt = Buffer.from(encryption.kdfParams.saltBase64, "base64"); const nonce = Buffer.from(encryption.nonceBase64, "base64");
  const derived = await key(password, salt, encryption.kdfParams);
  const publicParameters = { ...encryption }; delete publicParameters.authTagBase64; delete publicParameters.aadSha256;
  const oldAad = Buffer.from(canonicalJson({ formatVersion: packageValue.envelope.formatVersion, manifestHash: packageValue.envelope.manifestHash, encryption: publicParameters }), "utf8");
  const decipher = createDecipheriv("aes-256-gcm", derived, nonce); decipher.setAAD(oldAad); decipher.setAuthTag(Buffer.from(encryption.authTagBase64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(packageValue.ciphertextBase64, "base64")), decipher.final()]);
  const payload = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>; mutate(payload);
  const manifest = payload.manifest as Record<string, unknown>;
  const { manifestHash: _old, ...base } = manifest; manifest.manifestHash = sha256Bytes(Buffer.from(`${MANIFEST_PREFIX}${canonicalJson(base).normalize("NFC")}`, "utf8"));
  packageValue.envelope.manifestHash = manifest.manifestHash;
  const aad = Buffer.from(canonicalJson({ formatVersion: packageValue.envelope.formatVersion, manifestHash: manifest.manifestHash, encryption: publicParameters }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", derived, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalJson(payload).normalize("NFC"), "utf8")), cipher.final()]);
  packageValue.ciphertextBase64 = ciphertext.toString("base64"); packageValue.envelope.payloadSha256 = sha256Bytes(ciphertext);
  packageValue.envelope.encryption.authTagBase64 = cipher.getAuthTag().toString("base64"); packageValue.envelope.encryption.aadSha256 = sha256Bytes(aad);
  derived.fill(0); await writeFile(target, JSON.stringify(packageValue), { mode: 0o600 });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 portable path and schema rejection", () => {
  it("rejects authenticated absolute, parent, duplicate and symlink entries plus unknown payload schemas", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-portable-paths-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => "2026-08-30T00:00:00.000Z" }); const state = await coordinator.initialize("test");
    const planId = "plan-paths"; const config = createEmptyBuildConfigV3(planId, "Paths", "2026-08-30T00:00:00.000Z");
    const plan = { schemaVersion: "1.0.0", id: planId, name: "Paths", status: "active", createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", activeVersionId: null, draftRevision: 0, draft: { schemaVersion: "1.0.0", baseVersionId: null, config, evidenceBindings: [], dirty: true, updatedAt: "2026-08-30T00:00:00.000Z" }, metadata: {} };
    await atomicWriteJson(confined(coordinator.activeRoot(state), "plans", planId, "plan.json"), { schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan });
    const source = path.join(root, "source.buildsim"); await createPortablePlanPackage({ coordinator, outputFile: source, password, planId, portableProfile: "slim" });
    const cases: Array<[string, (payload: Record<string, unknown>) => void]> = [
      ["parent", (payload) => { const files = payload.files as Array<Record<string, unknown>>; const manifest = payload.manifest as { entries: Array<Record<string, unknown>> }; files[0]!.logicalPath = "../escape.json"; manifest.entries[0]!.logicalPath = "../escape.json"; }],
      ["absolute", (payload) => { const files = payload.files as Array<Record<string, unknown>>; const manifest = payload.manifest as { entries: Array<Record<string, unknown>> }; files[0]!.logicalPath = "/tmp/escape.json"; manifest.entries[0]!.logicalPath = "/tmp/escape.json"; }],
      ["duplicate", (payload) => { const files = payload.files as Array<Record<string, unknown>>; const manifest = payload.manifest as { entries: Array<Record<string, unknown>> }; files.push({ ...files[0]! }); manifest.entries.push({ ...manifest.entries[0]! }); }],
      ["symlink", (payload) => { const manifest = payload.manifest as { entries: Array<Record<string, unknown>> }; manifest.entries[0]!.kind = "symlink"; }],
      ["schema", (payload) => { payload.schemaVersion = "future-portable-payload-v99"; }],
    ];
    for (const [name, mutate] of cases) {
      const target = path.join(root, `${name}.buildsim`); await authenticatedRewrite(source, target, mutate);
      await expect(openPortablePlanPackage(target, password), name).rejects.toThrow(/portable/i);
    }
  });
});

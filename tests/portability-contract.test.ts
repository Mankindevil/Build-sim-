import { describe, expect, it } from "vitest";
import {
  validateBackupEnvelope,
  validateBackupManifest,
  validateBackupVerification,
  validateImportPlan,
  verifyBackupForPointerSwitch,
  verifyBackupForPointerSwitchAuthoritatively,
  verifyBackupManifestHash,
  type BackupEnvelope,
  type BackupManifest,
  type BackupVerificationReport,
  type TemporaryRestoreArtifact,
  type TemporaryRestoreReportArtifact,
} from "../src/backup/contracts";
import { createContentAddressedRef, hashContent } from "../src/hash";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";

const digest = (letter: string) => letter.repeat(64);

async function portable(): Promise<BackupManifest> {
  const candidate: BackupManifest = {
    schemaVersion: "backup-v1", backupId: "backup", createdAt: "2026-08-27T00:00:00.000Z", appVersion: "1", runtimeGeneration: 3,
    entries: [{ logicalPath: "plans/plan.json", kind: "plan", byteLength: 10, sha256: digest("a"), privacyClass: "private_user" }],
    includedRoots: ["plans"], excludedEntries: [{ kind: "provider_key", reason: "secret" }], planIds: ["plan"], requirementSpecHashes: [digest("b")], factSnapshotIds: ["facts"], userObservationSnapshotIds: ["observations"], priceSnapshotIds: ["prices"], evaluationHashes: [digest("c")], artifactLockfileRef: "artifact-lock", executionSessionIds: [], manifestHash: digest("0"),
    mode: "plan_portable", portableProfile: "slim",
  };
  return { ...candidate, manifestHash: await hashContent(candidate, { domain: "backup-manifest", schemaVersion: "backup-v1" }) };
}

function envelopeFor(manifest: BackupManifest): BackupEnvelope {
  return {
    formatVersion: "1", manifestHash: manifest.manifestHash, payloadSha256: digest("f"), payloadSha256Basis: "ciphertext",
    encryption: {
      mode: "authenticated", formatVersion: "1", kdf: "scrypt",
      kdfParams: { n: 32_768, r: 8, p: 1, saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==" },
      cipher: "aes-256-gcm", keyLengthBits: 256, nonceBase64: "AAAAAAAAAAAAAAAA", authTagBase64: "AAAAAAAAAAAAAAAAAAAAAA==", aadSha256: digest("d"),
    },
  };
}

async function verificationFor(manifest: BackupManifest): Promise<{
  report: BackupVerificationReport;
  artifact: TemporaryRestoreArtifact;
  restoreReport: TemporaryRestoreReportArtifact;
}> {
  const artifact: TemporaryRestoreArtifact = {
    schemaVersion: "temporary-restore-artifact-v1", backupId: manifest.backupId, manifestHash: manifest.manifestHash,
    runtimeGeneration: 4, restoredRootHash: digest("e"), entryCount: manifest.entries.length,
  };
  const artifactRef = await createContentAddressedRef(artifact, { domain: "artifact", schemaVersion: "1.0.0" });
  const restoreReport: TemporaryRestoreReportArtifact = {
    schemaVersion: "temporary-restore-report-v1", backupId: manifest.backupId, manifestHash: manifest.manifestHash,
    runtimeGeneration: 4, restoreArtifactRef: artifactRef.ref, checkedEntryCount: manifest.entries.length, result: "pass",
  };
  const reportRef = await createContentAddressedRef(restoreReport, { domain: "artifact", schemaVersion: "1.0.0" });
  return {
    artifact,
    restoreReport,
    report: {
      backupId: manifest.backupId, manifestHash: manifest.manifestHash, stagedPayloadSha256: digest("f"),
      verifiedAt: "2026-08-27T00:30:00.000Z", appVersion: "1", schemaVersion: "backup-verification-v1",
      entryChecks: manifest.entries.map((entry) => ({ logicalPath: entry.logicalPath, expectedByteLength: entry.byteLength, actualByteLength: entry.byteLength, expectedSha256: entry.sha256, actualSha256: entry.sha256 })),
      temporaryRestore: { artifactRef, reportRef, restoredManifestHash: manifest.manifestHash, runtimeGeneration: 4 }, result: "pass",
    },
  };
}

describe("U0 portability and backup contracts", () => {
  it("separates structural validation from registered manifest hash verification", async () => {
    const manifest = await portable();
    expect(validateBackupManifest(manifest)).toEqual([]);
    await expect(verifyBackupManifestHash(manifest)).resolves.toEqual([]);
    const tampered = { ...manifest, appVersion: "tampered" };
    expect(validateBackupManifest(tampered)).toEqual([]);
    await expect(verifyBackupManifestHash(tampered)).resolves.toContain("manifestHash verification failed");
    expect(validateBackupManifest({ ...manifest, mode: "full_local_backup", portableProfile: "complete" })).toContain("full local backup must not use a portable profile");
    expect(validateBackupManifest({ ...manifest, entries: [{ ...manifest.entries[0]!, logicalPath: "../escape" }] })).toContain("backup entry 0 path invalid");
    expect(validateBackupManifest(null)).toEqual(["backup manifest must be an object"]);
  });

  it("enforces production scrypt and complete AEAD parameters for private/full payloads", async () => {
    const manifest = await portable();
    expect(validateBackupEnvelope({ formatVersion: "1", manifestHash: manifest.manifestHash, payloadSha256: digest("f"), payloadSha256Basis: "ciphertext", encryption: { mode: "none", formatVersion: "1" } }, manifest)).toContain("private_user/full backup payload requires authenticated encryption");
    expect(validateBackupEnvelope({ ...envelopeFor(manifest), encryption: { ...envelopeFor(manifest).encryption, kdfParams: { n: 16_384, r: 8, p: 1, saltBase64: "AAAAAAAAAAAAAAAAAAAAAA==" } } }, manifest)).toContain("authenticated envelope production KDF/cipher parameters invalid");
    expect(validateBackupEnvelope(envelopeFor(manifest), manifest)).toEqual([]);
  });

  it("requires dry-run-safe explicit conflict behavior", () => {
    expect(validateImportPlan({ importPlanId: "import", mode: "apply", manifestHash: digest("a"), portableProfile: "slim", resultMode: "exact_replay", conflicts: [{ existingId: "plan", incomingHash: digest("b"), existingHash: digest("c") }], idRemap: {}, action: "no_op_same_hash" })).toEqual(expect.arrayContaining([
      "different-hash conflicts cannot be silently treated as no-op",
      "slim portable imports must reevaluate with the current runtime",
    ]));
    expect(validateImportPlan({ importPlanId: "import", mode: "apply", manifestHash: digest("a"), portableProfile: "complete", resultMode: "exact_replay", conflicts: [{ existingId: "plan", incomingHash: digest("b"), existingHash: digest("c") }], idRemap: { plan: "plan-copy" }, action: "copy_as_new_plan" })).toEqual([]);
  });

  it("rejects forged pass booleans and authorizes pointer switch only from staged/restored evidence", async () => {
    const manifest = await portable();
    expect(validateBackupVerification({ backupId: "backup", manifestHash: manifest.manifestHash, verifiedAt: "2026-08-27T00:00:00.000Z", appVersion: "1", schemaVersion: "1", hashClosureValid: true, temporaryRestoreTested: true, result: "pass" })).toEqual(expect.arrayContaining([
      "backup verification identity/hash/timestamp invalid",
      "backup verification requires per-entry checks",
      "temporary restore artifacts invalid",
    ]));
    const { report, artifact, restoreReport } = await verificationFor(manifest);
    const trusted = { stagedPayloadSha256: digest("f"), stagedEntries: manifest.entries, temporaryRestoreArtifact: artifact, temporaryRestoreReport: restoreReport };
    await expect(verifyBackupForPointerSwitch(report, manifest, envelopeFor(manifest), trusted)).resolves.toMatchObject({ verified: true, pointerSwitchAllowed: true, errors: [] });
    await expect(verifyBackupForPointerSwitch(report, manifest, envelopeFor(manifest), { ...trusted, stagedPayloadSha256: digest("9") })).resolves.toMatchObject({ verified: false, pointerSwitchAllowed: false });
    await expect(verifyBackupForPointerSwitch(report, manifest, envelopeFor(manifest), { ...trusted, temporaryRestoreArtifact: { ...artifact, restoredRootHash: digest("9") } })).resolves.toMatchObject({ verified: false, pointerSwitchAllowed: false });

    const resolver = createAuthoritativeResolver("backup-verification-context", (ref) => ref === "backup/staged-verification" ? trusted : undefined);
    await expect(verifyBackupForPointerSwitchAuthoritatively(report, manifest, envelopeFor(manifest), "backup/staged-verification", resolver))
      .resolves.toMatchObject({ verified: true, pointerSwitchAllowed: true, errors: [] });
    await expect(verifyBackupForPointerSwitchAuthoritatively(report, manifest, envelopeFor(manifest), "missing", resolver))
      .resolves.toMatchObject({ verified: false, pointerSwitchAllowed: false, errors: [expect.stringContaining("backup authoritative context resolution failed")] });
    await expect(verifyBackupForPointerSwitchAuthoritatively(report, manifest, envelopeFor(manifest), "backup/staged-verification", JSON.parse(JSON.stringify(trusted)) as never))
      .resolves.toMatchObject({ verified: false, pointerSwitchAllowed: false, errors: [expect.stringContaining("resolver was not issued by the server composition root")] });
  });
});

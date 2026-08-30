import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactedDiagnosticBundle, verifyRedactedDiagnosticBundle } from "../src/doctor/diagnostic-bundle.mjs";
import { runDoctor } from "../src/doctor/runner.mjs";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteFile, confined } from "../src/runtime/fs.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("U12 Doctor diagnostic redaction", () => {
  it("reports a sensitive log by code/hash while the portable diagnostic contains no raw path or value", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-doctor-redaction-")); roots.push(root);
    const now = "2026-08-30T00:00:00.000Z";
    const coordinator = new RuntimeCoordinator({ root, now: () => now });
    const state = await coordinator.initialize("test");
    const secret = "UNIQUE_PRIVATE_VALUE_9f73bdbb";
    await atomicWriteFile(confined(coordinator.activeRoot(state), "diagnostics", "logs", "service.log"), `api_key=${secret}\n`, { mode: 0o600 });
    const doctorRun = await runDoctor({ coordinator, offline: true, now: () => now });
    expect(doctorRun.report.checks.find((check: { checkId: string }) => check.checkId === "security.log_redaction"))
      .toMatchObject({ status: "fail", evidence: [{ code: "security_log_redaction_fail", valueHash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(JSON.stringify(doctorRun.report)).not.toContain(secret);
    expect(JSON.stringify(doctorRun.report)).not.toContain(root);

    const output = path.join(root, "redacted-diagnostic.json");
    const bundle = await createRedactedDiagnosticBundle({ doctorRun, outputFile: output, now: () => now });
    expect(bundle.privacy).toMatchObject({ redacted: true, omitted: expect.arrayContaining(["raw_paths", "secrets", "private_attachment_bytes"]) });
    const raw = await readFile(output, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(root);
    await expect(verifyRedactedDiagnosticBundle(output)).resolves.toEqual({ valid: true, errors: [] });
  });
});

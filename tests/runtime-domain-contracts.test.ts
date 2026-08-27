import { describe, expect, it } from "vitest";
import { authorizeJobCommit, restoreBackgroundJob, restoredJobStatus, validateBackgroundJob, validateJobTransition, type BackgroundJob } from "../src/jobs/contracts";
import { DEFAULT_DOCTOR_CHECK_REGISTRY, DOCTOR_CHECK_REGISTRY_VERSION, DOCTOR_VERSION, deriveDoctorOverall, doctorExitCode, validateDoctorReport, validateRepairExecution, verifyDoctorReport, verifyDoctorReportAuthoritatively, verifyRepairExecutionAuthoritatively, type DoctorCheckEvidenceArtifact, type DoctorReport } from "../src/doctor/contracts";
import { createContentAddressedRef, hashContent } from "../src/hash";
import { createAuthoritativeResolver } from "../src/contracts/trusted-context";
import { validateSimulationInput, validateSimulationInputSources } from "../src/simulation/contracts";

const digest = (letter: string) => letter.repeat(64);
const job = (): BackgroundJob => ({
  schemaVersion: "job-v1", jobId: "job", type: "evidence", handlerVersion: "1", idempotencyKey: "once", inputHash: digest("a"), payloadRef: "payload", status: "running", revision: 4, attempt: 1, maxAttempts: 3, runAfter: "2026-08-27T00:00:00.000Z", leaseOwner: "worker", leaseToken: "lease-new", leaseExpiresAt: "2026-08-27T01:00:00.000Z", runtimeGeneration: 7, networkRequired: true, dependencyJobIds: [], resultRefs: [], createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
});

async function trustedDoctorFixture() {
  const evidenceArtifacts = new Map<string, DoctorCheckEvidenceArtifact>();
  const checks = [] as DoctorReport["checks"];
  for (const registered of DEFAULT_DOCTOR_CHECK_REGISTRY) {
    const artifact: DoctorCheckEvidenceArtifact = {
      schemaVersion: "doctor-check-evidence-v1", doctorVersion: DOCTOR_VERSION, checkRegistryVersion: DOCTOR_CHECK_REGISTRY_VERSION,
      runtimeGeneration: 7, checkId: registered.checkId, checkVersion: registered.checkVersion, status: "pass", severity: "info",
      measurementHash: digest("c"), measuredAt: "2026-08-27T00:00:00.000Z",
    };
    const ref = await createContentAddressedRef(artifact, { domain: "artifact", schemaVersion: "1.0.0" });
    evidenceArtifacts.set(ref.ref, artifact);
    checks.push({ ...registered, status: "pass", severity: "info", summary: "checked", evidence: [{ code: "OK", valueHash: digest("c") }], evidenceArtifactRefs: [ref], repairable: false });
  }
  const candidate: DoctorReport = {
    schemaVersion: "doctor-v1", doctorVersion: DOCTOR_VERSION, checkRegistryVersion: DOCTOR_CHECK_REGISTRY_VERSION, runtimeGeneration: 7,
    generatedAt: "2026-08-27T00:00:00.000Z", appVersion: "1", overall: "healthy", checks, reportHash: digest("0"),
  };
  const report = { ...candidate, reportHash: await hashContent(candidate, { domain: "doctor-report", schemaVersion: "doctor-v1" }) };
  const context = { doctorVersion: DOCTOR_VERSION, checkRegistryVersion: DOCTOR_CHECK_REGISTRY_VERSION, runtimeGeneration: 7, checkRegistry: DEFAULT_DOCTOR_CHECK_REGISTRY, evidenceArtifacts };
  return { report, context };
}

describe("U0 runtime operation contracts", () => {
  it("fences stale revision, lease and restored runtime generation commits", () => {
    expect(authorizeJobCommit(job(), { expectedRevision: 4, leaseToken: "lease-new", runtimeGeneration: 7, committedAt: "2026-08-27T00:30:00.000Z" })).toEqual({ allowed: true });
    expect(authorizeJobCommit(job(), { expectedRevision: 4, leaseToken: "lease-old", runtimeGeneration: 7, committedAt: "2026-08-27T00:30:00.000Z" })).toMatchObject({ allowed: false, reason: "lease_mismatch" });
    expect(authorizeJobCommit(job(), { expectedRevision: 4, leaseToken: "lease-new", runtimeGeneration: 6, committedAt: "2026-08-27T00:30:00.000Z" })).toMatchObject({ allowed: false, reason: "runtime_generation_mismatch" });
    expect(authorizeJobCommit({ ...job(), leaseExpiresAt: "invalid" }, { expectedRevision: 4, leaseToken: "lease-new", runtimeGeneration: 7, committedAt: "invalid" })).toMatchObject({ allowed: false, reason: "invalid_timestamp" });
    expect(restoredJobStatus("waiting_retry")).toBe("paused_restore_review");
    expect(restoredJobStatus("succeeded")).toBe("succeeded");
    const restored = restoreBackgroundJob(job(), 8, "2026-08-27T02:00:00.000Z");
    expect(restored).toMatchObject({ status: "paused_restore_review", runtimeGeneration: 8, revision: 5 });
    expect(restored).not.toHaveProperty("leaseToken");
  });

  it("rejects invalid jobs and illegal state-machine leaps", () => {
    expect(validateBackgroundJob(job())).toEqual([]);
    expect(validateBackgroundJob({ ...job(), inputHash: "input" })).toContain("job inputHash invalid");
    const { leaseOwner: _owner, leaseToken: _token, leaseExpiresAt: _expiry, ...withoutLease } = job();
    const queued: BackgroundJob = { ...withoutLease, status: "queued", attempt: 0 };
    const succeeded: BackgroundJob = { ...queued, status: "succeeded", revision: queued.revision + 1, resultCommitHash: digest("b") };
    expect(validateJobTransition(queued, succeeded)).toContain("illegal job transition: queued -> succeeded");
  });

  it("derives Doctor outcome and verifies registry/version/runtime/evidence bindings", async () => {
    const degraded = deriveDoctorOverall([{ checkId: "offline", checkVersion: "1", category: "network", status: "warn", severity: "degraded", summary: "offline", evidence: [{ code: "OFFLINE" }], evidenceArtifactRefs: [], repairable: false }]);
    expect(degraded).toBe("degraded");
    expect(doctorExitCode(degraded)).toBe(1);
    const { report, context } = await trustedDoctorFixture();
    expect(validateDoctorReport(report)).toEqual([]);
    await expect(verifyDoctorReport(report, context)).resolves.toEqual({ verified: true, errors: [] });
    expect(validateDoctorReport({ ...report, checks: report.checks.map((check, index) => index === 0 ? { ...check, evidence: [{ code: "LEAK", redactedDisplay: "/home/user/private" }] } : check) })).toContain("doctor check 0 evidence contains sensitive detail");
    await expect(verifyDoctorReport({ ...report, appVersion: "forged" }, context)).resolves.toMatchObject({ verified: false, errors: expect.arrayContaining(["doctor reportHash verification failed"]) });
    const unregistered = { ...report, checks: report.checks.map((check, index) => index === 0 ? { ...check, checkVersion: "forged" } : check) };
    const forgedRegistryReport = { ...unregistered, reportHash: await hashContent(unregistered, { domain: "doctor-report", schemaVersion: "doctor-v1" }) };
    await expect(verifyDoctorReport(forgedRegistryReport, context)).resolves.toMatchObject({ verified: false, errors: expect.arrayContaining(["doctor check 0 is not bound to trusted registry"]) });
    const doctorResolver = createAuthoritativeResolver("doctor-verification-context", (ref) => ref === "doctor/current" ? context : undefined);
    await expect(verifyDoctorReportAuthoritatively(report, "doctor/current", doctorResolver)).resolves.toEqual({ verified: true, errors: [] });
    await expect(verifyDoctorReportAuthoritatively(report, "missing", doctorResolver)).resolves.toMatchObject({ verified: false, errors: [expect.stringContaining("Doctor authoritative context resolution failed")] });
    await expect(verifyDoctorReportAuthoritatively(report, "doctor/current", JSON.parse(JSON.stringify(context)) as never)).resolves.toMatchObject({ verified: false, errors: [expect.stringContaining("resolver was not issued by the server composition root")] });
    const staleDoctorResolver = createAuthoritativeResolver("doctor-verification-context", () => ({ ...context, runtimeGeneration: 8 }));
    await expect(verifyDoctorReportAuthoritatively(report, "doctor/current", staleDoctorResolver)).resolves.toMatchObject({ verified: false, errors: expect.arrayContaining(["doctor report runtime/version binding invalid"]) });
    const repair = { repairPlanId: "repair", reportHash: report.reportHash, doctorVersion: report.doctorVersion, checkRegistryVersion: report.checkRegistryVersion, runtimeGeneration: report.runtimeGeneration, actionIds: ["rebuild-index"], impactSummary: "Rebuild", preconditionHashes: [digest("e")], backupId: "backup", idempotencyKey: "repair-once", approvedAt: "2026-08-27T00:00:00.000Z", rollbackRefs: ["rollback"] };
    const repairContext = { currentReportHash: report.reportHash, currentDoctorVersion: report.doctorVersion, currentCheckRegistryVersion: report.checkRegistryVersion, currentRuntimeGeneration: report.runtimeGeneration, currentPreconditionHashes: [digest("e")], verifiedBackupIds: new Set(["backup"]) };
    expect(validateRepairExecution(repair, repairContext)).toEqual([]);
    expect(validateRepairExecution(repair, { ...repairContext, currentReportHash: digest("f"), verifiedBackupIds: new Set() })).toEqual(expect.arrayContaining(["repair report binding is stale", "repair execution requires a verified pre-repair backup"]));
    const trustedRepair = { ...repairContext, currentReport: report, doctorVerification: context };
    const repairResolver = createAuthoritativeResolver("repair-execution-context", (ref) => ref === "repair/current" ? trustedRepair : undefined);
    await expect(verifyRepairExecutionAuthoritatively(repair, "repair/current", repairResolver)).resolves.toEqual([]);
    await expect(verifyRepairExecutionAuthoritatively(repair, "repair/current", repairContext as never)).resolves.toEqual([
      expect.stringContaining("resolver was not issued by the server composition root"),
    ]);
  });

  it("validates bounded immutable simulation inputs", () => {
    expect(validateSimulationInput({ workloadMetricRefs: ["workload"], ambientC: { min: 30, max: 20 }, fanPolicyId: "balanced", storageActivity: [], placementIds: [], routeIds: [], modelVersion: "1" })).toContain("ambientC interval invalid");
    expect(validateSimulationInput({ workloadMetricRefs: ["workload"], ambientC: { min: 20, max: 30 }, fanPolicyId: "balanced", storageActivity: [{ logicalLayoutId: "pool", dutyCycle: 0.6, concurrentDiskCount: 4 }], placementIds: [], routeIds: [], modelVersion: "1" })).toEqual([]);
    expect(validateSimulationInput({ workloadMetricRefs: ["workload"], ambientC: { min: 20, max: 30 }, fanPolicyId: "balanced", storageActivity: [{ logicalLayoutId: "pool", dutyCycle: 0.6, concurrentDiskCount: 0 }], placementIds: [], routeIds: [], modelVersion: "1" })).toContain("storage activity invalid");
    const input = { workloadMetricRefs: ["workload"], ambientC: { min: 20, max: 30 }, fanPolicyId: "balanced", storageActivity: [], placementIds: [], routeIds: [], modelVersion: "1" };
    expect(validateSimulationInputSources({ input, sources: [
      ...["workloadMetricRefs", "ambientC", "fanPolicyId", "storageActivity", "placementIds", "routeIds"].map((field) => ({ fieldPath: `/${field}`, source: "user" as const, userOverridable: true as const, sourceRef: "user" })),
    ] })).toContain("simulation input source missing: /modelVersion");
    const exactSources = [
      "/workloadMetricRefs/0", "/ambientC/min", "/ambientC/max", "/fanPolicyId", "/storageActivity", "/placementIds", "/routeIds", "/modelVersion",
    ].map((fieldPath) => ({ fieldPath, source: "user" as const, userOverridable: true as const, sourceRef: "user" }));
    expect(validateSimulationInputSources({ input, sources: exactSources })).toEqual([]);
    expect(validateSimulationInputSources({ input, sources: exactSources.map((source, index) => index === 1 ? { ...source, fieldPath: "/ambientC/attacker" } : source) })).toEqual(expect.arrayContaining([
      "every simulation input source must use an exact governed leaf path and remain attributable",
      "simulation input source missing: /ambientC/min",
    ]));
    expect(validateSimulationInputSources({ input, sources: [...exactSources, { ...exactSources[0]!, fieldPath: "/workloadMetricRefs/99" }] })).toContain("every simulation input source must use an exact governed leaf path and remain attributable");
    expect(() => validateSimulationInputSources({})).not.toThrow();
  });
});

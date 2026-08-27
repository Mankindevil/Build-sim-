import { isVerifiedBackupResult } from "../backup/runtime.mjs";
import { isDoctorRunResult } from "./runner.mjs";

/**
 * Runtime repair stays disabled unless all approval/backup/precondition gates
 * pass. This executor deliberately owns no repair actions in U1.
 */
export async function executeApprovedRepair({ plan, doctorRun, verifiedBackup, allowRepair = false, coordinator, actionRunner, idempotencyStore }) {
  const errors = [];
  if (!isDoctorRunResult(doctorRun)) errors.push("repair requires runner-issued Doctor state");
  if (!isVerifiedBackupResult(verifiedBackup)) errors.push("repair requires runner-issued backup verification");
  const current = doctorRun?.report;
  if (!allowRepair) errors.push("repair flag is disabled");
  if (!plan?.approvedAt) errors.push("repair requires explicit approval");
  if (plan?.reportHash !== current?.reportHash || plan?.doctorVersion !== current?.doctorVersion
    || plan?.checkRegistryVersion !== current?.checkRegistryVersion || plan?.runtimeGeneration !== current?.runtimeGeneration) errors.push("repair report/version binding is stale");
  const expected = [...(plan?.preconditionHashes ?? [])].sort();
  const actual = [...(doctorRun?.preconditionHashes ?? [])].sort();
  if (!expected.length || expected.length !== actual.length || expected.some((hash, index) => hash !== actual[index])) errors.push("repair preconditions changed");
  if (verifiedBackup?.valid !== true || verifiedBackup?.report?.result !== "pass" || verifiedBackup?.manifest?.backupId !== plan?.backupId) errors.push("repair requires a matching verified pre-repair backup");
  if (typeof actionRunner !== "function" || !coordinator || !idempotencyStore) errors.push("repair runner dependencies are unavailable");
  if (errors.length) return { applied: false, errors };
  if (await idempotencyStore.has(plan.idempotencyKey)) return { applied: false, idempotentReplay: true, errors: [] };
  const lease = await coordinator.acquireMaintenanceLease("doctor-repair", { ttlMs: 300_000 });
  try {
    await actionRunner({ actionIds: [...plan.actionIds], leaseToken: lease.token, rollbackRefs: [...plan.rollbackRefs] });
    await idempotencyStore.mark(plan.idempotencyKey);
    return { applied: true, errors: [] };
  } finally { await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined); }
}

import { isVerifiedBackupResult } from "../backup/runtime.mjs";
import { isDoctorRunResult } from "./runner.mjs";

/**
 * Runtime repair stays disabled unless all approval/backup/precondition gates
 * pass. This executor deliberately owns no repair actions in U1.
 */
/** @param {any} options */
export async function executeApprovedRepair(options) {
  const { plan, doctorRun, verifiedBackup, allowRepair = false, coordinator, actionRunner, rollbackRunner, verifyRollback, idempotencyStore } = options;
  const errors = [];
  if (!isDoctorRunResult(doctorRun)) errors.push("repair requires runner-issued Doctor state");
  if (!isVerifiedBackupResult(verifiedBackup)) errors.push("repair requires runner-issued backup verification");
  const current = doctorRun?.report;
  if (!allowRepair) errors.push("repair flag is disabled");
  if (!plan?.approvedAt) errors.push("repair requires explicit approval");
  if (verifiedBackup?.valid !== true || verifiedBackup?.report?.result !== "pass" || verifiedBackup?.manifest?.backupId !== plan?.backupId) errors.push("repair requires a matching verified pre-repair backup");
  if (!Array.isArray(plan?.actionIds) || !plan.actionIds.length || new Set(plan.actionIds).size !== plan.actionIds.length
    || plan.actionIds.some((id) => typeof id !== "string" || !id)) errors.push("repair action IDs are invalid");
  if (!Array.isArray(plan?.rollbackRefs) || !plan.rollbackRefs.length || new Set(plan.rollbackRefs).size !== plan.rollbackRefs.length
    || plan.rollbackRefs.some((ref) => typeof ref !== "string" || !ref)) errors.push("repair rollback references are invalid");
  if (typeof actionRunner !== "function" || !coordinator || !idempotencyStore) errors.push("repair runner dependencies are unavailable");
  if (errors.length) return { applied: false, errors };
  // A previously committed exact plan is a read-only replay. Its successful
  // repair necessarily changes the report/preconditions, so checking staleness
  // first would make idempotency impossible. All identity, approval, backup,
  // action and dependency gates above still apply before this early return.
  if (await idempotencyStore.has(plan.idempotencyKey)) return { applied: false, idempotentReplay: true, errors: [] };
  if (plan?.reportHash !== current?.reportHash || plan?.doctorVersion !== current?.doctorVersion
    || plan?.checkRegistryVersion !== current?.checkRegistryVersion || plan?.runtimeGeneration !== current?.runtimeGeneration) errors.push("repair report/version binding is stale");
  const expected = [...(plan?.preconditionHashes ?? [])].sort();
  const actual = [...(doctorRun?.preconditionHashes ?? [])].sort();
  if (!expected.length || expected.length !== actual.length || expected.some((hash, index) => hash !== actual[index])) errors.push("repair preconditions changed");
  if (errors.length) return { applied: false, errors };
  const lease = await coordinator.acquireMaintenanceLease("doctor-repair", { ttlMs: 300_000 });
  try {
    try {
      await actionRunner({ actionIds: [...plan.actionIds], leaseToken: lease.token, rollbackRefs: [...plan.rollbackRefs] });
      await idempotencyStore.mark(plan.idempotencyKey);
      return { applied: true, rolledBack: false, errors: [] };
    } catch (error) {
      if (typeof rollbackRunner !== "function" || typeof verifyRollback !== "function") throw error;
      await rollbackRunner({ actionIds: [...plan.actionIds], leaseToken: lease.token, rollbackRefs: [...plan.rollbackRefs] });
      const rollback = await verifyRollback({ rollbackRefs: [...plan.rollbackRefs] });
      if (rollback !== true) throw new AggregateError([error], "repair failed and rollback hash verification failed");
      return { applied: false, rolledBack: true, errors: ["repair failed; exact rollback was verified"] };
    }
  } finally { await coordinator.releaseMaintenanceLease(lease.token).catch(() => undefined); }
}

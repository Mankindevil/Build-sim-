import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileJobRepository } from "../src/jobs/repository";
import { PriceRepository } from "../src/price/repository";
import { PriceScheduleService, currentPriceScheduleClaim } from "../src/price/schedule";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";

const now = "2026-08-29T12:34:56.000Z";
const schedule = {
  scheduleId: "price-target-hourly",
  jobType: "price_target_recheck" as const,
  subjectRef: "price-target:target-a",
  cadenceSeconds: 3_600,
  nextRunAt: "2026-08-20T00:00:00.000Z",
  enabled: true,
};

async function harness(root: string, faultAfterJobCreate?: () => void | Promise<void>) {
  const coordinator = new RuntimeCoordinator({ root, now: () => now });
  const prices = new PriceRepository({ coordinator, now: () => now });
  const jobs = new FileJobRepository({ coordinator, now: () => now });
  await prices.initialize("price-schedule-test");
  return { prices, jobs, service: new PriceScheduleService(prices, jobs, { ...(faultAfterJobCreate ? { faultAfterJobCreate } : {}) }) };
}

describe("U10 durable price schedule catch-up", () => {
  it("collapses a long offline interval into one current bucket", () => {
    expect(currentPriceScheduleClaim(schedule, now)).toEqual({ bucket: "2026-08-29T12:00:00.000Z", nextRunAt: "2026-08-29T13:00:00.000Z" });
  });

  it("persists one job and does not enqueue the same catch-up bucket after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-schedule-"));
    const first = await harness(root);
    await first.prices.putSchedule(schedule, { expectedRevision: 0 });
    const tick = await first.service.tick(schedule.scheduleId, now);
    expect(tick.due).toBe(true);
    expect(tick.jobCreated).toBe(true);
    expect((await first.jobs.list())).toHaveLength(1);
    const restarted = await harness(root);
    expect((await restarted.service.tick(schedule.scheduleId, now)).due).toBe(false);
    expect((await restarted.jobs.list())).toHaveLength(1);
  });

  it("replays the deterministic job after a crash before the schedule cursor write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-price-schedule-crash-"));
    let fail = true;
    const first = await harness(root, () => { if (fail) { fail = false; throw new Error("injected after job create"); } });
    await first.prices.putSchedule(schedule, { expectedRevision: 0 });
    await expect(first.service.tick(schedule.scheduleId, now)).rejects.toThrow(/injected/);
    expect((await first.jobs.list())).toHaveLength(1);
    expect((await first.prices.getSchedule(schedule.scheduleId)).schedule.lastEnqueuedBucket).toBeUndefined();
    const restarted = await harness(root);
    const replay = await restarted.service.tick(schedule.scheduleId, now);
    expect(replay.jobCreated).toBe(false);
    expect(replay.schedule.schedule.lastEnqueuedBucket).toBe("2026-08-29T12:00:00.000Z");
    expect((await restarted.jobs.list())).toHaveLength(1);
  });
});

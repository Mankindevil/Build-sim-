import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.setDefaultTimeout(20_000);
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("409") && !message.text().includes("500") && !message.text().includes("502")) errors.push(message.text());
});

await page.goto("http://127.0.0.1:5173/index.html#/agent", { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(window.__BUILD_SIM_PLAN_STORE__?.getState().evaluationSnapshot));
await page.waitForSelector("[data-agent-plan-proposals]", { state: "attached" });
// Previous browser gates intentionally persist their active plan. Normalize the
// proposal fixture to a valid onboard-storage baseline so this gate does not
// inherit G7's nine-disk/HBA-warning configuration.
const inherited = await page.evaluate(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return { diskCount: state?.activePlan?.draft.config.selection.diskCount, evaluationHash: state?.evaluationSnapshot?.evaluationHash };
});
if (inherited.diskCount !== 1) {
  await page.fill("#disk-range", "1");
  await page.locator("#disk-range").dispatchEvent("input");
  await page.waitForFunction((previousHash) => {
    const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
    return state?.activePlan?.draft.config.selection.diskCount === 1
      && state.evaluationSnapshot?.evaluationHash !== previousHash
      && document.querySelector("[data-save-status]")?.getAttribute("data-status") === "saved"
      && state.evaluationSnapshot?.draftRevision === state.activePlan?.draftRevision;
  }, inherited.evaluationHash);
}
const baseline = await page.evaluate(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__.getState();
  return {
    planId: state.activePlan.id,
    revision: state.activePlan.draftRevision,
    configHash: state.evaluationSnapshot.configHash,
    evaluationHash: state.evaluationSnapshot.evaluationHash,
    diskCount: state.activePlan.draft.config.selection.diskCount,
  };
});
if (!(await page.locator("[data-agent-plan-context]").textContent()).includes(baseline.evaluationHash.slice(0, 12))) throw new Error("Agent context badge is not bound to active evaluation");

const proposalId = `proposal-browser-r7-${baseline.revision}`;
const targetDiskCount = baseline.diskCount === 1 ? 2 : 1;
await page.locator("[data-agent-plan-proposals]").evaluate((host, value) => {
  host.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal: {
    schemaVersion: "1.0.0",
    id: value.proposalId,
    planId: value.planId,
    expectedDraftRevision: value.revision,
    expectedConfigHash: value.configHash,
    createdAt: "2026-08-25T00:00:00.000Z",
    summary: "R7 browser approved disk change",
    rationale: ["browser fixture"],
    operations: [{ op: "replace", path: "/selection/diskCount", value: value.targetDiskCount }],
    predictedImpact: { resolvedFindingIds: ["agent-untrusted-finding"], introducedFindingIds: ["agent-untrusted-new"], budgetDeltaCny: 999999 },
    status: "proposed",
  } } }));
}, { proposalId, targetDiskCount, ...baseline });
const card = page.locator(`[data-plan-proposal="${proposalId}"]`);
await page.waitForFunction((id) => {
  const host = document.querySelector("[data-agent-plan-proposals]");
  return Boolean(document.querySelector(`[data-plan-proposal="${id}"]`)) || host?.textContent?.includes("提案验证失败");
}, proposalId);
if (!(await card.count())) throw new Error(`proposal validation failed: ${await page.locator("[data-agent-plan-proposals]").textContent()}`);
if ((await card.textContent()).includes("agent-untrusted")) throw new Error("proposal card trusted model-provided impact instead of server evaluation");
if ((await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.draft.config.selection.diskCount)) !== baseline.diskCount) throw new Error("proposal mutated the draft before approval");
const apply = card.locator("[data-apply-proposal]");
if (!(await apply.isDisabled())) throw new Error("proposal apply was enabled without explicit approval");
await card.locator("[data-proposal-approval]").check();
await apply.click();
await page.waitForFunction(({ targetDiskCount, evaluationHash }) => {
  const state = window.__BUILD_SIM_PLAN_STORE__?.getState();
  return state?.activePlan?.draft.config.selection.diskCount === targetDiskCount && state.evaluationSnapshot?.evaluationHash !== evaluationHash;
}, { targetDiskCount, evaluationHash: baseline.evaluationHash });
if (!(await card.locator("[data-proposal-state]").textContent()).includes("applied")) throw new Error("approved proposal did not expose applied audit state");

const applied = await page.evaluate(() => {
  const state = window.__BUILD_SIM_PLAN_STORE__.getState();
  return { revision: state.activePlan.draftRevision, configHash: state.evaluationSnapshot.configHash, diskCount: state.activePlan.draft.config.selection.diskCount };
});
await page.locator("[data-agent-plan-proposals]").evaluate((host, value) => {
  host.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal: {
    schemaVersion: "1.0.0", id: "proposal-browser-reject", planId: value.planId, expectedDraftRevision: value.revision, expectedConfigHash: value.configHash,
    createdAt: "2026-08-25T00:01:00.000Z", summary: "Reject this", rationale: ["browser fixture"],
    operations: [{ op: "replace", path: "/selection/diskCount", value: value.diskCount + 1 }],
    predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null }, status: "proposed",
  } } }));
}, { planId: baseline.planId, ...applied });
const rejectCard = page.locator('[data-plan-proposal="proposal-browser-reject"]');
await rejectCard.waitFor();
await rejectCard.locator("[data-reject-proposal]").click();
if (!(await rejectCard.locator("[data-proposal-state]").textContent()).includes("rejected")) throw new Error("proposal reject state was not rendered");
if ((await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.draft.config.selection.diskCount)) !== applied.diskCount) throw new Error("rejected proposal changed the draft");

await page.locator("[data-agent-plan-proposals]").evaluate((host, value) => {
  host.dispatchEvent(new CustomEvent("build-sim:agent-plan-proposal", { detail: { proposal: {
    schemaVersion: "1.0.0", id: "proposal-browser-stale", planId: value.planId, expectedDraftRevision: value.revision, expectedConfigHash: value.configHash,
    createdAt: "2026-08-25T00:02:00.000Z", summary: "Stale proposal", rationale: ["browser fixture"],
    operations: [{ op: "replace", path: "/selection/diskCount", value: value.diskCount + 2 }],
    predictedImpact: { resolvedFindingIds: [], introducedFindingIds: [], budgetDeltaCny: null }, status: "proposed",
  } } }));
}, baseline);
await page.waitForFunction(() => document.querySelector("[data-agent-plan-proposals]")?.textContent?.includes("提案验证失败") && document.querySelector("[data-agent-plan-proposals]")?.textContent?.includes("stale_revision"));
if ((await page.evaluate(() => window.__BUILD_SIM_PLAN_STORE__.getState().activePlan.draft.config.selection.diskCount)) !== applied.diskCount) throw new Error("stale proposal changed the draft");

if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);
console.log("Agent plan browser smoke passed", { planId: baseline.planId, beforeRevision: baseline.revision, afterRevision: applied.revision, diskCount: applied.diskCount });
await browser.close();

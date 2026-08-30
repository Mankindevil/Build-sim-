import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPlanConfigRuntime } from "../src/plans/canonical-runtime.mjs";

const built = await import("../dist-workspace/workspace-server.js");
const runtimeRoot = await mkdtemp(path.join(tmpdir(), "build-sim-dist-governed-smoke-"));
const servers = [];

async function listen(repositories) {
  const server = built.createWorkspaceServer(repositories.repository, {
    evaluationPipeline: repositories.evaluationPipeline,
    factUpdateNoticeService: repositories.factUpdateNoticeService,
    factGraphEnabled: true,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("workspace smoke server address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function postEvaluation(baseUrl, plan) {
  const response = await fetch(`${baseUrl}/api/workspace/plans/${encodeURIComponent(plan.id)}/evaluations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: {
        kind: "draft",
        expectedDraftRevision: plan.draftRevision,
        expectedConfigHash: hashPlanConfigRuntime(plan.draft.config),
      },
    }),
  });
  const payload = await response.json();
  if (response.status !== 201) throw new Error(`dist governed route returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function listFactUpdateNotices(baseUrl, planId) {
  const response = await fetch(`${baseUrl}/api/workspace/plans/${encodeURIComponent(planId)}/fact-update-notices`);
  const payload = await response.json();
  if (response.status !== 200 || !Array.isArray(payload.notices)) {
    throw new Error(`dist fact update notice route returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload.notices;
}

try {
  const environment = {
    RUNTIME_ROOT: runtimeRoot,
    BUILD_SIM_FACT_GRAPH_ENABLED: "true",
    BUILD_SIM_TOPOLOGY_V3_ENABLED: "true",
  };
  const firstRepositories = built.createWorkspaceRepositories(environment);
  await firstRepositories.coordinator.initialize();
  const inputHash = createHash("sha256").update("dist-governed-smoke-price").digest("hex");
  const priceMaterial = {
    schemaVersion: "1.1.0",
    asOf: "2026-08-28",
    note: "dist governed evaluation smoke",
    snapshotId: `price-snapshot-${inputHash.slice(0, 20)}`,
    generatedAt: "2026-08-28T12:00:00.000Z",
    catalogVersion: "dist-governed-smoke",
    inputHash,
    priceVersion: "price-snapshot-v2",
    quotes: [],
  };
  const priceSnapshot = {
    ...priceMaterial,
    contentHash: createHash("sha256").update(JSON.stringify(priceMaterial)).digest("hex"),
  };
  await firstRepositories.coordinator.withWrite(async ({ activeRoot }) => {
    await mkdir(path.join(activeRoot, "prices"), { recursive: true });
    await writeFile(path.join(activeRoot, "prices", "latest.json"), `${JSON.stringify(priceSnapshot)}\n`, "utf8");
  });
  const config = {
    schemaVersion: "3.0.0",
    id: "dist-governed-smoke",
    name: "Dist governed smoke",
    updatedAt: "2026-08-28T12:00:00.000Z",
    intent: null,
    requirementSpec: null,
    system: null,
    components: [],
    roleDecisions: [],
    placements: [],
    connections: [],
    logicalLayouts: [],
    firmwareTargets: [],
  };
  const plan = await firstRepositories.repository.create({ name: config.name, config });
  const firstServer = await listen(firstRepositories);
  const first = await postEvaluation(firstServer, plan);
  if (first.cacheStatus !== "miss" || first.evaluation?.kind !== "topology-v3-partial"
    || !/^[a-f0-9]{64}$/.test(first.evaluationLock?.snapshotHashes?.engineHash ?? "")) {
    throw new Error("dist governed route returned an invalid locked receipt");
  }
  if ((await listFactUpdateNotices(firstServer, plan.id)).length !== 0) {
    throw new Error("blank dist plan unexpectedly produced a fact update notice");
  }
  await close(servers.pop());

  const restartedRepositories = built.createWorkspaceRepositories(environment);
  const restartedServer = await listen(restartedRepositories);
  const replay = await postEvaluation(restartedServer, plan);
  if (replay.cacheStatus !== "hit" || replay.evaluationHash !== first.evaluationHash
    || replay.evaluationLock.contentHash !== first.evaluationLock.contentHash) {
    throw new Error("dist governed route did not replay the persisted full-lock receipt after restart");
  }
  if ((await listFactUpdateNotices(restartedServer, plan.id)).length !== 0) {
    throw new Error("blank restarted dist plan unexpectedly produced a fact update notice");
  }
  process.stdout.write(`${JSON.stringify({
    first: first.cacheStatus,
    restart: replay.cacheStatus,
    evaluationHash: replay.evaluationHash,
    engineHash: replay.evaluationLock.snapshotHashes.engineHash,
  })}\n`);
} finally {
  await Promise.all(servers.splice(0).map((server) => close(server)));
  await rm(runtimeRoot, { recursive: true, force: true });
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "../src/agent/contracts";
import { AgentToolRegistry } from "../src/agent/tool-registry";
import type { BuildConfigDocument } from "../src/config/types";
import type { PlanChangeProposal } from "../src/plans/contracts";
import { hashPlanConfig } from "../src/plans/canonical";
import { FilePlanRepository } from "../src/plans/file-repository";
import { PlanProposalService } from "../src/plans/proposals";
import { createBuildSimTools } from "../src/server/domain-tools";
import { createEmptyBuildConfigV3, type BuildConfigV3 } from "../src/topology/contracts";
import { projectTopologyToBom } from "../src/topology/projections";

const roots: string[] = [];
const now = () => "2026-08-27T16:00:00.000Z";
let sequence = 0;

function toolContext(config: BuildConfigDocument, round: number): AgentToolContext {
  return {
    sessionId: "session-progressive-v3",
    runId: `run-progressive-v3-${round}`,
    buildConfig: structuredClone(config),
    signal: new AbortController().signal,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  sequence = 0;
});

describe("U2 Agent progressive topology proposals", () => {
  it("preserves a requirements-only first round and adds only the explicitly mentioned unresolved component in round two", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "build-sim-agent-progressive-v3-"));
    roots.push(root);
    const repository = new FilePlanRepository<BuildConfigDocument>({
      root,
      topologyV3Enabled: true,
      now,
      id: (prefix) => `${prefix}-${String(++sequence).padStart(8, "0")}`,
    });
    const created = await repository.create({
      name: "渐进式空白方案",
      config: createEmptyBuildConfigV3("draft", "渐进式空白方案", now()),
    });
    const tools = new AgentToolRegistry(createBuildSimTools());
    const service = new PlanProposalService<BuildConfigDocument>(repository, now);

    const requirementSpec = {
      requirementSpecId: "requirements-progressive-v3",
      schemaVersion: "1.0.0",
      workloads: [{
        workloadId: "workload-photo-library",
        state: "answered",
        name: "照片归档",
        metrics: [],
        source: "agent_proposed",
        confirmedByUser: false,
      }],
      constraints: [],
    };
    const firstDispatch = await tools.dispatch("propose_plan_change", {
      planId: created.id,
      expectedDraftRevision: created.draftRevision,
      expectedConfigHash: await hashPlanConfig(created.draft.config),
      summary: "只记录照片归档需求",
      rationale: ["本轮用户只描述用途，没有指定硬件"],
      operations: [{
        op: "replace",
        selector: { collection: "config", field: "requirementSpec" },
        value: requirementSpec,
      }],
    }, toolContext(created.draft.config, 1));
    expect(firstDispatch.result.ok, JSON.stringify(firstDispatch.result)).toBe(true);
    const firstProposal = (firstDispatch.result.content as { proposal: PlanChangeProposal<BuildConfigV3> }).proposal;
    expect(firstProposal.operations).toHaveLength(1);
    const firstApplied = await service.apply(created.id, firstProposal, undefined, {
      confirmed: true,
      approvedBy: "human-fixture",
    });
    const requirementsOnly = firstApplied.plan.draft.config as BuildConfigV3;
    expect(requirementsOnly).toMatchObject({
      requirementSpec: { workloads: [{ workloadId: "workload-photo-library", confirmedByUser: false }] },
      components: [],
      roleDecisions: [],
      placements: [],
      connections: [],
    });
    expect(projectTopologyToBom(requirementsOnly)).toEqual([]);

    const secondDispatch = await tools.dispatch("propose_plan_change", {
      planId: created.id,
      expectedDraftRevision: firstApplied.plan.draftRevision,
      expectedConfigHash: await hashPlanConfig(requirementsOnly),
      summary: "只加入用户刚提到的一块 8TB 硬盘",
      rationale: ["型号尚未确认，因此保持 unresolved"],
      operations: [{
        op: "add",
        selector: { collection: "components", id: "drive-user-mentioned-1" },
        value: {
          instanceId: "drive-user-mentioned-1",
          kind: "storage_drive",
          role: "data_disk",
          state: "planned",
          identity: { status: "unresolved", userText: "一块 8TB 硬盘，型号待确认" },
          source: "agent",
        },
      }],
    }, toolContext(requirementsOnly, 2));
    expect(secondDispatch.result.ok, JSON.stringify(secondDispatch.result)).toBe(true);
    const secondProposal = (secondDispatch.result.content as { proposal: PlanChangeProposal<BuildConfigV3> }).proposal;
    expect(secondProposal.operations).toHaveLength(1);
    const secondApplied = await service.apply(created.id, secondProposal, undefined, {
      confirmed: true,
      approvedBy: "human-fixture",
    });
    const finalConfig = secondApplied.plan.draft.config as BuildConfigV3;
    expect(finalConfig.requirementSpec).toEqual(requirementsOnly.requirementSpec);
    expect(finalConfig.components).toEqual([expect.objectContaining({
      instanceId: "drive-user-mentioned-1",
      kind: "storage_drive",
      identity: { status: "unresolved", userText: "一块 8TB 硬盘，型号待确认" },
    })]);
    expect(finalConfig.roleDecisions).toEqual([]);
    expect(finalConfig.placements).toEqual([]);
    expect(finalConfig.connections).toEqual([]);
    expect(projectTopologyToBom(finalConfig)).toEqual([expect.objectContaining({
      instanceId: "drive-user-mentioned-1",
      identityStatus: "unresolved",
      quantity: 1,
    })]);

    await expect(repository.saveVersion(created.id, {
      expectedRevision: secondApplied.plan.draftRevision,
      expectedConfigHash: await hashPlanConfig(finalConfig),
      reason: "agent-proposal",
    })).resolves.toMatchObject({
      config: {
        requirementSpec: { workloads: [{ workloadId: "workload-photo-library" }] },
        components: [{ instanceId: "drive-user-mentioned-1" }],
      },
    });
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderProcedurePreview } from "../src/lab/build-procedure";
import type { SystemProcedurePreview } from "../src/server/system-execution-production";

afterEach(() => document.body.replaceChildren());

const hash = (character: string) => character.repeat(64);

describe("U11 first-boot procedure UI", () => {
  it("projects ordered phases, stop conditions, and the exact saved-version receipt", () => {
    const host = document.createElement("section"); document.body.append(host);
    const preview = {
      schemaVersion: "system-procedure-preview-v1",
      planId: "plan-first-boot",
      planVersionId: "version-first-boot",
      configHash: hash("a"),
      evaluationHash: hash("b"),
      evaluationLockHash: hash("c"),
      profile: { profileId: "system.windows-11", label: "Windows 11" },
      systemEvaluation: { verdict: "pass" },
      firmwareEvaluations: [],
      storageLayouts: [],
      blockers: [],
      destructiveActions: [],
      generated: { procedure: {
        procedureId: "procedure-first-boot", inputEvaluationHash: hash("b"), procedureSafetyHash: hash("d"),
        phases: ["prepare", "pre_power", "post", "system_install"],
        steps: [
          { stepId: "inventory", phase: "prepare", stopConditions: ["part identity differs"], action: "核对部件" },
          { stepId: "power-check", phase: "pre_power", stopConditions: ["connector is not fully seated"], action: "核对供电" },
          { stepId: "post-check", phase: "post", stopConditions: ["no display output"], action: "观察 POST" },
          { stepId: "install", phase: "system_install", stopConditions: [], action: "安装系统" },
        ],
      } },
    } as unknown as SystemProcedurePreview;

    renderProcedurePreview(host, preview);

    expect(host.textContent).toContain("Windows 11 · 系统可用性 pass");
    expect(host.textContent).toContain("version-first-boot");
    expect([...host.querySelectorAll("[data-procedure-phases] > li strong")].map((node) => node.textContent))
      .toEqual(["prepare", "pre_power", "post", "system_install"]);
    expect(host.textContent).toContain("停止条件：connector is not fully seated");
    expect(host.querySelector("button")).toBeNull();
  });
});

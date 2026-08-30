import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, secretContentKind } from "../src/backup/runtime.mjs";
import { createPortablePlanPackage, openPortablePlanPackage } from "../src/portability";
import { RuntimeCoordinator } from "../src/runtime/coordinator.mjs";
import { atomicWriteJson, confined, sha256Bytes, sha256Json } from "../src/runtime/fs.mjs";
import { createEmptyBuildConfigV3 } from "../src/topology/contracts";
import { rewriteEncryptedPortablePackage } from "./helpers/rewrite-encrypted-backup";

const roots: string[] = [];
const at = "2026-08-30T00:00:00.000Z";

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function writePlan(activeRoot: string, planId: string, description?: string): Promise<void> {
  const config = createEmptyBuildConfigV3(planId, "Portable plan", at);
  const plan = {
    schemaVersion: "1.0.0", id: planId, name: "Portable plan", ...(description ? { description } : {}),
    status: "active", createdAt: at, updatedAt: at, activeVersionId: null, draftRevision: 0,
    draft: { schemaVersion: "1.0.0", baseVersionId: null, config, evidenceBindings: [], dirty: true, updatedAt: at },
    metadata: {},
  };
  await atomicWriteJson(confined(activeRoot, "plans", planId, "plan.json"), {
    schemaVersion: "1.0.0", kind: "plan", checksum: sha256Json(plan), payload: plan,
  });
}

describe("U12 backup and portable secret exclusion", () => {
  it("detects secret-bearing JSON keys and bounded assignment strings without exposing their values", () => {
    expect(secretContentKind(Buffer.from(JSON.stringify({ password: "PRIVATE_VALUE" })))).toBe("provider_key");
    expect(secretContentKind(Buffer.from(JSON.stringify({ note: "api_key=PRIVATE_VALUE" })))).toBe("provider_key");
    expect(secretContentKind(Buffer.from(JSON.stringify({ note: "cookies=PRIVATE_VALUE" })))).toBe("cookie");
    expect(secretContentKind(Buffer.from(JSON.stringify({ note: "password guidance without an assigned value" })))).toBeNull();
  });

  it("refuses both full and plan-scoped exports when a selected governed record contains secret material", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-secret-export-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => at });
    const state = await coordinator.initialize("test");
    await writePlan(coordinator.activeRoot(state), "plan-sensitive", "password=PRIVATE_VALUE_NEVER_EXPORT");

    await expect(createBackup({
      coordinator,
      outputFile: path.join(root, "forbidden.backup"),
      password: "sufficient backup password",
      now: () => at,
    })).rejects.toThrow("secret-bearing content");
    await expect(createPortablePlanPackage({
      coordinator,
      outputFile: path.join(root, "forbidden.buildsim"),
      password: "sufficient portable password",
      planId: "plan-sensitive",
      portableProfile: "slim",
      now: () => at,
    })).rejects.toThrow("secret-bearing content");
  });

  it("rejects secret material inside an otherwise authenticated and checksum-correct portable package", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "buildsim-secret-import-")); roots.push(root);
    const coordinator = new RuntimeCoordinator({ root, now: () => at });
    const state = await coordinator.initialize("test");
    await writePlan(coordinator.activeRoot(state), "plan-safe");
    const password = "sufficient portable password";
    const source = path.join(root, "safe.buildsim");
    const forged = path.join(root, "authenticated-secret.buildsim");
    await createPortablePlanPackage({
      coordinator, outputFile: source, password, planId: "plan-safe", portableProfile: "slim", now: () => at,
    });
    await rewriteEncryptedPortablePackage({
      inputFile: source,
      outputFile: forged,
      password,
      mutate(payload) {
        const files = payload.files as Array<{ logicalPath: string; dataBase64: string }>;
        const planFile = files.find(({ logicalPath }) => logicalPath === "plans/plan-safe/plan.json");
        if (!planFile) throw new Error("portable plan fixture is missing");
        const envelope = JSON.parse(Buffer.from(planFile.dataBase64, "base64").toString("utf8")) as {
          checksum: string;
          payload: Record<string, unknown>;
        };
        envelope.payload.description = "password=AUTHENTICATED_SECRET_VALUE";
        envelope.checksum = sha256Json(envelope.payload);
        const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
        planFile.dataBase64 = bytes.toString("base64");
        const manifest = payload.manifest as { entries: Array<{ logicalPath: string; byteLength: number; sha256: string }> };
        const entry = manifest.entries.find(({ logicalPath }) => logicalPath === planFile.logicalPath);
        if (!entry) throw new Error("portable plan manifest entry is missing");
        entry.byteLength = bytes.length;
        entry.sha256 = sha256Bytes(bytes);
      },
    });

    await expect(openPortablePlanPackage(forged, password)).rejects.toThrow("secret-bearing content");
  });
});

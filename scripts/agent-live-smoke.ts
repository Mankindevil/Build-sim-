import crypto from "node:crypto";
import { loadDeepSeekConfig } from "./deepseek/config.mjs";
import { DeepSeekProviderAdapter } from "../src/agent/providers/deepseek";

if (process.env.BUILD_SIM_AGENT_LIVE_SMOKE !== "1") {
  throw new Error("set BUILD_SIM_AGENT_LIVE_SMOKE=1 to authorize one bounded provider request");
}

const config = await loadDeepSeekConfig();
const adapter = new DeepSeekProviderAdapter({
  ...config,
  timeoutMs: Math.min(config.timeoutMs, 45_000),
  maxTokens: Math.min(config.maxTokens, 64),
  temperature: 0,
});
const result = await adapter.createTurn({
  model: config.model,
  system: "You are a health-check endpoint. Follow the user instruction exactly and output no other text.",
  messages: [{ id: "live-smoke", role: "user", content: "Return exactly LIVE_OK", createdAt: new Date().toISOString() }],
  tools: [],
  maxTokens: Math.min(config.maxTokens, 64),
  temperature: 0,
  signal: AbortSignal.timeout(45_000),
});

const content = result.content.trim();
const report = {
  ok: content === "LIVE_OK",
  provider: result.provider,
  model: result.model,
  providerRequestIdPresent: Boolean(result.providerRequestId),
  stopReason: result.stopReason,
  usage: result.usage,
  latencyMs: result.latencyMs,
  contentBytes: Buffer.byteLength(content),
  contentSha256: crypto.createHash("sha256").update(content).digest("hex"),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;

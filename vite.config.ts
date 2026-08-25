import { defineConfig } from "vitest/config";
import path from "node:path";
import { intEnv, loadEnv } from "./scripts/price-server/env.mjs";

export default defineConfig(async () => {
  const env = await loadEnv();
  const webPort = intEnv(env, "WEB_SERVER_PORT", 5173, { min: 1, max: 65_535 });
  const previewPort = intEnv(env, "WEB_PREVIEW_PORT", 4173, { min: 1, max: 65_535 });
  const pricePort = intEnv(env, "PRICE_SERVER_PORT", 5174, { min: 1, max: 65_535 });
  const agentPort = intEnv(env, "AGENT_SERVER_PORT", 5175, { min: 1, max: 65_535 });
  const workspacePort = intEnv(env, "WORKSPACE_SERVER_PORT", 5176, { min: 1, max: 65_535 });

  return {
    root: ".",
    publicDir: "public",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@data": path.resolve(__dirname, "data"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      open: "/index.html",
      proxy: {
        // Local-only services; absent proxy targets return 502 without exposing them publicly.
        "/api/price": {
          target: `http://127.0.0.1:${pricePort}`,
          changeOrigin: false,
        },
        "/api/advice": {
          target: `http://127.0.0.1:${pricePort}`,
          changeOrigin: false,
        },
        "/api/catalog": {
          target: `http://127.0.0.1:${pricePort}`,
          changeOrigin: false,
        },
        "/api/agent": {
          target: `http://127.0.0.1:${agentPort}`,
          changeOrigin: false,
        },
        "/api/workspace": {
          target: `http://127.0.0.1:${workspacePort}`,
          changeOrigin: false,
        },
      },
    },
    preview: {
      host: "127.0.0.1",
      port: previewPort,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true,
    },
    test: {
      include: ["tests/**/*.test.ts"],
    },
  };
});

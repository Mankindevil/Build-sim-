import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@data": path.resolve(__dirname, "data"),
    },
  },
  build: {
    ssr: path.resolve(__dirname, "src/server/agent-server.ts"),
    outDir: "dist-agent",
    emptyOutDir: true,
    sourcemap: true,
    target: "node20",
    rollupOptions: {
      output: { entryFileNames: "agent-server.js" },
    },
  },
});

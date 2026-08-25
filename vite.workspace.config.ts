import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@data": path.resolve(__dirname, "data"),
    },
  },
  build: {
    ssr: path.resolve(__dirname, "src/server/workspace-server.ts"),
    outDir: "dist-workspace",
    emptyOutDir: true,
    sourcemap: true,
    target: "node20",
    rollupOptions: { output: { entryFileNames: "workspace-server.js" } },
  },
});

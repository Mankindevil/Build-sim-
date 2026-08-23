import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@data": path.resolve(__dirname, "data"),
    },
  },
  server: {
    port: 5173,
    open: "/index.html",
    proxy: {
      // Local-only price collector (npm run price:serve); absent proxy target just 502s.
      "/api/price": {
        target: "http://127.0.0.1:5174",
        changeOrigin: false,
      },
      "/api/advice": {
        target: "http://127.0.0.1:5174",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});

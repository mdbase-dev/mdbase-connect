import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const basePath = `/${(process.env.MDBASE_EDITOR_BASE_PATH ?? "/").replace(/^\/+|\/+$/g, "")}/`
  .replace(/^\/\/$/, "/");
const buildId = (process.env.MDBASE_EDITOR_BUILD_ID ?? process.env.GITHUB_SHA ?? "local")
  .slice(0, 12)
  .replace(/[^a-zA-Z0-9_-]/gu, "-");

export default defineConfig({
  base: basePath,
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
    reportCompressedSize: true,
    rolldownOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${buildId}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildId}.js`
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
    include: ["src/**/*.test.{ts,tsx}"]
  }
});

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The editor's portal-served Playwright fixture invokes Vite directly.
execFileSync(process.execPath, [
  fileURLToPath(new URL("../../packages/app-ui/scripts/compile-catalogues.mjs", import.meta.url)),
  fileURLToPath(new URL(".", import.meta.url)),
], { stdio: "inherit" });

export default defineConfig({
  plugins: [react(), lingui({ macroTransform: true })],
  // hoistingLimits gives each workspace package its own React; @mdbase-dev/ui must render with the app's.
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react"] },
  test: {
    environment: "jsdom", setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true, testTimeout: 15_000, include: ["src/**/*.test.{ts,tsx}"]
  },
  server: {
    port: 5178,
    proxy: {
      "/v1": "http://127.0.0.1:8787",
      "/oauth": "http://127.0.0.1:8787"
    }
  }
});


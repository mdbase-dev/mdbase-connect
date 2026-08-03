import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const basePath = `/${(process.env.MDBASE_EDITOR_BASE_PATH ?? "/").replace(/^\/+|\/+$/g, "")}/`
  .replace(/^\/\/$/, "/");

export default defineConfig({
  base: basePath,
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
    reportCompressedSize: true
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
    include: ["src/**/*.test.{ts,tsx}"]
  }
});

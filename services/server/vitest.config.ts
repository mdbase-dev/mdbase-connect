import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@mdbase/connect-sync": fileURLToPath(new URL("../../packages/sync/src/index.ts", import.meta.url)),
      "@mdbase/connect-webhooks": fileURLToPath(new URL("../../packages/webhooks/src/index.ts", import.meta.url))
    }
  },
  test: { include: ["src/**/*.test.ts"] }
});

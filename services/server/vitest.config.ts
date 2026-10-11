import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      // Source, not the built dist: a filtered server test run does not rebuild
      // workspace packages, and a stale protocol dist silently tests old rules.
      {
        find: /^@mdbase-dev\/connect-protocol\/manifest$/,
        replacement: fileURLToPath(new URL("../../packages/protocol/src/manifest.ts", import.meta.url))
      },
      {
        find: /^@mdbase-dev\/connect-protocol$/,
        replacement: fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url))
      },
      {
        find: "@mdbase-dev/connect-sync/mirror",
        replacement: fileURLToPath(new URL("../../packages/sync/src/mirror.ts", import.meta.url))
      },
      {
        find: /^@mdbase\/connect-sync$/,
        replacement: fileURLToPath(new URL("../../packages/sync/src/index.ts", import.meta.url))
      },
      {
        find: "@mdbase-dev/connect-webhooks",
        replacement: fileURLToPath(new URL("../../packages/webhooks/src/index.ts", import.meta.url))
      }
    ]
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000
  }
});

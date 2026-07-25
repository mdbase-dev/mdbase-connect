import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@mdbase/connect-sync/node",
        replacement: fileURLToPath(new URL("../../packages/sync/src/node.ts", import.meta.url))
      },
      {
        find: /^@mdbase\/connect-sync$/,
        replacement: fileURLToPath(new URL("../../packages/sync/src/index.ts", import.meta.url))
      },
      {
        find: "@mdbase/connect-webhooks",
        replacement: fileURLToPath(new URL("../../packages/webhooks/src/index.ts", import.meta.url))
      }
    ]
  },
  test: { include: ["src/**/*.test.ts"] }
});

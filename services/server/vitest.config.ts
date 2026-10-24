import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests may import the vendored SDK source under runtime/. That tree has no
// installed dependencies, so its package imports resolve as the server's do.
const runtimeSdk = fileURLToPath(new URL("../../runtime/packages/sdk/src/", import.meta.url));
const serverImporter = fileURLToPath(new URL("./src/app.ts", import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: "runtime-sdk-dependencies",
      enforce: "pre",
      async resolveId(source, importer) {
        if (!importer?.startsWith(runtimeSdk) || source.startsWith(".") || source.startsWith("/")) return null;
        return this.resolve(source, serverImporter, { skipSelf: true });
      }
    }
  ],
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

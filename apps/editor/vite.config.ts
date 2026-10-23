import { offlineShellPlugin } from "@mdbase-dev/sdk/offline-shell/build";
import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import { defineConfig } from "vitest/config";

const basePath = `/${(process.env.MDBASE_EDITOR_BASE_PATH ?? "/").replace(/^\/+|\/+$/g, "")}/`
  .replace(/^\/\/$/, "/");
const buildId = (process.env.MDBASE_EDITOR_BUILD_ID ?? process.env.GITHUB_SHA ?? "local")
  .slice(0, 12)
  .replace(/[^a-zA-Z0-9_-]/gu, "-");

export default defineConfig(({ mode }) => ({
  // Explicit public fixture configuration; remote builds deliberately exclude .env files.
  define: mode === "e2e" ? {
    "import.meta.env.VITE_MDBASE_EDITOR_DEMO": JSON.stringify("1"),
    "import.meta.env.VITE_MDBASE_FEEDBACK_URL": JSON.stringify("http://127.0.0.1:8790/v1/feedback")
  } : {},
  base: basePath,
  plugins: [react(), lingui({ macroTransform: true }), offlineShellPlugin({ register: false })],
  // hoistingLimits gives each workspace package its own copies; @mdbase-dev/ui must use the app's
  // React and CodeMirror (two @codemirror/state instances cannot share an editor).
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react", "@mdbase-dev/sdk", "@codemirror/state", "@codemirror/view"] },
  // Linked libraries retain Node JSON import attributes. Prebundle their i18n
  // entries in dev so Vite serves JS modules without native JSON MIME assertions.
  // Production still emits separate lazy locale chunks.
  optimizeDeps: { include: ["@mdbase-dev/ui/i18n", "@mdbase/connect-ui/i18n"] },
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
    // Workspace packages have isolated installs. Inline the provider and its
    // Lingui dependency so Vite's React/context deduplication also applies in tests.
    server: { deps: { inline: ["@mdbase-dev/i18n", "@lingui/react"] } },
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
    include: ["src/**/*.test.{ts,tsx}"]
  }
}));

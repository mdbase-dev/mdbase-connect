import { offlineShellPlugin } from "@mdbase-dev/sdk/offline-shell/build";
import { mdbaseOpeningPage } from "@mdbase-dev/ui/opening-page";
import react from "@vitejs/plugin-react";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildIdentity, buildIdentityPlugin } from "./scripts/build-identity.mjs";
import { editorDirectOrigin } from "./scripts/direct-origin.mjs";

execFileSync(process.execPath, [
  fileURLToPath(new URL("../../packages/app-ui/scripts/compile-catalogues.mjs", import.meta.url)),
  fileURLToPath(new URL(".", import.meta.url)),
], { stdio: "inherit" });
import { defineConfig } from "vitest/config";

const basePath = `/${(process.env.MDBASE_EDITOR_BASE_PATH ?? "/").replace(/^\/+|\/+$/g, "")}/`
  .replace(/^\/\/$/, "/");
const buildId = buildIdentity(process.env.MDBASE_EDITOR_BUILD_ID ?? process.env.GITHUB_SHA);

export default defineConfig(({ mode }) => ({
  // Explicit public fixture configuration; remote builds deliberately exclude .env files.
  define: { "import.meta.env.MDBASE_EDITOR_DIRECT_ORIGIN": JSON.stringify(editorDirectOrigin(process.env.MDBASE_EDITOR_DIRECT_ORIGIN) ?? null), ...(mode === "e2e" ? {
    "import.meta.env.VITE_MDBASE_EDITOR_DEMO": JSON.stringify("1"),
    "import.meta.env.VITE_MDBASE_FEEDBACK_URL": JSON.stringify("http://127.0.0.1:8790/v1/feedback")
  } : {}) },
  base: basePath,
  plugins: [
    react(),
    lingui(),
    babel({ presets: [linguiTransformerBabelPreset()] }),
    // The opening screen paints from index.html before any script runs; OpeningScreen continues it.
    mdbaseOpeningPage({
      app: "editor",
      title: "Opening collection",
      detail: "Reading notes and files",
      themeColor: { light: "#fcfcfd", dark: "#1b1d23" }
    }),
    // Every shipped HTML document changes bytes per source commit, so an edge that
    // revalidates it cannot keep the previous build's headers.
    buildIdentityPlugin(buildId),
    offlineShellPlugin({ register: false })
  ],
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
    // CSP allows fonts only from 'self', so never inline one (KaTeX has fonts under the 4 KB default) as a data: URL.
    assetsInlineLimit: (file) => /\.(woff2?|ttf|otf)$/.test(file) ? false : undefined,
    rolldownOptions: {
      ...(mode === "e2e" ? { input: ["index.html", "tests/fixtures/editor-regressions.html"] } : {}),
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

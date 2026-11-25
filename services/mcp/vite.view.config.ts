import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

execFileSync(process.execPath, [
  fileURLToPath(new URL("../../packages/app-ui/scripts/compile-catalogues.mjs", import.meta.url)),
  fileURLToPath(new URL(".", import.meta.url)),
], { stdio: "inherit" });

// The MCP App view (src/view.ts serves it). Hosts render the page without a base URL, so the
// gateway points its two entry references at its own origin; everything else the bundle loads
// is relative to the module that loads it, and so comes from the gateway too.
export default defineConfig({
  root: fileURLToPath(new URL("./view", import.meta.url)),
  base: "./",
  plugins: [react(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })],
  // hoistingLimits gives each workspace package its own copies; @mdbase-dev/ui must use the view's
  // React, Lingui and CodeMirror (two @codemirror/state instances cannot share an editor).
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common"] },
  build: {
    outDir: fileURLToPath(new URL("./dist-app", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    // The view's CSP allows its files from the gateway origin, not data: URLs.
    assetsInlineLimit: 0,
    // No inline polyfill script: the page carries only references to files.
    modulePreload: { polyfill: false },
    // React, CodeMirror and the shared UI are one entry the page needs whole; math, diagrams and
    // other languages are already separate chunks loaded on use.
    chunkSizeWarningLimit: 1_000,
  },
});

import react from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { editorDirectOrigin } from "../scripts/direct-origin.mjs";
import { buildIdentity, buildIdentityPlugin } from "../scripts/build-identity.mjs";

const origin = editorDirectOrigin(process.env.MDBASE_EDITOR_DIRECT_ORIGIN);
if (!origin) throw new Error("Set MDBASE_EDITOR_DIRECT_ORIGIN before building the direct editor");
// The publisher passes the source commit; its first 12 characters name the entry
// asset and stamp every document, so the served build names its source.
const buildId = buildIdentity(process.env.MDBASE_EDITOR_BUILD_ID ?? process.env.GITHUB_SHA);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: { "import.meta.env.MDBASE_EDITOR_DIRECT_BUILD": "true", "import.meta.env.MDBASE_EDITOR_DIRECT_ORIGIN": JSON.stringify(origin) },
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react", "@codemirror/state", "@codemirror/view"] },
  plugins: [react(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] }), buildIdentityPlugin(buildId)],
  build: {
    outDir: "../dist-direct", emptyOutDir: true, target: "es2022",
    rolldownOptions: { output: { entryFileNames: `assets/[name]-[hash]-${buildId}.js`, chunkFileNames: `assets/[name]-[hash]-${buildId}.js` } },
  },
});

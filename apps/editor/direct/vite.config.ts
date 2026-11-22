import react from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { editorDirectOrigin } from "../scripts/direct-origin.mjs";

const origin = editorDirectOrigin(process.env.MDBASE_EDITOR_DIRECT_ORIGIN);
if (!origin) throw new Error("Set MDBASE_EDITOR_DIRECT_ORIGIN before building the direct editor");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: { "import.meta.env.MDBASE_EDITOR_DIRECT_BUILD": "true", "import.meta.env.MDBASE_EDITOR_DIRECT_ORIGIN": JSON.stringify(origin) },
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react", "@codemirror/state", "@codemirror/view"] },
  plugins: [react(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] })],
  build: { outDir: "../dist-direct", emptyOutDir: true, target: "es2022" },
});

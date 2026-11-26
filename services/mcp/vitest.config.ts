import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The view's tests render its components, whose copy is Lingui macros.
  plugins: [lingui(), babel({ presets: [linguiTransformerBabelPreset()] })],
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react", "@codemirror/state", "@codemirror/view"] },
  test: {
    environment: "node"
  }
});

import { defineConfig } from "vitest/config";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
  plugins: [lingui(), babel({ presets: [linguiTransformerBabelPreset()] })],
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react"] },
});

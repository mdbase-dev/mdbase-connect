import { defineConfig } from "vitest/config";
import { lingui } from "@lingui/vite-plugin";

export default defineConfig({
  plugins: [lingui({ macroTransform: true })],
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react"] },
});

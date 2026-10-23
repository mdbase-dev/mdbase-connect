import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), lingui({ macroTransform: true })],
  // hoistingLimits gives each workspace package its own React; @mdbase-dev/ui must render with the app's.
  resolve: { dedupe: ["react", "react-dom", "@lingui/core", "@lingui/react"] },
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, "index.html")
    }
  }
});


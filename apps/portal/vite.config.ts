import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // hoistingLimits gives each workspace package its own React; @mdbase-dev/ui must render with the app's.
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    environment: "jsdom", setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true, testTimeout: 15_000, include: ["src/**/*.test.{ts,tsx}"]
  },
  server: {
    port: 5178,
    proxy: {
      "/v1": "http://127.0.0.1:8787",
      "/oauth": "http://127.0.0.1:8787"
    }
  }
});


import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174/mdbase-editor/",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm dev --port 4174",
    url: "http://127.0.0.1:4174/mdbase-editor/?demo=10",
    reuseExistingServer: true,
    timeout: 120_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174/",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "pnpm build:e2e && pnpm preview --port 4174",
    url: "http://127.0.0.1:4174/?demo=10",
    reuseExistingServer: true,
    timeout: 120_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});

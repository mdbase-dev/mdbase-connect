import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MDBASE_EDITOR_E2E_PORT ?? 42_873);
const baseURL = `http://127.0.0.1:${port}/`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `pnpm build:e2e && pnpm preview --port ${port} --strictPort`,
    url: `${baseURL}?demo=10`,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});

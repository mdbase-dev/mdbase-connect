import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MDBASE_EDITOR_E2E_PORT ?? 42_873);
const baseURL = `http://127.0.0.1:${port}/`;
const webServerCommand =
  process.env.MDBASE_EDITOR_E2E_WEB_SERVER_COMMAND ??
  `pnpm build:e2e && pnpm preview --port ${port} --strictPort`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    // Fixture tests never contact real services. Page-level mocks still fulfill
    // synthetic external URLs, while Chromium cannot send unmatched traffic out.
    launchOptions: { args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1;localhost;[::1]"] },
    trace: "retain-on-failure"
  },
  webServer: {
    command: webServerCommand,
    url: `${baseURL}?demo=10`,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, grepInvert: /@performance/ },
    // Wall-clock budgets run alone, after the main suite, so a parallel worker
    // (for example the auth portal's Vite dev server compiling on demand) never
    // shares the CPU with the measurement. Budgets are unchanged.
    { name: "performance", workers: 1, use: { ...devices["Desktop Chrome"] }, grep: /@performance/, dependencies: ["chromium", "portal"] },
    // Management lives on Portal; keep its migrated coverage in the existing CI browser gate.
    // Phones run Safari's engine; keep a small smoke of the mobile layout on it.
    // WebKit takes no Chromium flags, so the same no-egress rule is a proxy option.
    {
      name: "mobile-webkit",
      testMatch: "embeds-mobile.spec.ts",
      grep: /mobile workspace/,
      use: {
        ...devices["iPhone 15"],
        launchOptions: {},
        proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost,[::1]" }
      }
    },
    { name: "portal", testDir: "../portal/tests", testIgnore: ["visual.spec.ts", "review-*.spec.ts", "interaction-budget.spec.ts"], use: { ...devices["Desktop Chrome"] } }
  ]
});

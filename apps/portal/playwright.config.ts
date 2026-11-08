import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 4801);
export default defineConfig({
  testDir: "./tests",
  testMatch: ["visual.spec.ts", "review-flows.spec.ts", "review-motion.spec.ts", "review-r8.spec.ts", "interaction-budget.spec.ts"],
  workers: 2,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`, timezoneId: "Australia/Melbourne",
    locale: "en-AU", reducedMotion: "reduce", trace: "retain-on-failure",
    launchOptions: { args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1;localhost;[::1]"] }
  },
  webServer: { command: "pnpm portal:review", cwd: "../..", url: `http://127.0.0.1:${port}/__review`, reuseExistingServer: false, timeout: 120_000 },
  projects: [
    { name: "review", testIgnore: ["interaction-budget.spec.ts", "review-motion.spec.ts"] },
    { name: "budgets", testMatch: ["interaction-budget.spec.ts", "review-motion.spec.ts"], dependencies: ["review"], workers: 1 }
  ]
});

import { test as base, expect, type Page } from "@playwright/test";
import { clock, scenarios } from "./scenarios.mjs";

export { expect };
export const test = base.extend<{ reviewChecks: void }>({
  reviewChecks: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      if (response.status() === 501 && new URL(response.url()).pathname.startsWith("/v1/")) errors.push(`Unmocked endpoint: ${response.url()}`);
    });
    await page.clock.setFixedTime(new Date(clock));
    await use();
    expect(errors).toEqual([]);
  }, { auto: true }]
});

export async function openScenario(page: Page, name: string) {
  const scenario = scenarios.find(scenario => scenario.name === name)!;
  await page.goto(`/__review/scenario/${name}?latency=60`);
  await expect(page.getByText(scenario.ready, { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return scenario;
}

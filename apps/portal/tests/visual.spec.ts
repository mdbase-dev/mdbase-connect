import { expect, openScenario, test } from "./review/fixture";
import { scenarios } from "./review/scenarios.mjs";

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`${viewport.width} ${colorScheme}`, () => {
      test.use({ viewport, colorScheme });
      for (const scenario of scenarios) test(scenario.name, async ({ page }, testInfo) => {
        await openScenario(page, scenario.name);
        await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-${viewport.width}-${colorScheme}.png`), fullPage: true });
        if (process.env.MDBASE_VISUAL_GOLDENS === "1") {
          await expect(page).toHaveScreenshot(`${scenario.name}-${viewport.width}-${colorScheme}.png`, { animations: "disabled", fullPage: true });
        }
      });
    });
  }
}

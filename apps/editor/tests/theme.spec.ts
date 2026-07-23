import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("follows the system theme and persists explicit overrides", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("?demo=4");
  const root = page.locator("html");
  await expect(root).not.toHaveAttribute("data-theme");
  const systemDarkCanvas = await root.evaluate((element) => getComputedStyle(element).getPropertyValue("--color-canvas").trim());
  expect(systemDarkCanvas).not.toBe("");

  await page.getByRole("button", { name: "Settings" }).click();
  const select = page.getByRole("combobox", { name: "Color theme" });
  await select.selectOption("light");
  await expect(root).toHaveAttribute("data-theme", "light");
  const explicitLightCanvas = await root.evaluate((element) => getComputedStyle(element).getPropertyValue("--color-canvas").trim());
  expect(explicitLightCanvas).not.toBe(systemDarkCanvas);

  await select.selectOption("dark");
  await expect.poll(() => root.evaluate((element) => getComputedStyle(element).getPropertyValue("--color-canvas").trim())).toBe(systemDarkCanvas);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => root.evaluate((element) => getComputedStyle(element).getPropertyValue("--color-canvas").trim())).toBe(systemDarkCanvas);
});

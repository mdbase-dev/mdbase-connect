import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`shared controls keep keyboard state and respect reduced motion in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("?demo=12");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Vim key bindings" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await toggle.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.getByRole("button", { name: "Types (1)" }).click();
    const review = page.getByRole("button", { name: "Review changes" });
    await expect(review).toBeDisabled();
    const checkbox = page.getByRole("checkbox", { name: "Required", exact: true }).first();
    const checked = await checkbox.isChecked();
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked({ checked: !checked });
    await expect(review).toBeEnabled();
    const revert = page.getByRole("button", { name: "Revert", exact: true });
    await revert.click();
    await expect(review).toBeDisabled();
    await expect(checkbox).toBeChecked({ checked });
  });
}

test("controls retain a non-color state cue in forced colors", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  const checkbox = page.getByRole("checkbox", { name: "Required", exact: true }).first();
  await checkbox.check();
  expect(await checkbox.evaluate((element) => getComputedStyle(element, "::after").content)).toBe('""');
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Vim key bindings" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await toggle.locator("span").evaluate((element) => getComputedStyle(element).translate)).toBe("14px");
});

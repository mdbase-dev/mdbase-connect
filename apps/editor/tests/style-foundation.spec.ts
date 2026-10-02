import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  test(`shared controls preserve keyboard state and action hierarchy in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("?demo=12");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).fontSize)).toBe("13px");
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Atkinson Hyperlegible Next Variable");
    const toggle = page.getByRole("switch", { name: "Vim key bindings" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveClass("mdbase-switch");
    expect(await toggle.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.getByRole("button", { name: "Types (1)" }).click();
    const review = page.getByRole("button", { name: "Review changes" });
    await expect(review).toBeDisabled();
    const disabledBackground = await review.evaluate((element) => getComputedStyle(element).backgroundColor);
    const checkbox = page.getByRole("checkbox", { name: "Required", exact: true }).first();
    await expect(checkbox).toHaveClass("mdbase-checkbox");
    const checked = await checkbox.isChecked();
    await checkbox.focus();
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked({ checked: !checked });
    await expect(review).toBeEnabled();
    await expect(review).toHaveClass(/mdbase-button is-primary/);
    expect(await review.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(disabledBackground);
    const add = page.getByRole("button", { name: "Add field", exact: true });
    await expect(add).toHaveClass("mdbase-button");
    const revert = page.getByRole("button", { name: "Revert", exact: true });
    await expect(revert).toHaveClass(/is-tertiary/);
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
  expect(await checkbox.evaluate((element) => getComputedStyle(element, "::after").borderBottomWidth)).toBe("2px");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Vim key bindings" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await toggle.locator("span").evaluate((element) => getComputedStyle(element).transform)).toBe("matrix(1, 0, 0, 1, 14, 0)");
});

import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`quiet screen controls stay aligned and operable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("?demo=300&surface=settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    const geometry = await page.locator(".settings-document").evaluate((document) => {
      const section = document.querySelector(".settings-intro")!;
      const heading = section.querySelector("h2")!.getBoundingClientRect();
      const description = section.querySelector("p")!.getBoundingClientRect();
      return {
        stacked: description.top >= heading.bottom,
        facts: [...document.querySelectorAll(".fact-row")].filter((row) => row.checkVisibility()).map((row) => row.getBoundingClientRect().height),
        preferences: [...document.querySelectorAll(".setting-row:not(.connection-action)")].map((row) => row.getBoundingClientRect().height)
      };
    });
    expect(geometry.stacked).toBe(true);
    expect(geometry.facts.filter((height) => height > 0).every((height) => height === 44)).toBe(true);
    expect(geometry.preferences.every((height) => height >= 64)).toBe(true);
    const vim = page.getByRole("switch", { name: "Vim key bindings" });
    await vim.focus();
    await page.keyboard.press("Space");
    await expect(vim).toHaveAttribute("aria-checked", "true");
    if (width === 390) await page.getByRole("button", { name: "Back to collection" }).click();
    await page.getByRole("button", { name: "Types (1)" }).click();
    await page.getByRole("option", { name: /note/ }).click();
    await expect(page.getByRole("textbox", { name: "title field name" })).toBeVisible();
    const notice = await page.locator(".type-inspector-bar").evaluate((bar) => {
      const rect = bar.getBoundingClientRect();
      const status = bar.querySelector(".mdbase-save-notice")!.getBoundingClientRect();
      return { gap: rect.right - status.right, width: status.width };
    });
    expect(notice.gap).toBeLessThan(25);
    expect(notice.width).toBeLessThan(90);
    expect(await page.locator(".visual-field-name input").first().evaluate((input) => getComputedStyle(input).fontFamily)).toContain("Atkinson");
    const options = page.getByRole("button", { name: "title field options" });
    await options.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Remove title field" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    await page.getByRole("textbox", { name: "title field name" }).fill("summary");
    await page.getByRole("heading", { name: "Fields", exact: true }).click();
    await expect(page.getByRole("button", { name: "Review changes" })).toBeEnabled();
    await expect(page.locator(".type-inspector")).toHaveJSProperty("scrollWidth", await page.locator(".type-inspector").evaluate((element) => element.clientWidth));
  });
}

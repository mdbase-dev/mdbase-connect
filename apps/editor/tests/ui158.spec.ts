import { expect, test } from "@playwright/test";

test("published tooltips describe icon actions without taking over their controls", async ({ page }) => {
  await page.goto("?demo=40");
  await expect(page.locator(".title-input")).toBeVisible();
  const tooltip = page.getByRole("tooltip");
  const create = page.getByRole("button", { name: "New note", exact: true });
  await create.hover();
  await expect(tooltip).toHaveText("New note");
  await expect(create).toHaveAttribute("aria-keyshortcuts", "C Control+Shift+N Meta+Shift+N");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Tab");
  const properties = page.getByRole("button", { name: "Note properties", exact: true });
  await properties.focus();
  await expect(tooltip).toHaveText("Note properties");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Note properties" })).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await properties.click();
  const more = page.getByRole("button", { name: "More note actions", exact: true });
  await more.focus();
  await expect(tooltip).toHaveText("More note actions");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "More note actions" })).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCreate = page.getByRole("button", { name: "New note", exact: true });
  await mobileCreate.hover();
  await expect(tooltip).toContainText("New note");
  await mobileCreate.click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeFocused();
  await expect(tooltip).toHaveCount(0);
});

test("the focused note supplies context through quick-open results, not search ranking", async ({ page }) => {
  await page.goto("?demo=40");
  const list = page.getByRole("listbox", { name: "Collection notes and files" });
  await expect(list).toBeFocused();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  const title = await list.locator(".list-focused .note-title").innerText();
  await expect(page.locator(".title-input")).toHaveValue(title);
  await page.keyboard.press("Control+p");
  const input = page.getByRole("combobox", { name: "Find a note or action" });
  const results = page.locator(".mdbase-command-results");
  await expect(results.locator(".mdbase-command-group").first()).toHaveText(title);
  await expect(results.getByRole("option").first().locator("strong")).toHaveText(title);
  await input.fill(title);
  await expect(results.locator(".mdbase-command-group").first()).toHaveText("Notes");
  await input.fill(">");
  await expect(results.locator(".mdbase-command-group").first()).toHaveText(title);
  await expect(results.getByRole("option", { name: /^Rename/ })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`published nonempty palette height stays fixed and fits short viewports in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("?demo=40");
    await expect(page.locator(".note-scroll")).toBeFocused();
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox", { name: "Find a note or action" });
    const results = page.locator(".mdbase-command-results");
    await expect(results).toHaveCSS("height", "380px");
    await expect.poll(async () => (await results.boundingBox())!.height).toBe(380);
    const fullHeight = 380;
    await input.fill(">Shortcuts");
    await expect(results.getByRole("option")).toHaveCount(1);
    await expect.poll(async () => (await results.boundingBox())!.height).toBe(fullHeight);
    await input.fill(">no-such-action-158");
    await expect(results.getByRole("option")).toHaveCount(0);
    expect((await results.boundingBox())!.height).toBeLessThan(fullHeight);
    await input.fill(">");
    await page.setViewportSize({ width: 844, height: 390 });
    for (let step = 0; step < 30; step++) await input.press("ArrowDown");
    await expect(input).toBeInViewport({ ratio: 1 });
    const activeId = await input.getAttribute("aria-activedescendant");
    await expect(page.locator(`[id="${activeId}"]`)).toBeInViewport({ ratio: 1 });
    const dialog = page.getByRole("dialog", { name: "Quick open", exact: true });
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(390);
  });
}

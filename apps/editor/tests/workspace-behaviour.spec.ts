import { expect, test } from "@playwright/test";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  for (const width of [1920, 1600, 1440]) {
    test(`desktop inspector docks without covering text at ${width}px (${reducedMotion})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("?demo=300");
      await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const settle = () => expect.poll(() => page.locator(".app-shell").evaluate(el => el.getAnimations().length)).toBe(0);
      const measure = () => page.locator(".writing-surface").evaluate(el => {
        const title = el.querySelector(".title-input")!.getBoundingClientRect();
        const line = el.querySelector(".cm-line")!.getBoundingClientRect();
        const pane = el.closest(".editor-pane")!.getBoundingClientRect();
        return { left: title.left, right: title.right, width: title.width, lineHeight: line.height, paneWidth: pane.width, paneRight: pane.right };
      });
      const before = await measure();
      expect(before.width).toBe(760);
      await page.getByRole("button", { name: "Note properties", exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Note properties" });
      await expect(panel.getByRole("button", { name: "Close properties" })).toBeVisible();
      await settle();
      expect(await page.locator(".app-shell").evaluate(el => getComputedStyle(el).transitionDuration)).toBe(reducedMotion === "reduce" ? "0s" : "0.24s");
      const after = await measure();
      const panelLeft = (await panel.boundingBox())!.x;
      expect(after.paneWidth).toBeLessThan(before.paneWidth);
      expect(after.paneRight).toBeCloseTo(panelLeft, 0);
      expect(after.right).toBeLessThanOrEqual(panelLeft);
      expect(after.left).toBeLessThan(before.left);
      if (width >= 1600) {
        expect(after.width).toBe(760);
        expect(after.lineHeight).toBe(before.lineHeight);
      } else {
        expect(after.paneWidth).toBeLessThan(760);
        expect(after.width).toBeLessThan(760);
      }
      await expect(page.getByRole("dialog", { name: "Note properties" })).toHaveCount(0);
      await expect(page.locator(".inspector-scrim")).toHaveCount(0);
      const handle = page.getByRole("separator", { name: "Resize note inspector" });
      await handle.focus();
      await page.keyboard.press("ArrowLeft");
      await settle();
      expect((await measure()).paneRight).toBeCloseTo((await panel.boundingBox())!.x, 0);
      if (width >= 1600) expect((await measure()).width).toBe(760);
      await panel.getByRole("button", { name: "Close properties" }).click();
      await settle();
      expect(await measure()).toEqual(before);
      await page.getByRole("button", { name: "Backlinks", exact: true }).click();
      await expect(page.getByRole("button", { name: "Close backlinks" })).toBeVisible();
      await settle();
      expect((await measure()).paneRight).toBeCloseTo((await page.getByRole("complementary", { name: "Backlinks" }).boundingBox())!.x, 0);
      if (width >= 1600) expect((await measure()).width).toBe(760);
    });
  }
}

for (const width of [900, 390]) {
  test(`narrow inspector has a scrim, traps focus and restores its trigger at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("?demo=12");
    await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toBeVisible();
    const trigger = width === 390 ? page.getByRole("button", { name: "More note actions" }) : page.getByRole("button", { name: "Note properties", exact: true });
    await trigger.click();
    if (width === 390) await page.getByRole("menuitem", { name: "Note properties" }).click();
    const dialog = page.getByRole("dialog", { name: "Note properties" });
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = dialog.getByRole("button", { name: "Close properties" });
    await expect(close).toBeFocused();
    expect(await page.locator("#root").evaluate(el => el.inert)).toBe(true);
    const scrim = page.locator(".inspector-scrim");
    expect(await scrim.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    if (width === 900) await page.mouse.click(10, 500);
    else await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.locator("#root").evaluate(el => el.inert)).toBe(false);
  });
}

test("quick open uses P inside and outside the writer; K only creates links", async ({ page }) => {
  await page.goto("?demo=12");
  const search = page.getByRole("textbox", { name: "Search notes and files" });
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await expect(body).toBeEditable();
  for (const target of [search, body]) {
    await target.focus();
    await page.keyboard.press("Control+p");
    await expect(page.getByRole("dialog", { name: "Quick open" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(target).toBeFocused();
  }
  await search.focus();
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Quick open" })).toHaveCount(0);
  await body.fill("");
  await body.focus();
  await page.keyboard.press("Control+k");
  await expect(body).toContainText("[link](https://)");
  await expect(page.getByRole("dialog", { name: "Quick open" })).toHaveCount(0);
});

test("middle truncates long paths on mobile and keeps in-place rename available", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toBeVisible();
  const path = "Notes/A very long directory name/Another long directory name/Visible filename.md";
  await page.getByTitle("Rename Markdown path").click();
  await page.getByRole("textbox", { name: "Markdown path" }).fill(path);
  await page.getByRole("textbox", { name: "Markdown path" }).press("Enter");
  await page.getByRole("button", { name: "Rename only", exact: true }).click();
  await expect(page.getByTitle("Rename Markdown path")).toHaveAccessibleName(path);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePath = page.locator(".mobile-note-path");
  await expect(mobilePath).toBeVisible();
  await expect(mobilePath).toHaveText(path);
  const filename = mobilePath.locator(".path-filename");
  const bounds = await filename.evaluate(el => {
    const r = el.getBoundingClientRect();
    const path = el.closest("p")!.getBoundingClientRect();
    return { visible: r.left >= path.left && r.right <= path.right, clipped: el.scrollWidth > el.clientWidth };
  });
  expect(bounds).toEqual({ visible: true, clipped: false });
  expect(await mobilePath.locator(".path-directory").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "More note actions" }).click();
  await page.getByRole("menuitem", { name: "Rename path" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown path" })).toHaveValue(path);
});

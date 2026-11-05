import { test, expect } from "@playwright/test";

for (const theme of ["light", "dark"] as const) for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test.describe(`${theme} ${reducedMotion}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion });

    test("peek endings keep one current note and delete preserves the cursor", async ({ page }) => {
      await page.goto("?demo=40");
      const list = page.locator(".note-scroll");
      await expect(list).toBeFocused();
      const original = await list.locator('[aria-selected="true"] .note-title').innerText();
      const body = page.locator(".code-editor-writer .cm-content");
      await expect(body).toBeVisible();
      for (const ending of ["Escape", "close", "body"]) {
        await list.focus();
        await page.keyboard.press("Space");
        await page.keyboard.press("j");
        await expect(page.locator(".note-peek")).toHaveAccessibleName("Garden notes 2");
        if (ending === "Escape") await page.keyboard.press("Escape");
        else if (ending === "close") await page.getByRole("button", { name: "Close note peek" }).click();
        else await body.click();
        await expect(page.locator(".note-peek")).toHaveCount(0);
        await expect(list.locator('[aria-selected="true"] .note-title')).toHaveText(original);
      }
      await list.focus();
      await page.keyboard.press("Escape");
      await expect(list.locator('[aria-selected="true"] .note-title')).toHaveText(original);
      await page.keyboard.press("Space");
      await page.keyboard.press("j");
      await page.keyboard.press("Control+Backspace");
      await expect(page.getByRole("status").filter({ hasText: "Deleted Garden notes 2" })).toBeVisible();
      await expect(list).toBeFocused();
      await expect(list.locator('[aria-selected="true"] .note-title')).toHaveText(original);
      await page.keyboard.press("Space");
      await page.keyboard.press("j");
      await page.keyboard.press("Enter");
      await expect(body).toBeFocused();
      await expect(page.locator(".title-input")).toHaveValue("A quiet interface 3");
    });

    test("search returns to results and focus decoration follows keyboard use", async ({ page }, testInfo) => {
      await page.goto("?demo=40");
      const list = page.locator(".note-scroll");
      await expect(list).toBeFocused();
      const selected = list.locator(".note-row.selected");
      await expect(selected).toHaveCSS("outline-style", "none");
      await expect(selected).toHaveCSS("background-color", await selected.evaluate((row) => {
        const probe = document.createElement("span"); probe.style.background = "var(--accent-soft)"; row.append(probe);
        const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color;
      }));
      await page.keyboard.press("/");
      const search = page.getByRole("combobox", { name: "Search notes and files" });
      await search.fill("garden");
      await expect(list.locator(".note-title").first()).toContainText("Garden");
      const firstGarden = await list.locator(".note-title").first().innerText();
      await page.keyboard.press("ArrowDown");
      await expect(list).toBeFocused();
      await expect(list.locator(".note-row.list-focused")).toContainText(firstGarden);
      await expect(list.locator(".note-row.list-focused")).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("/");
      await expect(search).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("");
      await expect(search).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(list).toBeFocused();
      await page.keyboard.press("j");
      await expect(search).toHaveValue("");
      await page.keyboard.press("/");
      await search.fill("quiet");
      await expect(list.locator(".note-title").first()).toContainText("quiet");
      const firstQuiet = await list.locator(".note-title").first().innerText();
      await page.keyboard.press("Enter");
      await expect(list).toBeFocused();
      await expect(list.locator(".note-row.list-focused")).toContainText(firstQuiet);
      await page.getByRole("button", { name: "View options", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu", { name: "Note view options" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "View options", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(list).toBeFocused();
      await expect(list.locator(".note-row.list-focused")).toHaveCSS("outline-style", "solid");
      await page.screenshot({ path: testInfo.outputPath("keyboard-list.png") });
    });

    test("help fits and capture shares the note measure", async ({ page }, testInfo) => {
      await page.goto("?demo=40");
      const list = page.locator(".note-scroll");
      await expect(list).toBeFocused();
      const title = page.locator(".title-input");
      await expect(title).toBeVisible();
      const noteX = (await title.boundingBox())!.x;
      await page.keyboard.press("?");
      const dialog = page.getByRole("dialog", { name: "Shortcuts", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Alt+←");
      const fits = await dialog.evaluate((element) => {
        const body = element.querySelector(".mdbase-dialog-body")!;
        const bounds = body.getBoundingClientRect();
        return body.scrollHeight <= body.clientHeight + 1 && [...body.querySelectorAll("kbd")].every((key) => key.getBoundingClientRect().bottom <= Math.min(bounds.bottom, innerHeight));
      });
      expect(fits).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("shortcuts.png") });
      await page.keyboard.press("Escape");
      await page.keyboard.press("c");
      const composer = page.locator(".new-note-composer");
      const captureTitle = composer.getByRole("textbox", { name: "Title", exact: true });
      await expect(captureTitle).toBeVisible();
      expect(Math.abs((await captureTitle.boundingBox())!.x - noteX)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("composer.png") });
    });
  });
}

test("phone HTML and loading shell include search; touch opens without body focus", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.route("**/assets/*.js", (route) => route.abort());
    await page.goto("?demo=40");
    await expect(page.locator(".editor-opening .list-header")).toBeVisible();
    await expect(page.locator(".editor-opening .search-field")).toBeVisible();
    await expect(page.locator(".opening-list-skeleton span")).toHaveCount(6);
    await page.screenshot({ path: testInfo.outputPath("phone-first-frame.png") });
    await page.unroute("**/assets/*.js");
    await page.goto("?demo=40");
    await page.getByRole("button", { name: "Back to notes" }).tap();
    await expect(page.locator(".note-row").first()).toBeVisible();
    await page.locator(".note-row").nth(1).tap();
    const body = page.locator(".code-editor-writer .cm-content");
    await expect(body).toBeVisible();
    await expect(body).not.toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("phone-touch-reading.png") });
  } finally { await context.close(); }
});

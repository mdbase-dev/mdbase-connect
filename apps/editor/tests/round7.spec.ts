import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme, viewport: { width: 1440, height: 900 } });

    test("shared palette and help retain package keyboard behavior", async ({ page }) => {
      await page.goto("?demo=40");
      await expect(page.locator(".note-scroll")).toBeFocused();
      await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: "Shortcuts", exact: true });
      await expect(help.locator(".mdbase-dialog-body")).toBeVisible();
      await expect(help).not.toContainText(/ArrowDown|ArrowUp|ContextMenu/);
      await expect(help.locator("kbd").filter({ hasText: /^Menu$/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      const input = page.getByRole("combobox", { name: "Find a note or action" });
      await expect(input).toBeFocused();
      await input.fill(">");
      await page.keyboard.press("End");
      const active = page.locator(`[id="${await input.getAttribute("aria-activedescendant")}"]`);
      await expect(active).toBeInViewport();
      await expect(page.locator(".mdbase-command-results")).toHaveCSS("transition-duration", "0s");
    });

    test("search returns to the visible open note, then steps from it", async ({ page }, testInfo) => {
      await page.goto("?demo=300");
      const list = page.getByRole("listbox", { name: "Collection notes and files" });
      await expect(list).toBeFocused();
      await page.keyboard.press("/");
      const search = page.getByRole("combobox", { name: "Search notes and files" });
      await expect(search).toBeFocused();
      await search.fill("garden");
      await expect(list.locator(".note-title").first()).toContainText("Garden");
      await page.keyboard.press("ArrowDown");
      await expect(list).toBeFocused();
      for (let step = 0; step < 8; step++) await page.keyboard.press("j");
      const title = await list.locator(".list-focused .note-title").innerText();
      await expect(page.locator(".title-input")).toHaveValue(title);
      await page.keyboard.press("/");
      await expect(search).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(list).toBeFocused();
      const cursor = list.locator(".note-row.list-focused");
      await expect(cursor).toContainText(title);
      await expect(cursor).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => cursor.evaluate((row) => {
        const rowBounds = row.getBoundingClientRect();
        const listBounds = row.closest(".note-scroll")!.getBoundingClientRect();
        return Math.min(rowBounds.top - listBounds.top, listBounds.bottom - rowBounds.bottom);
      })).toBeGreaterThanOrEqual(0);
      await expect(list).toHaveCSS("outline-style", "none");
      await page.screenshot({ path: testInfo.outputPath("search-return.png") });
      const cursorId = await cursor.getAttribute("id");
      await page.keyboard.press("j");
      await expect(cursor).not.toHaveAttribute("id", cursorId!);
      await expect(page.locator(".title-input")).toHaveValue(await cursor.locator(".note-title").innerText());
    });

    test("palette attachment uses the existing file picker and upload", async ({ page }) => {
      await page.goto("?demo=40");
      await expect(page.locator(".title-input")).toBeVisible();
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "Find a note or action" }).fill(">Attach file");
      const picker = page.waitForEvent("filechooser");
      await page.getByRole("option", { name: /Attach file…/ }).click();
      await (await picker).setFiles({ name: "round-seven.txt", mimeType: "text/plain", buffer: Buffer.from("Round seven attachment") });
      await expect(page.locator(".code-editor-writer .cm-content")).toContainText("round-seven.txt");
    });

    test("phone initial HTML has the toolbar, header and note-row rhythm", async ({ browser }, testInfo) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme, isMobile: true, hasTouch: true });
      try {
        const page = await context.newPage();
        await page.route("**/assets/*.js", (route) => route.abort());
        await page.goto("?demo=40");
        const opening = page.locator(".editor-opening");
        await expect(opening.locator("h1")).toHaveText("All notes");
        for (const label of ["Back to notes", "New note", "More note actions"]) {
          const button = opening.locator(`button[aria-label="${label}"]`);
          await expect(button).toBeVisible();
          await expect(button).toBeDisabled();
          const bounds = (await button.boundingBox())!;
          expect(bounds.width).toBeGreaterThanOrEqual(44);
          expect(bounds.height).toBeGreaterThanOrEqual(44);
        }
        await expect(opening.locator(".search-field")).toBeVisible();
        const bars = opening.locator(".opening-list-skeleton span");
        await expect(bars).toHaveCount(6);
        const positions = await bars.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
        for (let index = 1; index < positions.length; index++) expect(positions[index] - positions[index - 1]).toBe(76);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath("phone-first-frame.png") });
        await page.unroute("**/assets/*.js");
        await page.goto("?demo=40&delay=3000");
        await expect(page.getByRole("main", { name: "Opening collection" })).toHaveAttribute("aria-busy", "true");
        await expect(opening.getByRole("heading", { name: "All notes" })).toBeVisible();
        for (const label of ["Back to notes", "New note", "More note actions"]) await expect(opening.getByRole("button", { name: label, exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("phone-loading-frame.png") });
        await expect(opening).toHaveCount(0);
      } finally { await context.close(); }
    });
  });
}

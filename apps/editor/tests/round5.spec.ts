import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) for (const motion of ["no-preference", "reduce"] as const) {
  test.describe(`W18 ${width} ${theme} ${motion}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, colorScheme: theme, reducedMotion: motion });

    test("reaches list commands without editing on arrival and preserves explicit writing", async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: motion });
      await page.goto("?demo=40");
      const body = page.getByRole("textbox", { name: "Note body", exact: true });
      await expect(body).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const original = await body.innerText();
      await expect(body).not.toBeFocused();
      const list = page.locator(".note-scroll");
      if (width === 1440) {
        await expect(list).toBeFocused();
        await page.keyboard.press("j");
        await page.keyboard.press("k");
        await expect(body).toHaveText(original, { useInnerText: true });
      }
      await page.keyboard.press("g"); await page.keyboard.press("t");
      await expect(page.getByRole("heading", { name: "Types", exact: true })).toBeVisible();
      await page.keyboard.press("g"); await page.keyboard.press("n");
      await expect(list).toBeFocused();
      await page.keyboard.press("/");
      await expect(page.getByRole("combobox", { name: "Search notes and files" })).toBeFocused();
      await list.focus(); await page.keyboard.press("c");
      await expect(page.locator(".new-note-composer")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".new-note-composer")).toHaveCount(0);
      await expect(list).toBeFocused();
      await page.keyboard.press("c");
      await page.getByRole("textbox", { name: "Title", exact: true }).fill("Keep this draft");
      await page.keyboard.press("Escape");
      await expect(page.locator(".new-note-composer")).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Discard note", exact: true }).click();
      await expect(list).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(body).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(list).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("list-focus.png") });
    });

    test("previews readable references without moving the main pane and commits with Enter", async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: motion });
      await page.goto("?demo=40");
      const body = page.locator(".code-editor-writer .cm-content");
      await expect(body).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const original = (await body.textContent())!;
      const list = page.locator(".note-scroll");
      await page.keyboard.press("g"); await page.keyboard.press("n");
      await expect(list).toBeFocused();
      await page.keyboard.press("Space");
      const peek = page.locator(".note-peek");
      await expect(peek).toBeVisible();
      await expect(peek).not.toContainText("![[");
      await expect(peek).not.toContainText("[[Notes/");
      await expect(peek.locator(".read-only-markdown")).toBeVisible();
      await expect.poll(() => peek.locator(".note-peek-pages").evaluate(element => element.getAnimations().length)).toBe(0);
      const height = await peek.evaluate(element => element.getBoundingClientRect().height);
      await peek.evaluate(element => {
        const heights: number[] = [];
        const record = () => { heights.push(element.getBoundingClientRect().height); if (heights.length < 24) requestAnimationFrame(record); };
        requestAnimationFrame(record);
        element.setAttribute("data-heights", "");
        setTimeout(() => element.setAttribute("data-heights", JSON.stringify(heights)), 450);
      });
      await page.keyboard.press("j");
      await expect(peek).toHaveAccessibleName("Garden notes 2");
      await expect(peek).toHaveAttribute("data-heights", /\[/);
      const heights: number[] = JSON.parse((await peek.getAttribute("data-heights"))!);
      const settled = await peek.evaluate(element => element.getBoundingClientRect().height);
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(Math.min(height, settled) - 1);
      expect(Math.max(...heights)).toBeLessThanOrEqual(Math.max(height, settled) + 1);
      const tween = await peek.locator(".note-peek-pages").evaluate(element => getComputedStyle(element).transitionDuration);
      expect(tween).toBe(motion === "reduce" ? "0s" : "0.12s");
      const contentFits = await peek.locator(".note-peek-pages").evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll(".note-peek-body:not(.is-outgoing) p")].every(paragraph => {
          const content = paragraph.getBoundingClientRect();
          return content.top >= bounds.top - 1 && content.bottom <= bounds.bottom + 1;
        });
      });
      expect(contentFits).toBe(true);
      await expect(body).toHaveText(original);
      await page.screenshot({ path: testInfo.outputPath("peek.png") });
      await page.keyboard.press("Enter");
      await expect(peek).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Note title", exact: true })).toHaveValue("Garden notes 2");
      await expect(body).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(list).toBeFocused();
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "Find a note or action" }).fill(">rename");
      const hint = page.locator(".mdbase-command-results kbd");
      if (width === 390) await expect(hint).toBeHidden();
      else await expect(hint).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("palette.png") });
    });
  });
}

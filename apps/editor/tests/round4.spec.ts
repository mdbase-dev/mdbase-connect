import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) for (const motion of ["no-preference", "reduce"] as const) {
  test.describe(`W12 ${width} ${theme} ${motion}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, colorScheme: theme, reducedMotion: motion });

    test("uses one keyboard vocabulary, named peek and shared shortcut hints", async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: motion });
      await page.goto("?demo=40");
      const body = page.getByRole("textbox", { name: "Note body", exact: true });
      await expect(body).toBeVisible();
      if (width === 390) {
        await expect(page.locator(".editor-bar").getByRole("button", { name: "New note", exact: true })).toBeVisible();
        await page.locator(".editor-bar").getByRole("button", { name: "New note", exact: true }).click();
        await expect(page.locator(".note-unsaved")).toBeVisible();
        await page.getByRole("button", { name: "Back to notes", exact: true }).click();
        await expect(page.locator(".note-unsaved")).toHaveCount(0);
      }
      const list = page.locator(".note-scroll");
      await list.focus();
      await page.keyboard.press("/");
      await expect(page.getByRole("combobox", { name: "Search notes and files" })).toBeFocused();
      await page.keyboard.type("gtscx");
      await expect(page.getByRole("combobox", { name: "Search notes and files" })).toHaveValue("gtscx");
      await page.getByRole("combobox", { name: "Search notes and files" }).fill("");
      await expect(page.locator(".list-header p")).toHaveText("40 notes · 2 files");
      await list.click({ position: { x: 20, y: 10 } });
      await expect(list).toBeFocused();
      await page.keyboard.press("g"); await page.keyboard.press("t");
      await expect(page.locator(".app-shell")).toHaveClass(/surface-types/);
      await page.keyboard.press("g"); await page.keyboard.press("s");
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
      await page.keyboard.press("g"); await page.keyboard.press("n");
      await expect(list).toBeVisible();
      await list.focus(); await page.keyboard.press("c");
      await expect(page.locator(".note-unsaved")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".note-unsaved")).toHaveCount(0);
      await expect(list).toBeVisible();
      await list.focus();
      await page.keyboard.press("x");
      await expect(page.getByRole("group", { name: "Selected notes" })).toHaveCount(0);
      await page.keyboard.press("Space");
      const peek = page.locator(".note-peek");
      await expect(peek).toBeVisible();
      await expect(peek).toHaveAccessibleName("The shape of useful tools");
      const timing = await peek.evaluate(element => getComputedStyle(element).transitionDuration);
      expect(timing).toBe(motion === "reduce" ? "0s" : "0.12s");
      await peek.evaluate(element => {
        const observer = new MutationObserver(() => {
          const outgoing = element.querySelector(".is-outgoing");
          const incoming = element.querySelector(".note-peek-body:not(.is-outgoing)");
          if (!outgoing || !incoming) return;
          observer.disconnect();
          element.setAttribute("data-crossfade-frame", JSON.stringify({ text: outgoing.textContent, animation: getComputedStyle(outgoing).animationName, incoming: getComputedStyle(incoming).animationName, hidden: getComputedStyle(outgoing).display === "none" }));
        });
        observer.observe(element, { childList: true, subtree: true });
      });
      await page.keyboard.press("j");
      await expect(peek).toHaveAttribute("data-crossfade-frame", /Good tools/);
      const crossfade = JSON.parse((await peek.getAttribute("data-crossfade-frame"))!);
      expect(crossfade.text).toContain("Good tools");
      expect(crossfade.animation).toBe(motion === "reduce" ? "none" : "peek-body-out");
      expect(crossfade.incoming).toBe(motion === "reduce" ? "none" : "peek-body-in");
      expect(crossfade.hidden).toBe(motion === "reduce");
      await expect(peek).toHaveAccessibleName("Garden notes 2");
      await expect(peek.locator("h2")).toHaveAttribute("aria-live", "polite");
      await page.screenshot({ path: testInfo.outputPath("peek.png") });
      await page.keyboard.press("Escape");
      await expect(peek).toHaveCount(0);
      await expect(list).toBeFocused();
      await page.keyboard.press("Control+k");
      const search = page.getByRole("combobox", { name: "Find a note or action" });
      await expect(search).toHaveValue(">");
      await search.fill(">rename");
      await expect(page.locator(".mdbase-command-results mark")).toHaveText("Rename");
      await expect(search).toHaveCSS("outline-style", "none");
      await expect(page.locator(".mdbase-command-results kbd")).toHaveText("R");
      await page.screenshot({ path: testInfo.outputPath("palette.png") });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Quick open", exact: true })).toHaveCount(0);
      await list.focus(); await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: "Shortcuts", exact: true });
      for (const group of ["Navigate", "Note", "Text"]) await expect(help.getByRole("heading", { name: group, exact: true })).toBeVisible();
      await expect(help.getByText("Ctrl+K", { exact: true })).toHaveCount(1);
      await expect(help.getByText("Ctrl+Backspace", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("help.png") });
    });

    test("paints the phone shell before scripts and keeps recovery honest", async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: motion });
      await page.route("**/assets/*.js", async route => {
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.continue();
      });
      await page.goto("?demo=4", { waitUntil: "commit" });
      await expect(page.locator(".opening-list-skeleton").first()).toBeVisible();
      await expect(page.locator(".editor-opening .list-header").first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("opening.png") });
      await page.waitForLoadState("networkidle");
      await page.unrouteAll({ behavior: "wait" });
      await page.goto("?server=http://127.0.0.1:4815&collection=hosted-0");
      const link = page.getByRole("link", { name: "Back to mdbase Connect" });
      await expect(link).toBeVisible();
      await expect(page.getByText("Connect server: http://127.0.0.1:4815", { exact: true })).toBeVisible();
      await expect(link).toHaveCSS("margin-top", "16px");
      await expect(page.locator(".note-row")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("recovery.png") });
    });
  });
}

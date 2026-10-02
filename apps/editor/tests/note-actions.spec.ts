import { expect, test } from "@playwright/test";

test("note menus move with links, delete immediately, restore, and filter by tag/type", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.getByRole("textbox", { name: "Note body" })).toBeVisible();
  const list = page.getByRole("listbox", { name: "Collection notes and files" });
  await list.focus();
  await page.keyboard.press("Shift+F10");
  const rowMenu = page.getByRole("menu", { name: /note actions$/ });
  await expect(rowMenu).toBeVisible();
  await rowMenu.getByRole("menuitem", { name: "Move to…" }).click();
  const move = page.getByRole("dialog", { name: "Move note" });
  await move.getByRole("combobox", { name: "Destination folder" }).click();
  await page.getByRole("option", { name: "Projects", exact: true }).click();
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("button", { name: "Projects/the-shape-of-useful-tools.md" })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Notes/the-shape-of-useful-tools.md" })).toBeVisible();
  await list.focus();
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("option", { name: /The shape of useful tools/ })).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("option", { name: /The shape of useful tools/ })).toBeVisible();
  const search = page.getByRole("combobox", { name: "Search notes and files" });
  await search.fill("#ideas");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "#ideas" })).toBeVisible();
  await page.getByRole("button", { name: "Remove tag filter ideas" }).click();
  await search.fill("type:note");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "note", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove type filter note" }).click();
  await expect(page.getByRole("heading", { name: "All notes", exact: true })).toBeVisible();
});

for (const [theme, width, height] of [["light", 1440, 1000], ["dark", 1440, 1000], ["light", 390, 844]] as const) {
  test(`all note row variants fit their fixed height in ${theme} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript((theme) => localStorage.setItem("mdbase:theme", theme), theme);
    await page.goto("?demo=300");
    await expect(page.getByRole("textbox", { name: "Note body" })).toBeVisible();
    if (width === 390) await page.getByRole("button", { name: "Back to notes" }).click();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.note-row .note-type-badge').first()).toBeVisible();

    const assertFit = async () => {
      const rows = await page.locator(".note-row").evaluateAll((rows) => rows.map((row) => {
        const bounds = row.getBoundingClientRect();
        const children = [...row.children].map((child) => {
          const box = child.getBoundingClientRect();
          const lineHeight = Number.parseFloat(getComputedStyle(child).lineHeight);
          return { contained: box.top >= bounds.top && box.bottom <= bounds.bottom, fullLine: Number.isNaN(lineHeight) || box.height >= lineHeight - 0.1 };
        });
        return { height: bounds.height, children };
      }));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.height).toBe(76);
        for (const child of row.children) {
          expect(child.contained).toBe(true);
          expect(child.fullLine).toBe(true);
        }
      }
    };
    await assertFit();
    await page.screenshot({ path: test.info().outputPath(`row-fit-${theme}-${width}.png`) });

    // Exercise the same CSS with no excerpt, pending/error status and a long type
    // label; these are reachable variants whose remote timing is nondeterministic.
    await page.evaluate(() => {
      const source = document.querySelector('.note-row:has(.note-type-badge)')!;
      for (const variant of ["no-excerpt", "busy", "error", "long-type"]) {
        const wrapper = document.createElement("div");
        wrapper.className = "note-row-context row-fit-fixture";
        wrapper.style.cssText = "position:relative;height:76px;";
        const row = source.cloneNode(true) as HTMLElement;
        row.removeAttribute("id");
        if (variant === "no-excerpt") row.querySelector(".note-excerpt")?.remove();
        if (variant === "busy" || variant === "error") {
          row.querySelector(".note-detail")!.className = "note-transition";
          row.querySelector(".note-transition")!.textContent = variant === "busy" ? "Opening" : "Needs attention";
        }
        if (variant === "long-type") row.querySelector(".note-type-badge")!.textContent = "A long declared type name";
        wrapper.append(row);
        document.querySelector(".note-scroll")!.append(wrapper);
      }
    });
    await assertFit();
    await page.locator(".row-fit-fixture").evaluateAll((rows) => rows.forEach((row) => row.remove()));
    await page.getByRole("combobox", { name: "Search notes and files" }).fill("frontmatter.svg");
    await expect(page.locator(".file-row").first()).toBeVisible();
    await assertFit();
    await page.screenshot({ path: test.info().outputPath(`file-row-fit-${theme}-${width}.png`) });
  });
}

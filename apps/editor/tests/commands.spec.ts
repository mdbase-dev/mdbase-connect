import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`commands and persistent focus mode work with keyboard and touch at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("?demo=300");
    const body = page.getByRole("textbox", { name: "Note body", exact: true });
    await expect(body).toBeVisible();
    await body.focus();
    await page.keyboard.press("Control+Shift+P");
    const input = page.getByRole("combobox", { name: "Find a note or action" });
    await expect(input).toHaveValue(">");
    await input.fill(">fcs md");
    const focus = page.getByRole("option", { name: /Focus mode/ });
    await expect(focus.locator("kbd")).toHaveText("Ctrl Shift F");
    await input.press("Enter");
    await expect(page.locator(".app-shell")).toHaveClass(/focus-mode/);
    await expect(page.locator(".collection-rail, .note-list-pane, .properties-panel")).toHaveCount(0);
    await expect(page.locator(".editor-bar button:visible")).toHaveCount(2);
    await expect(body).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Exit focus mode", exact: true })).toBeVisible();
    await page.keyboard.press("Control+P");
    await expect(input).toHaveValue("");
    await input.fill(">");
    await expect(page.getByRole("option").first()).toContainText("Exit focus mode");
    await page.keyboard.press("Escape");
    await expect(page.locator(".app-shell")).toHaveClass(/focus-mode/);
    await body.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".app-shell")).not.toHaveClass(/focus-mode/);
    await page.keyboard.press("Control+Shift+F");
    await expect(page.getByRole("button", { name: "Exit focus mode", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Exit focus mode", exact: true }).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/focus-mode/);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("Control+Shift+F");
    await expect(page.locator(".app-shell")).toHaveCSS("transition-duration", "0s");
  });
}

test("unlinked mentions link the source occurrence and Undo restores it", async ({ page }) => {
  await page.goto("?demo=4");
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await expect(body).toBeVisible();
  await page.getByRole("option", { name: /Garden notes 2/ }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  await body.fill("I like the shape of useful tools. A plain-text mention.");
  await expect(page.locator(".editor-pane")).toHaveAttribute("data-save-state", "saved");
  await page.getByRole("option", { name: /The shape of useful tools/ }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
  const disclosure = page.getByText("Unlinked mentions (1)", { exact: true });
  await expect(disclosure.locator("..")).not.toHaveAttribute("open");
  await disclosure.click();
  await expect(page.locator(".unlinked-mention small")).toHaveText("I like the shape of useful tools. A plain-text mention.");
  await page.getByRole("button", { name: "Link mention in Garden notes 2" }).click();
  await expect(page.getByText("Unlinked mentions (0)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Unlinked mentions (1)", { exact: true })).toBeVisible();
});

test("unlinked mentions stay below visible body text, use plain highlighted snippets, and cap their disclosure", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("?demo=10");
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await expect(body).toBeVisible();
  const open = async (title: string) => {
    await page.keyboard.press("Control+P");
    const input = page.getByRole("combobox", { name: "Find a note or action" });
    await input.fill(title); await input.press("Enter");
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title);
  };
  for (const title of ["Garden notes 2", "A quiet interface 3", "Reading list 4", "Ideas for Sunday 5", "Release notes 6", "Questions worth keeping 7"]) {
    await open(title);
    await body.fill("I keep **the shape of useful tools** beside [my notes](https://example.org).");
    await expect(page.locator(".editor-pane")).toHaveAttribute("data-save-state", "saved");
  }
  await open("The shape of useful tools");
  await body.fill("Body text stays above linked references.\n\nThe last paragraph is still visible before Linked from.");
  await expect(page.locator(".editor-pane")).toHaveAttribute("data-save-state", "saved");
  const scroller = page.locator(".body-editor .cm-scroller");
  const summary = page.getByText("Unlinked mentions (6)", { exact: true });
  await expect(summary).toBeInViewport();
  const before = await scroller.evaluate((element) => element.scrollTop);
  await summary.click();
  await expect(page.locator(".unlinked-mention")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Show all 6", exact: true })).toBeVisible();
  await expect(page.locator(".unlinked-mention mark")).toHaveCount(5);
  await expect(page.locator(".unlinked-mention small").first()).toHaveText("I keep the shape of useful tools beside my notes.");
  await expect(page.locator(".unlinked-mentions summary")).toHaveCSS("list-style-type", "none");
  await expect(page.locator(".unlinked-mentions summary svg")).toBeVisible();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before);
  const positions = await scroller.evaluate((element) => {
    const content = element.querySelector(".cm-content")!;
    const footer = element.querySelector(".note-footer")!;
    return { ordered: Boolean(content.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING), bodyBottom: content.getBoundingClientRect().bottom, footerTop: footer.getBoundingClientRect().top };
  });
  expect(positions.ordered).toBe(true);
  expect(positions.bodyBottom).toBeLessThanOrEqual(positions.footerTop);
  await expect(page.getByText("The last paragraph is still visible before Linked from.", { exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("mentions-body-before-footer.png") });
  await page.getByRole("button", { name: "Show all 6", exact: true }).click();
  await expect(page.locator(".unlinked-mention")).toHaveCount(6);
  await page.getByRole("button", { name: "Show fewer", exact: true }).click();
  await expect(page.locator(".unlinked-mention")).toHaveCount(5);
});

test("selection commands reuse bulk forms, moves and deletion Undo", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toBeVisible();
  await page.getByRole("option", { name: /Garden notes 2/ }).click({ modifiers: ["Control"] });
  await expect(page.getByRole("group", { name: "Selected notes" })).toContainText("2 selected");
  const command = async (query: string) => {
    await page.keyboard.press("Control+Shift+P");
    const input = page.getByRole("combobox", { name: "Find a note or action" });
    await input.fill(`>${query}`); await input.press("Enter");
  };
  await command("add tag");
  await page.getByRole("textbox", { name: "Tag", exact: true }).fill("command-test");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Updated 2 notes.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Restored selected notes.", { exact: true })).toBeVisible();
  await command("move selected");
  await expect(page.getByRole("dialog", { name: "Move 2 notes" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await command("delete selected");
  await expect(page.getByText("Deleted 2 notes.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("option", { name: /Garden notes 2/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /The shape of useful tools/ })).toBeVisible();
});

test("typewriter scrolling centres the caret and stays opt-in", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mdbase-editor:preferences", JSON.stringify({ focusMode: true, typewriterScrolling: true })));
  await page.goto("?demo=4");
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await expect(body).toBeVisible();
  await body.fill(Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n"));
  await body.focus();
  await page.keyboard.press("Control+End");
  await expect.poll(async () => {
    const scroller = await page.locator(".body-editor .cm-scroller").boundingBox();
    // The writer uses the native caret, not CodeMirror's optional drawn cursor.
    const line = await page.locator(".body-editor .cm-line").filter({ hasText: /^Line 40$/ }).boundingBox();
    return Math.abs(line!.y + line!.height / 2 - (scroller!.y + scroller!.height / 2));
  }).toBeLessThan(20);
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-shell")).not.toHaveClass(/typewriter-mode/);
});

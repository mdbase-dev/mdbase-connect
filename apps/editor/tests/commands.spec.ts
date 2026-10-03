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
  await expect(page.getByText("I like the shape of useful tools. A plain-text mention.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Link mention in Garden notes 2" }).click();
  await expect(page.getByText("Unlinked mentions (0)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Unlinked mentions (1)", { exact: true })).toBeVisible();
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

import { expect, test } from "@playwright/test";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`opening and resizing Properties leaves the writing column and scroll stable (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("?demo=300");
    const body = page.getByRole("textbox", { name: "Note body", exact: true });
    await body.fill(Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: A calm and steady writing column.`).join("\n\n"));
    await expect(page.getByRole("main", { name: "Note editor" })).toHaveAttribute("data-save-state", "saved");
    // Finish the writer's caret reveal before establishing a manually scrolled
    // viewport. Otherwise a delayed CodeMirror measure can race this fixture.
    await page.getByRole("button", { name: "Note properties", exact: true }).focus();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.locator(".body-editor .cm-scroller").evaluate(el => { el.scrollTop = 500; });
    // CodeMirror refines estimated offscreen line heights after a scroll.
    // Compare panel geometry only once that independent measurement settles.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const measure = () => page.locator(".writing-surface").evaluate(el => {
      const title = el.querySelector(".title-input")!.getBoundingClientRect();
      const scroller = el.querySelector(".cm-scroller")!;
      return { left: title.left, width: title.width, scrollTop: scroller.scrollTop };
    });
    const before = await measure();
    await page.getByRole("button", { name: "Note properties", exact: true }).click();
    await expect(page.getByRole("button", { name: "Close properties" })).toBeVisible();
    expect(await measure()).toEqual(before);
    const handle = page.getByRole("separator", { name: "Resize note inspector" });
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await measure()).toEqual(before);
    await page.getByRole("button", { name: "Close properties" }).click();
    expect(await measure()).toEqual(before);
    await page.getByRole("button", { name: "Backlinks", exact: true }).click();
    await expect(page.getByRole("button", { name: "Close backlinks" })).toBeVisible();
    expect(await measure()).toEqual(before);
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
  const filename = page.locator(".path-button .path-filename");
  const bounds = await filename.evaluate(el => {
    const r = el.getBoundingClientRect();
    const button = el.closest("button")!.getBoundingClientRect();
    return { visible: r.left >= button.left && r.right <= button.right, clipped: el.scrollWidth > el.clientWidth };
  });
  expect(bounds).toEqual({ visible: true, clipped: false });
  expect(await page.locator(".path-directory").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByTitle("Rename Markdown path").click();
  await expect(page.getByRole("textbox", { name: "Markdown path" })).toHaveValue(path);
});

import { expect, test, type Page } from "@playwright/test";

async function fitsViewport(page: Page, selector: string) {
  const bounds = await page.locator(selector).evaluate((element) => ({
    client: element.clientWidth, scroll: element.scrollWidth,
    right: element.getBoundingClientRect().right, viewport: window.innerWidth
  }));
  expect(bounds.scroll, `${selector} scroll width`).toBeLessThanOrEqual(bounds.client + 1);
  expect(bounds.right, `${selector} right edge`).toBeLessThanOrEqual(bounds.viewport + 1);
}

for (const width of [360, 390, 430]) {
  test(`mobile workspace stays navigable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 360 ? 740 : 844 });
    await page.goto("?demo=300");
    const title = page.getByRole("textbox", { name: "Note title" });
    await expect(title).toBeVisible();
    await expect(page.locator(".editor-bar button:visible")).toHaveCount(2);
    await expect(page.locator(".mobile-note-path")).toHaveText("Notes/the-shape-of-useful-tools.md");
    await expect(page.locator(".editor-bar .path-button")).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await fitsViewport(page, ".writing-surface");
      await fitsViewport(page, ".body-editor .cm-scroller");
    }
    await page.getByRole("button", { name: "More note actions" }).click();
    await page.getByRole("menuitem", { name: "Rename path" }).click();
    const path = page.getByRole("textbox", { name: "Markdown path" });
    await expect(path).toBeFocused();
    await path.fill("Notes/a-longer-mobile-note-name.md");
    await path.press("Enter");
    await page.getByRole("button", { name: "Rename and update links" }).click();
    await expect(page.locator(".mobile-note-path")).toHaveText("Notes/a-longer-mobile-note-name.md");

    await page.getByRole("button", { name: "More note actions" }).click();
    await page.getByRole("menuitem", { name: "Note properties" }).click();
    await expect(page.getByRole("complementary", { name: "Note properties" })).toBeVisible();
    await fitsViewport(page, ".properties-panel");
    await page.getByRole("button", { name: "Close properties" }).click();

    await page.getByRole("button", { name: "More note actions" }).click();
    await page.getByRole("menuitem", { name: "Quick open" }).click();
    const quick = page.getByRole("dialog", { name: "Quick open" });
    await expect(quick).toBeVisible();
    await fitsViewport(page, ".quick-open");
    await quick.getByRole("combobox").fill("Ideas for Sunday 12");
    await quick.getByRole("option").filter({ has: page.getByText("Ideas for Sunday 12", { exact: true }) }).click();
    await expect(title).toHaveValue("Ideas for Sunday 12");
    await page.getByRole("button", { name: "More note actions" }).click();
    await page.getByRole("menuitem", { name: "Note properties" }).click();
    await expect(page.getByLabel("tags value item 1")).toHaveValue("notes");
    await fitsViewport(page, ".property-fields");
    const propertyFields = await page.locator(".property-fields").boundingBox();
    const removeProperty = await page.getByRole("button", { name: "Remove tags property" }).boundingBox();
    expect(removeProperty!.x + removeProperty!.width).toBeLessThanOrEqual(propertyFields!.x + propertyFields!.width);
    const removeTag = page.getByRole("button", { name: "Remove tags item 1" });
    const target = await removeTag.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Close properties" }).click();

    await page.getByRole("button", { name: "More note actions" }).click();
    await page.getByRole("menuitem", { name: "New note", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
    await fitsViewport(page, ".new-note-composer");
    await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "New note", exact: true })).toHaveText("New note");
    await fitsViewport(page, ".note-list-pane");
    await page.getByRole("button", { name: "Collections", exact: true }).click();
    await page.getByRole("button", { name: "Types (1)" }).click();
    await fitsViewport(page, ".type-list-pane");
    await page.getByRole("option").first().click();
    await expect(page.locator(".type-inspector")).toBeVisible();
    await fitsViewport(page, ".type-inspector");
    await fitsViewport(page, ".visual-type-editor");
    await page.getByRole("button", { name: "Back to types" }).click();
    await page.getByRole("button", { name: "Collections", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".settings-document")).toBeVisible();
    await fitsViewport(page, ".settings-view");
    await fitsViewport(page, ".settings-document");
  });
}

test("embed actions reveal on pointer and keyboard focus without a caption bar", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("?demo=12");
  const image = page.getByRole("img", { name: "A durable piece of frontmatter" });
  await expect(image).toBeVisible();
  const embed = page.locator(".cm-file-embed");
  await page.getByRole("textbox", { name: "Note title" }).focus();
  await page.mouse.move(0, 0);
  await expect(embed.locator(".cm-embed-actions")).toHaveCSS("opacity", "0");
  await expect(embed.locator("figcaption")).toHaveText("A durable piece of frontmatter");
  await expect(embed.locator("figcaption button")).toHaveCount(0);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await expect(image).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await embed.focus();
  await expect(embed.locator(".cm-embed-actions")).toHaveCSS("opacity", "1");
  await embed.getByRole("button", { name: "Copy path for frontmatter.svg" }).click();
  await expect(embed.getByRole("status")).toHaveText("Path copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Assets/frontmatter.svg");
  await page.getByRole("textbox", { name: "Note title" }).focus();
  await embed.hover();
  await expect(embed.locator(".cm-embed-actions")).toHaveCSS("opacity", "1");
  await embed.getByRole("button", { name: "Open frontmatter.svg" }).click();
  const viewer = page.getByRole("dialog", { name: "Preview frontmatter.svg" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Close file preview" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(viewer.getByRole("link", { name: "Open original" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeAttached();
  await expect(embed.getByRole("button", { name: "Open frontmatter.svg" })).toBeFocused();
});

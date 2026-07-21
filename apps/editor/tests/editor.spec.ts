import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("keeps the application geometry visible while a collection opens", async ({ page }) => {
  await page.goto("?demo=80&delay=450");
  const opening = page.getByRole("main", { name: "Opening collection" });
  await expect(opening).toBeVisible();
  await expect(opening).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Reading its notes and types")).toBeVisible();
  expect(await opening.locator(":scope > *").count()).toBe(3);
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  await expect(opening).not.toBeAttached();
});

test("edits and autosaves a Markdown note", async ({ page }) => {
  await page.goto("?demo=240");
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  const title = page.getByRole("textbox", { name: "Note title" });
  await expect(title).toHaveValue("The shape of useful tools");
  await title.fill("Useful tools, revised");
  await page.getByRole("textbox", { name: "Note body" }).fill("A deliberately quiet editing surface.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 2_000 });

  const body = page.getByRole("textbox", { name: "Note body" });
  const codeMirror = page.locator(".body-editor .cm-editor");
  await body.click();
  await expect(body).toBeFocused();
  expect(await codeMirror.evaluate((element) => ({
    outline: getComputedStyle(element).outlineStyle,
    shadow: getComputedStyle(element).boxShadow
  }))).toEqual({ outline: "none", shadow: "none" });
});

test("filters collection facets, follows backlinks, and completes wikilinks", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");

  const folders = page.getByRole("group", { name: "Folders" });
  const foldersToggle = folders.getByRole("button", { name: "Folders" });
  await expect(foldersToggle).toHaveAttribute("aria-expanded", "true");
  await foldersToggle.click();
  await expect(foldersToggle).toHaveAttribute("aria-expanded", "false");

  const tags = page.getByRole("group", { name: "Tags" });
  await tags.getByRole("button", { name: "Tags" }).click();
  await tags.getByRole("button", { name: /#ideas/ }).click();
  await expect(page.getByRole("heading", { name: "#ideas" })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(4);

  await page.locator(".collection-rail nav > button").first().click();
  await page.getByRole("button", { name: "Backlinks" }).click();
  const backlinks = page.getByRole("complementary", { name: "Backlinks" });
  await expect(backlinks.getByText("1 note link here")).toBeVisible();
  await backlinks.getByRole("button", { name: /Garden notes 2/ }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");

  const body = page.getByRole("textbox", { name: "Note body" });
  await body.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n[[the shape");
  const completion = page.locator(".cm-tooltip-autocomplete");
  await expect(completion).toBeVisible();
  await expect(completion.getByText("The shape of useful tools", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(body).toContainText("[[Notes/the-shape-of-useful-tools|The shape of useful tools]]");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 2_000 });
});

test("creates a note only after the creation form is complete", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.getByText("4 notes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New note" }).click();

  const create = page.getByRole("button", { name: "Create note" });
  await expect(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Title" }).fill("A useful note");
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("Notes/A useful note.md");
  await page.getByRole("combobox", { name: "Type" }).selectOption("note");
  await expect(create).toBeEnabled();
  const createStarted = Date.now();
  await create.click();

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("A useful note");
  const createReadyMs = Date.now() - createStarted;
  expect(createReadyMs).toBeLessThan(500);
  await expect(page.locator(".body-editor .cm-placeholder")).toHaveText("Start writing");
  await expect(page.getByText("5 notes", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Notes/A useful note.md" })).toBeVisible();
});

test("inspects type definitions and persists editor settings", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("button", { name: /Schemas/ }).click();
  await expect(page.getByRole("heading", { name: "note" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "note type YAML" })).toContainText("kind: mdbase.type");

  await page.getByRole("button", { name: "Settings" }).click();
  const vim = page.getByRole("switch", { name: "Vim key bindings" });
  await expect(vim).toHaveAttribute("aria-checked", "false");
  await vim.click();
  await expect(vim).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: /Notes/ }).first().click();
  await expect(page.getByText("Vim", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Vim", { exact: true })).toBeVisible();
});

test("resizes, collapses, and restores the desktop sidebars", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();

  const collectionResize = page.getByRole("separator", { name: "Resize collections sidebar" });
  await collectionResize.focus();
  await page.keyboard.press("ArrowRight");
  await expect(collectionResize).toHaveAttribute("aria-valuenow", "184");

  const listResize = page.getByRole("separator", { name: "Resize notes sidebar" });
  const before = await page.locator(".note-list-pane").evaluate((element) => element.getBoundingClientRect().width);
  const handle = await listResize.boundingBox();
  if (!handle) throw new Error("The notes resize handle is not visible.");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 48, handle.y + 80);
  await page.mouse.up();
  const after = await page.locator(".note-list-pane").evaluate((element) => element.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 40);

  await page.getByRole("button", { name: "Hide collections sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Show collections sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Hide notes sidebar" }).click();
  await expect(page.getByRole("region", { name: "Notes" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Show notes sidebar" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Show collections sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show notes sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Show collections sidebar" }).click();
  await page.getByRole("button", { name: "Show notes sidebar" }).click();
  await expect(page.getByRole("separator", { name: "Resize collections sidebar" })).toHaveAttribute("aria-valuenow", "184");
  const restored = await page.locator(".note-list-pane").evaluate((element) => element.getBoundingClientRect().width);
  expect(restored).toBeCloseTo(after, 0);
});

test("keeps the Vim insert-mode cursor visible", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mdbase-editor:preferences", JSON.stringify({
      vim: true,
      lineWrapping: true,
      fontSize: 17
    }));
  });
  await page.goto("?demo=12");

  const body = page.getByRole("textbox", { name: "Note body" });
  await body.click();
  await page.keyboard.press("i");
  await expect(body).toBeFocused();

  const cursor = page.locator(".body-editor .cm-cursorLayer:not(.cm-vimCursorLayer) .cm-cursor-primary");
  await expect(cursor).toBeAttached();
  const cursorState = await cursor.evaluate((element) => {
    const cursorStyle = getComputedStyle(element);
    const layerStyle = getComputedStyle(element.parentElement!);
    const scroller = element.closest(".cm-scroller");
    return {
      animationName: layerStyle.animationName,
      borderColor: cursorStyle.borderLeftColor,
      borderWidth: cursorStyle.borderLeftWidth,
      cursorDisplay: cursorStyle.display,
      layerDisplay: layerStyle.display,
      layerOpacity: layerStyle.opacity,
      vimNormalMode: scroller?.classList.contains("cm-vimMode")
    };
  });
  expect(cursorState).toMatchObject({
    animationName: "none",
    borderWidth: "2px",
    cursorDisplay: "block",
    layerDisplay: "block",
    layerOpacity: "1",
    vimNormalMode: false
  });
  expect(cursorState.borderColor).not.toBe("transparent");
  expect(cursorState.borderColor).not.toBe("rgba(0, 0, 0, 0)");
});

test("edits structured frontmatter without exposing an undifferentiated textarea", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("option").filter({ hasText: "A quiet interface 3" }).click();
  await page.getByRole("button", { name: "Note properties" }).click();

  const panel = page.getByRole("complementary", { name: "Note properties" });
  await expect(panel.getByRole("heading", { name: "Properties" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "tags JSON value" })).toBeVisible();
  await panel.getByRole("tab", { name: /JSON/ }).click();
  await expect(panel.getByRole("textbox", { name: "Frontmatter JSON" })).toContainText('"tags"');
});

test("keeps a ten-thousand-note collection responsive and virtualized", async ({ page }) => {
  const started = Date.now();
  await page.goto("?demo=10000");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  const firstUsableMs = Date.now() - started;
  expect(firstUsableMs).toBeLessThan(1_800);
  await expect(page.getByText("10,000 notes")).toBeVisible();
  const fullIndexMs = Date.now() - started;
  expect(fullIndexMs).toBeLessThan(2_500);

  const renderedRows = await page.locator(".note-row").count();
  expect(renderedRows).toBeLessThan(40);

  const searchStarted = Date.now();
  await page.getByRole("textbox", { name: "Search every note" }).fill("quiet interface 51");
  await expect(page.locator(".list-header p")).not.toHaveText("10,000 notes");
  const searchReadyMs = Date.now() - searchStarted;
  expect(searchReadyMs).toBeLessThan(900);

  const inputLatency = await page.getByRole("textbox", { name: "Search every note" }).evaluate((input) => {
    const samples: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const start = performance.now();
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "x", inputType: "insertText" }));
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length * 0.95)];
  });
  expect(inputLatency).toBeLessThan(16);

  console.log(JSON.stringify({ firstUsableMs, fullIndexMs, searchReadyMs, renderedRows, inputP95Ms: inputLatency }));
});

test("uses one navigable pane at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("?demo=80");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.getByRole("button", { name: "Back to notes" }).click();
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  await page.getByRole("option").first().click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.getByRole("button", { name: "Back to notes" }).click();
  await page.getByRole("button", { name: "Collections" }).click();
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toBeVisible();
});

test("has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("?demo=80");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

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
  await expect(page.locator(".body-editor .cm-cursorLayer")).toHaveCount(0);
  const caretColor = await body.evaluate((element) => getComputedStyle(element).caretColor);
  expect(caretColor).not.toBe("transparent");
  expect(caretColor).not.toBe("rgba(0, 0, 0, 0)");
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

  await page.getByRole("button", { name: /^Notes, / }).click();
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

for (const trigger of ["@", "[["] as const) {
  test(`${trigger} picker remains usable when its query autosaves`, async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });

    await page.goto("?demo=12");
    const editor = page.getByRole("main", { name: "Note editor" });
    const body = page.getByRole("textbox", { name: "Note body" });
    const saveState = editor.locator(".save-state");
    await body.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(`\n\n${trigger}the shape`);

    const completion = page.locator(".cm-tooltip-autocomplete");
    await expect(completion).toBeVisible();
    await expect(saveState).toHaveText("Unsaved");
    await expect(saveState).toHaveText("Saved", { timeout: 2_000 });
    await expect(completion).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(body).toContainText("[[Notes/the-shape-of-useful-tools|The shape of useful tools]]");
    await expect(saveState).toHaveText("Unsaved");
    await expect(saveState).toHaveText("Saved", { timeout: 2_000 });
    await expect(page.getByText(/Couldn’t save/)).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
  });
}

test("creates a note only after the creation form is complete", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.getByText("4 notes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New note" }).click();

  const create = page.getByRole("button", { name: "Create note" });
  await expect(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Title" }).fill("A useful note");
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("A useful note.md");
  await page.getByRole("combobox", { name: "Type" }).selectOption("note");
  await expect(page.getByRole("textbox", { name: "Path" })).toHaveValue("Notes/A useful note.md");
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

test("quick-opens notes with fuzzy keyboard search", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();

  await page.keyboard.press("Control+k");
  const quickOpen = page.getByRole("dialog", { name: "Quick open" });
  await expect(quickOpen).toBeVisible();
  await quickOpen.getByRole("combobox", { name: "Find a note" }).fill("qstn kpng");
  await expect(quickOpen.getByRole("option", { name: /Questions worth keeping 7/ })).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Questions worth keeping 7");
});

test("creates a folder with its first note", async ({ page }) => {
  await page.goto("?demo=4");
  const folders = page.getByRole("group", { name: "Folders" });
  await folders.getByRole("button", { name: "New folder" }).click();

  const create = page.getByRole("button", { name: "Create folder" });
  await expect(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Folder name" }).fill("Research");
  await page.getByRole("textbox", { name: "First note" }).fill("Reading list");
  await expect(page.getByText("Research/Reading list.md")).toBeVisible();
  await create.click();

  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Reading list");
  await expect(folders.getByRole("button", { name: /Research/ })).toBeVisible();
});

test("inspects type definitions and persists editor settings", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("heading", { name: "note" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("note");
  await page.getByRole("button", { name: "YAML" }).click();
  await expect(page.getByRole("textbox", { name: "note type YAML" })).toContainText("kind: mdbase.type");
  await expect(page.getByText("Collection-wide change")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const vim = page.getByRole("switch", { name: "Vim key bindings" });
  await expect(vim).toHaveAttribute("aria-checked", "false");
  await vim.click();
  await expect(vim).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: /^Notes, / }).click();
  await expect(page.getByText("Vim", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Vim", { exact: true })).toBeVisible();
});

test("edits complete type membership, choices, and multiple required fields", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("heading", { name: "Type membership" })).toBeVisible();
  await expect(page.getByText("Explicit membership comes first.")).toBeVisible();

  await page.getByRole("button", { name: "Add path pattern" }).click();
  await page.getByRole("textbox", { name: "Path pattern 2" }).fill("Journal/**/*.md");
  await page.getByRole("textbox", { name: "Path pattern 2" }).press("Tab");
  await page.getByRole("button", { name: "Add field selector" }).click();
  await page.getByRole("textbox", { name: "Required match field 1" }).fill("title");
  await page.getByRole("textbox", { name: "Required match field 1" }).press("Tab");

  await page.getByRole("button", { name: "Expand title field" }).click();
  await page.getByRole("button", { name: "Add choice" }).click();
  await page.getByRole("textbox", { name: "title choice 1" }).fill("journal");
  await page.getByRole("textbox", { name: "title choice 1" }).press("Enter");
  await page.getByRole("textbox", { name: "title choice 2" }).fill("reflection");
  await page.getByRole("textbox", { name: "title choice 2" }).press("Tab");

  for (const name of ["title", "tags"]) {
    const row = page.locator(".visual-field-row").filter({ has: page.locator(`.visual-field-name input[value="${name}"]`) });
    await row.getByRole("checkbox", { name: "Required" }).check();
  }

  const geometry = await page.locator(".visual-type-editor").evaluate((editor) => {
    const right = editor.getBoundingClientRect().left + editor.clientWidth;
    const controls = [...editor.querySelectorAll<HTMLElement>("input, select")];
    return {
      hasVerticalScroll: editor.scrollHeight > editor.clientHeight,
      noHorizontalScroll: editor.scrollWidth <= editor.clientWidth,
      controlsInside: controls.every((control) => control.getBoundingClientRect().right <= right + 0.5)
    };
  });
  expect(geometry).toEqual({ hasVerticalScroll: true, noHorizontalScroll: true, controlsInside: true });

  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Confirm update" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "YAML" }).click();
  const source = page.getByRole("textbox", { name: "note type YAML" });
  await expect(source).toContainText("Journal/**/*.md");
  await expect(source).toContainText("fields_present:");
  await expect(source).toContainText("- title");
  await expect(source).toContainText("- tags");
  await expect(source).toContainText("- journal");
  await expect(source).toContainText("- reflection");
});

test("builds and saves a recursive list-of-objects field", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("note");

  await page.getByRole("button", { name: "Add field", exact: true }).click();
  const fieldName = page.locator(".visual-field-name input").last();
  await fieldName.fill("contacts");
  await fieldName.press("Tab");
  await page.getByRole("combobox", { name: "contacts field kind" }).selectOption("array");
  await page.getByRole("combobox", { name: "contacts[] kind" }).selectOption("object");
  await page.getByRole("button", { name: "Add nested field" }).last().click();

  const nestedName = page.locator(".visual-field-name input").last();
  await nestedName.fill("value");
  await nestedName.press("Tab");
  const nestedRow = nestedName.locator("xpath=ancestor::div[contains(@class,'visual-field-row')]");
  await nestedRow.getByRole("checkbox", { name: "Required" }).check();

  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByRole("heading", { name: "Update this type?" })).toBeVisible();
  await expect(page.locator(".type-change-review dl > div").filter({ hasText: "Fields added" })).toContainText("2");
  await page.getByRole("button", { name: "Confirm update" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "YAML" }).click();
  const source = page.getByRole("textbox", { name: "note type YAML" });
  await expect(source).toContainText("contacts:");
  await expect(source).toContainText("items:");
  await expect(source).toContainText("- value");
});

test("resizes, collapses, and restores the desktop sidebars", async ({ page }) => {
  await page.goto("?demo=12");
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note body" })).toBeFocused();

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

test("keeps dense collection counts and footer controls inside the minimum rail", async ({ page }) => {
  await page.goto("?demo=10000");
  await expect(page.getByText("10,000 notes")).toBeVisible();

  const rail = page.getByRole("complementary", { name: "Collection navigation" });
  const wordmarkLabel = rail.locator(".wordmark-label");
  await expect(wordmarkLabel).toBeVisible();

  const collectionResize = page.getByRole("separator", { name: "Resize collections sidebar" });
  await collectionResize.focus();
  await page.keyboard.press("Home");
  await expect(collectionResize).toHaveAttribute("aria-valuenow", "144");
  await expect(wordmarkLabel).toBeHidden();

  const [markBox, collapseBox] = await Promise.all([
    rail.locator(".wordmark-mark").boundingBox(),
    rail.getByRole("button", { name: "Hide collections sidebar" }).boundingBox()
  ]);
  if (!markBox || !collapseBox) throw new Error("The collection header controls are not visible.");
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(collapseBox.x);

  const counts = rail.locator(".rail-filter-items small");
  await expect(counts.first()).toBeVisible();
  expect(await counts.evaluateAll((elements) => elements.every((element) => {
    const count = element.getBoundingClientRect();
    const container = element.closest(".collection-rail")?.getBoundingClientRect();
    return Boolean(container) && count.right <= container.right && element.scrollWidth <= element.clientWidth;
  }))).toBe(true);

  const statusLabel = rail.locator(".connection-footer p > span:last-child");
  const shortcuts = rail.getByRole("button", { name: "Keyboard shortcuts" });
  const [statusBox, shortcutBox] = await Promise.all([statusLabel.boundingBox(), shortcuts.boundingBox()]);
  if (!statusBox || !shortcutBox) throw new Error("Collection footer controls are not visible.");
  expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(shortcutBox.x);
  await expect(rail.locator(".disconnect-action > span")).toBeHidden();
});

test("uses the native caret in Vim insert mode", async ({ page }) => {
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
  const scroller = page.locator(".body-editor .cm-scroller");
  const blockCursor = page.locator(".body-editor .cm-vimCursorLayer .cm-fat-cursor");
  await expect(scroller).toHaveClass(/cm-vimMode/);
  await expect(blockCursor).toBeAttached();

  await page.keyboard.press("i");
  await expect(body).toBeFocused();
  await expect(scroller).not.toHaveClass(/cm-vimMode/);
  await expect(blockCursor).not.toBeAttached();
  await expect(page.locator(".body-editor .cm-cursorLayer:not(.cm-vimCursorLayer)")).toHaveCount(0);
  const caretColor = await body.evaluate((element) => getComputedStyle(element).caretColor);
  expect(caretColor).not.toBe("transparent");
  expect(caretColor).not.toBe("rgba(0, 0, 0, 0)");
});

test("edits structured frontmatter without exposing an undifferentiated textarea", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("option").filter({ hasText: "Ideas for Sunday 12" }).click();
  await page.getByRole("button", { name: "Note properties" }).click();

  const panel = page.getByRole("complementary", { name: "Note properties" });
  await expect(panel.getByRole("heading", { name: "Properties" })).toBeVisible();
  const tags = panel.getByRole("group", { name: "tags" });
  await expect(tags.getByRole("button", { name: "Add tag" })).toBeVisible();
  await tags.getByRole("button", { name: "Add tag" }).click();
  await tags.getByRole("textbox", { name: "tags value item 3" }).fill("nested editing");
  await expect(panel.getByText("All changes saved")).toBeVisible();
  await panel.getByRole("button", { name: "Close properties" }).click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: "Note properties" }).click();
  await panel.getByRole("tab", { name: /JSON/ }).click();
  await expect(panel.getByRole("textbox", { name: "Frontmatter JSON" })).toContainText('"nested editing"');
});

test("adds schema properties and edits the complete Markdown record", async ({ page }) => {
  await page.goto("?demo=12");
  await page.getByRole("option").filter({ hasText: "Ideas for Sunday 12" }).click();
  await page.getByRole("button", { name: "Note properties" }).click();

  const panel = page.getByRole("complementary", { name: "Note properties" });
  await panel.getByRole("button", { name: "Add property" }).click();
  await panel.getByRole("searchbox", { name: "Find a property" }).fill("title");
  await panel.locator(".property-options button").filter({ hasText: "title" }).click();
  await expect(panel.getByLabel("title property kind")).toHaveCount(0);
  await panel.getByRole("textbox", { name: "title value" }).fill("Source-backed title");
  await expect(panel.getByText("All changes saved")).toBeVisible();
  await panel.getByRole("button", { name: "Close properties" }).click();
  await expect(panel).not.toBeVisible();

  await page.getByRole("button", { name: "Note properties" }).click();
  await panel.getByRole("tab", { name: "Source" }).click();
  const source = panel.getByRole("textbox", { name: "Complete record source" });
  await expect(source).toContainText("title: Source-backed title");
  const original = await source.textContent();
  await source.fill(`${original ?? ""}\nSource tail.\n`);
  await panel.getByRole("button", { name: "Save source" }).click();
  await expect(panel).not.toBeVisible();

  await page.getByRole("button", { name: "Note properties" }).click();
  await panel.getByRole("tab", { name: "Source" }).click();
  await expect(panel.getByRole("textbox", { name: "Complete record source" })).toContainText("Source tail.");
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

test("maps browser history to the mobile pane stack", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("?demo=40");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("region", { name: "Notes" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note title" })).not.toBeVisible();

  await page.goBack();
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toBeVisible();
});

test("protects an unfinished note draft with a modal confirmation", async ({ page }) => {
  await page.goto("?demo=40");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("A draft worth keeping");
  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();

  const confirmation = page.getByRole("alertdialog", { name: "Discard this note?" });
  await expect(confirmation).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("aria-hidden", "true");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("A draft worth keeping");

  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();
  await confirmation.getByRole("button", { name: "Discard note" }).click();
  await expect(page.getByRole("main", { name: "Create note" })).not.toBeVisible();
});

test("keeps every editor action reachable at the minimum mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("?demo=12");
  await expect(page.getByRole("textbox", { name: "Note body" })).toBeVisible();

  const bounds = await page.locator(".editor-pane").evaluate((pane) => {
    const action = pane.querySelector<HTMLElement>(".note-actions");
    const surface = pane.querySelector<HTMLElement>(".writing-surface");
    if (!action || !surface) throw new Error("The note editor is incomplete.");
    return {
      paneRight: pane.getBoundingClientRect().right,
      actionRight: action.getBoundingClientRect().right,
      surfaceRight: surface.getBoundingClientRect().right,
      viewportWidth: window.innerWidth
    };
  });

  expect(bounds.paneRight).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.actionRight).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.surfaceRight).toBeLessThanOrEqual(bounds.viewportWidth);
  await page.getByLabel("More note actions").click();
  await expect(page.getByRole("menuitem", { name: "Check note" })).toBeVisible();
});

test("keeps type editing usable at the minimum mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("?demo=12");
  await page.getByRole("button", { name: "Back to notes" }).click();
  await page.getByRole("button", { name: "Collections" }).click();
  await page.getByRole("button", { name: "Types (1)" }).click();
  await page.getByRole("option", { name: /note/ }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("note");
  await page.getByRole("button", { name: "YAML" }).click();
  const typeEditor = page.getByRole("textbox", { name: "note type YAML" });
  await expect(typeEditor).toBeVisible();
  await expect(typeEditor).toHaveAttribute("tabindex", "0");

  const rightEdges = await page.locator(".type-inspector").evaluate((inspector) => ({
    inspector: inspector.getBoundingClientRect().right,
    source: inspector.querySelector<HTMLElement>(".type-source")!.getBoundingClientRect().right,
    actions: inspector.querySelector<HTMLElement>(".type-editor-actions")!.getBoundingClientRect().right,
    viewport: window.innerWidth
  }));
  expect(rightEdges.inspector).toBeLessThanOrEqual(rightEdges.viewport);
  expect(rightEdges.source).toBeLessThanOrEqual(rightEdges.viewport);
  expect(rightEdges.actions).toBeLessThanOrEqual(rightEdges.viewport);

  await page.getByRole("button", { name: "Back to types" }).click();
  await page.getByRole("button", { name: "New type" }).click();
  await expect(page.getByText("New", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review changes" })).toBeVisible();
});

test("has no automatically detectable accessibility violations across editor surfaces", async ({ page }) => {
  await page.goto("?demo=80");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("main", { name: "Create note" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator(".new-note-actions").getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Types (1)" }).click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("note");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("main", { name: "Editor settings" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

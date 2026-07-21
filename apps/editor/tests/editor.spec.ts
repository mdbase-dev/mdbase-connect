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
  await page.getByRole("button", { name: /Types/ }).click();
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

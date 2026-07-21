import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("edits and autosaves a Markdown note", async ({ page }) => {
  await page.goto("?demo=240");
  await expect(page.getByRole("heading", { name: "Writing" })).toBeVisible();
  const title = page.getByRole("textbox", { name: "Note title" });
  await expect(title).toHaveValue("The shape of useful tools");
  await title.fill("Useful tools, revised");
  await page.getByRole("textbox", { name: "Note body" }).fill("A deliberately quiet editing surface.");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 2_000 });
});

test("keeps a ten-thousand-note collection responsive and virtualized", async ({ page }) => {
  const started = Date.now();
  await page.goto("?demo=10000");
  await expect(page.getByText("10000 notes")).toBeVisible();
  const initialReadyMs = Date.now() - started;
  expect(initialReadyMs).toBeLessThan(2_500);

  const renderedRows = await page.locator(".note-row").count();
  expect(renderedRows).toBeLessThan(40);

  const searchStarted = Date.now();
  await page.getByRole("textbox", { name: "Search every note" }).fill("quiet interface 51");
  await expect(page.locator(".list-header p")).not.toHaveText("10000 notes");
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

  console.log(JSON.stringify({ initialReadyMs, searchReadyMs, renderedRows, inputP95Ms: inputLatency }));
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

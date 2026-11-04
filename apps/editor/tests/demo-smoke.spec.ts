import { expect, test } from "@playwright/test";

test("demo=300 renders records without a Vite error overlay", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("?demo=300");
  await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toBeVisible();
  await expect(page.locator(".note-row").first()).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});

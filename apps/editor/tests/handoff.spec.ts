import { expect, test } from "@playwright/test";

test("a real handoff never opens the unrelated review demo", async ({ page }) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/v1/")) requests.push(request.url()); });
  await page.goto("?server=http://127.0.0.1:4815&collection=hosted-0");
  await expect(page.getByRole("heading", { name: "This Editor build cannot open collections here" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to mdbase Connect" })).toHaveAttribute("href", "http://127.0.0.1:4815");
  await expect(page.getByText("Connect server: http://127.0.0.1:4815", { exact: true })).toBeVisible();
  await expect(page.getByText("The app stopped", { exact: true })).toHaveCount(0);
  await expect(page.locator(".note-row")).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("invalid server input and bare entry have recovery pages", async ({ page }) => {
  await page.goto("?server=javascript:alert(1)&collection=hosted-0");
  await expect(page.getByRole("heading", { name: "This collection link is invalid" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to mdbase Connect" })).toHaveAttribute("href", "https://connect.mdbase.dev");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This Editor build cannot open collections here" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to mdbase Connect" })).toBeVisible();
});

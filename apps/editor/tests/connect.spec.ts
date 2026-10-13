import { expect, test } from "@playwright/test";

test("old /connect bookmarks forward to Connect without mounting management or authorizing content", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/v1/")) requests.push(new URL(request.url()).pathname); });
  await page.route("http://connect.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Canonical Connect portal</h1>" }));
  await page.goto("connect/account?server=http%3A%2F%2Fconnect.test&collection=collection&linked=github#delete_token=act_fixture");
  await expect(page.getByRole("heading", { name: "Canonical Connect portal" })).toBeVisible();
  const target = new URL(page.url());
  expect(target.origin).toBe("http://connect.test");
  expect(target.pathname).toBe("/account");
  expect(target.searchParams.get("collection")).toBe("collection");
  expect(target.searchParams.get("linked")).toBe("github");
  expect(target.searchParams.has("server")).toBe(false);
  expect(target.hash).toBe("#delete_token=act_fixture");
  expect(requests).toEqual([]);
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toHaveCount(0);
});

test("the Editor collection rail opens canonical Connect with collection context, never Editor /connect", async ({ page }) => {
  await page.goto("?demo=10&server=http%3A%2F%2Fconnect.test");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  const link = page.getByRole("complementary", { name: "Collection navigation" }).getByRole("link", { name: "Connect", exact: true });
  const target = new URL(await link.getAttribute("href")!);
  expect(target.origin).toBe("http://connect.test");
  expect(target.pathname).toBe("/");
  expect(target.searchParams.get("collection")).toBeTruthy();
  expect(target.searchParams.has("server")).toBe(false);
});

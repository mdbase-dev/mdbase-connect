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

// The Editor's own /connect console is retired; every old console link forwards
// to the same path on the canonical Connect portal instead.
const retiredLinks = [
  ["connect?server=http%3A%2F%2Fconnect.test&collection=collection", "/"],
  ["connect/storage?server=http%3A%2F%2Fconnect.test&collection=collection", "/storage"],
  ["connect/collections?server=http%3A%2F%2Fconnect.test", "/collections"],
  ["connect/collections/native?server=http%3A%2F%2Fconnect.test&collection=native", "/collections/native"]
] as const;

for (const [link, pathname] of retiredLinks) {
  test(`forwards the retired console link /${link.split("?")[0]} to Connect`, async ({ page }) => {
    await page.route("http://connect.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Canonical Connect portal</h1>" }));
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Canonical Connect portal" })).toBeVisible();
    const target = new URL(page.url());
    expect(target.origin).toBe("http://connect.test");
    expect(target.pathname).toBe(pathname);
    await expect(page.getByRole("complementary", { name: "mdbase connect navigation" })).toHaveCount(0);
  });
}

test("Open Connect opens canonical Connect with collection context, never Editor /connect", async ({ page }) => {
  await page.route("http://connect.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Canonical Connect portal</h1>" }));
  await page.goto("?demo=10&server=http%3A%2F%2Fconnect.test");
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await expect(body).toBeVisible();
  await body.focus();
  await page.keyboard.press("Control+Shift+P");
  const input = page.getByRole("combobox", { name: "Find a note or action" });
  await input.fill(">Open Connect");
  await page.getByRole("option", { name: /Open Connect/ }).click();
  await expect(page.getByRole("heading", { name: "Canonical Connect portal" })).toBeVisible();
  const target = new URL(page.url());
  expect(target.origin).toBe("http://connect.test");
  expect(target.pathname).toBe("/");
  expect(target.searchParams.get("collection")).toBeTruthy();
  expect(target.searchParams.has("server")).toBe(false);
});

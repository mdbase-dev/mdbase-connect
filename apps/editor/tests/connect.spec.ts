import { expect, test } from "@playwright/test";

const now = new Date().toISOString();
const overview = {
  user: { id: "person", name: "Example Person", email: "person@example.com", login: null },
  subscription: null,
  hosted_collections_available: true,
  authentication: { provider: "github", registration: "closed" },
  connectors: [{ id: "computer", name: "Home computer", last_seen_at: now, created_at: now }],
  collections: [{
    id: "collection",
    connector_id: "computer",
    local_id: "local",
    connector_name: "Home computer",
    display_name: "Garden notes",
    spec_version: "1",
    enabled: true,
    contracts: [],
    last_seen_at: now
  }],
  hosted_collections: [],
  grants: [],
  pending_authorizations: []
};

test.beforeEach(async ({ page }) => {
  await page.route("http://connect.test/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: pathname === "/v1/account/sessions" ? { sessions: [] } : overview
    });
  });
});

test("places Connect inside the editor collection shell", async ({ page }) => {
  await page.goto("connect?server=http%3A%2F%2Fconnect.test&collection=collection");

  const collectionRail = page.getByRole("complementary", { name: "Collection navigation" });
  await expect(page.getByRole("heading", { name: "Garden notes" })).toBeVisible();
  await expect(collectionRail.getByRole("link", { name: "Notes" })).toBeVisible();
  await expect(collectionRail.getByRole("link", { name: "Types" })).toBeVisible();
  await expect(collectionRail.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(collectionRail.getByRole("link", { name: "Connect" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Garden notes" })).toBeVisible();
  await expect(page.getByText("Account", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Product navigation" })).toHaveCount(0);

  await page.getByRole("link", { name: "Storage & sync" }).click();
  await expect(page).toHaveURL(/\/connect\/storage\?.*collection=collection/);
  await expect(page.getByRole("heading", { name: "Storage & sync" })).toBeVisible();
});

test("condenses the shared editor shell on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("connect?server=http%3A%2F%2Fconnect.test&collection=collection");

  const collectionRail = page.getByRole("complementary", { name: "Collection navigation" });
  await expect(page.getByRole("heading", { name: "Garden notes" })).toBeVisible();
  await expect(collectionRail).toHaveCSS("height", "58px");
  await expect(collectionRail.getByRole("link", { name: "Back to editor" })).toBeVisible();
  await expect(collectionRail.getByRole("button", { name: /Switch collection/ })).toBeHidden();
  const menu = page.getByRole("button", { name: /Overview.*Open menu/ });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("link", { name: "All collections" })).toBeHidden();
  await menu.click();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "All collections" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Garden notes" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Account" })).toBeVisible();
});

test("uses a collection chooser when direct entry is ambiguous", async ({ page }) => {
  await page.unroute("http://connect.test/v1/**");
  const ambiguousOverview = {
    ...overview,
    collections: [overview.collections[0], {
      ...overview.collections[0],
      id: "collection-two",
      local_id: "local-two",
      display_name: "Research notes"
    }]
  };
  await page.route("http://connect.test/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({ json: pathname === "/v1/account/sessions" ? { sessions: [] } : ambiguousOverview });
  });

  await page.goto("connect?server=http%3A%2F%2Fconnect.test");

  await expect(page).toHaveURL(/\/connect\/collections\?server=/);
  await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "All collections" })).toHaveAttribute("aria-current", "page");
});

for (const width of [834, 900]) {
  test(`keeps the Connect workspace usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("connect?server=http%3A%2F%2Fconnect.test&collection=collection");

    await expect(page.getByRole("heading", { name: "Garden notes" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Storage & sync" })).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      mainWidth: document.querySelector(".connect-main")?.getBoundingClientRect().width ?? 0
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.mainWidth).toBeGreaterThan(360);
  });
}

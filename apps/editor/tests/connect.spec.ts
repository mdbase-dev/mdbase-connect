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

test("keeps application summaries and review links separate at narrow widths", async ({ page }) => {
  await page.route("http://connect.test/v1/me", (route) => route.fulfill({
    json: {
      ...overview,
      grants: ["mdbase editor", "MDBase Workouts", "ApplicationWithAnUnusuallyLongUnbrokenName"].map((name, index) => ({
        id: `grant-${index}`,
        operations: ["read", "create", "update", "delete", "create_type"],
        scope: { contracts: [], access: "full_collection" },
        created_at: now,
        revoked_at: null,
        revocation_status: "active",
        collection_id: "collection",
        collection_name: "Garden notes",
        collection_kind: "local",
        application_id: `application-${index}`,
        application_name: name,
        distribution: "web",
        homepage: `https://${"long-application-hostname-".repeat(2)}${index}.example.com`,
        project_url: null,
        application_origin: "https://app.example.com",
        icon: null
      }))
    }
  }));
  await page.goto("connect?server=http%3A%2F%2Fconnect.test&collection=collection");
  const rows = page.locator(".connect-application-row");
  await expect(rows).toHaveCount(3);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 444, 640, 760, 834, 900, 1020, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const row of await rows.all()) {
        const layout = await row.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const children = [...element.children].map((child) => {
            const { left, right, top, bottom } = child.getBoundingClientRect();
            return { left, right, top, bottom, overflow: child.scrollWidth > child.clientWidth + 1 };
          });
          return { left: rect.left, right: rect.right, children };
        });
        const context = `${colorScheme}/${width}`;
        for (const child of layout.children) {
          expect(child.overflow, context).toBe(false);
          expect(child.left, context).toBeGreaterThanOrEqual(layout.left);
          expect(child.right, context).toBeLessThanOrEqual(layout.right);
        }
        if (width <= 1020) {
          const [identity, summary, review] = layout.children;
          expect(summary.top, context).toBeGreaterThanOrEqual(identity.bottom + 8);
          expect(review.top, context).toBeGreaterThanOrEqual(summary.bottom + 8);
          expect(review.left, context).toBe(identity.left);
          if (width <= 760) expect(review.bottom - review.top, context).toBeGreaterThanOrEqual(44);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${colorScheme}/${width}`).toBe(true);
    }
  }
  await rows.first().getByRole("link", { name: "Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Application access", exact: true })).toBeVisible();
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

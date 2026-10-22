import { expect, test } from "../../editor/tests/auth-portal";
let portalOrigin: string;

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

test.beforeEach(async ({ page, authPortal }) => {
  portalOrigin = authPortal;
  await page.route(`${portalOrigin}/v1/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: pathname === "/v1/ui-configuration" ? { editor_url: "http://editor.test/connect" } : pathname === "/v1/account/sessions" ? { sessions: [] } : overview
    });
  });
});

test("manages collections on the portal and links to the configured Editor without its shell", async ({ page }) => {
  await page.goto(`${portalOrigin}/?collection=collection`);
  await expect(page.getByRole("heading", { name: "Garden notes" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Collection navigation" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "mdbase connect navigation" })).toBeVisible();
  await expect(page.getByText("Account", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open editor" })).toHaveAttribute("href", `http://editor.test/?server=${encodeURIComponent(portalOrigin)}&collection=collection`);
  await page.getByRole("link", { name: "Storage & sync" }).click();
  expect(new URL(page.url()).pathname).toBe("/storage");
  await expect(page.getByRole("heading", { name: "Storage & sync" })).toBeVisible();
});

test("styles footer links and separates account details on desktop and mobile", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${portalOrigin}/collections`);
    await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();
    const footer = page.locator(".connect-nav-footer");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const styles = await footer.locator(":scope > a").evaluateAll(links => links.map(link => {
        const style = getComputedStyle(link), name = link.querySelector("strong"), email = link.querySelector("small");
        return { decoration: style.textDecorationLine, display: style.display, font: style.fontFamily,
          separateLines: !name || !email || email.getBoundingClientRect().top >= name.getBoundingClientRect().bottom };
      }));
      expect(styles).toHaveLength(2);
      for (const style of styles) { expect(style.decoration).toBe("none"); expect(style.display).toBe("grid"); expect(style.font).toMatch(/Atkinson/); expect(style.separateLines).toBe(true); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
});

test("opens Reader's manage-access route on Applications", async ({ page }) => {
  await page.goto(`${portalOrigin}/account/applications`);
  await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Browser sessions" })).toHaveCount(0);
});

test("gives Connect navigation distinct icons and section counts the UI face", async ({ page }) => {
  await page.goto(`${portalOrigin}/?collection=collection`);
  await expect(page.getByRole("heading", { name: "Garden notes" })).toBeVisible();
  const navigation = page.getByRole("complementary", { name: "mdbase connect navigation" });
  const icons = await navigation.locator("nav a svg").evaluateAll((elements) => elements.map((element) => element.innerHTML));
  expect(icons).toHaveLength(7);
  expect(new Set(icons).size).toBe(7);
  expect(await navigation.getByRole("link", { name: "Computers", exact: true }).locator("svg").innerHTML()).not.toBe(await navigation.getByRole("link", { name: "Applications", exact: true }).locator("svg").innerHTML());
  expect(await navigation.getByRole("link", { name: "Account & sessions", exact: true }).locator("svg").innerHTML()).not.toBe(await navigation.getByRole("link", { name: "All collections", exact: true }).locator("svg").innerHTML());
  const count = page.locator(".connect-section-title")
    .filter({ has: page.getByRole("heading", { name: "Application access", exact: true }) })
    .locator(":scope > div > span");
  await expect(count).toHaveText("0");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(count).toHaveCSS("font-family", /Atkinson Hyperlegible Next Variable/);
    await expect(count).toHaveCSS("font-variant-numeric", "tabular-nums");
  }
});

test("condenses portal navigation on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portalOrigin}/?collection=collection`);

  await expect(page.getByRole("heading", { name: "Garden notes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open editor" })).toBeVisible();
  const menu = page.getByRole("button", { name: /Overview.*Open menu/ });
  await expect(menu).toBeVisible();
  await expect(page.getByRole("link", { name: "All collections" })).toBeHidden();
  await menu.click();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "All collections" })).toBeVisible();
  await expect(page.locator("#current-collection-navigation")).toBeVisible();
  await expect(page.locator("#account-navigation")).toBeVisible();
  await page.getByRole("link", { name: "Storage & sync" }).click();
  const desktopLink = page.getByRole("link", { name: "Open desktop app", exact: true });
  await expect(desktopLink).toBeVisible();
  const alignment = await desktopLink.evaluate((element) => {
    const link = element.getBoundingClientRect();
    const identity = element.parentElement!.firstElementChild!.getBoundingClientRect();
    return { linkLeft: link.left, identityLeft: identity.left, linkTop: link.top, identityBottom: identity.bottom };
  });
  expect(alignment.linkLeft).toBe(alignment.identityLeft);
  expect(alignment.linkTop).toBeGreaterThanOrEqual(alignment.identityBottom);
});

test("keeps application summaries and review links separate at narrow widths", async ({ page }) => {
  await page.route(`${portalOrigin}/v1/me`, (route) => route.fulfill({
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
  await page.goto(`${portalOrigin}/?collection=collection`);
  const rows = page.locator(".connect-application-row");
  await expect(rows).toHaveCount(3);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 444, 640, 760, 834, 900, 1020, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const sectionLayout = await page.locator(".connect-section-title:has(> a)").evaluateAll((titles) => titles.map((title) => {
        const heading = title.querySelector("h2")!.getBoundingClientRect();
        const action = title.querySelector("a")!.getBoundingClientRect();
        return Math.abs((heading.top + heading.bottom) / 2 - (action.top + action.bottom) / 2);
      }));
      for (const difference of sectionLayout) expect(difference, `section action alignment at ${width}px`).toBeLessThan(3);
      if (width <= 760) {
        for (const margin of await page.locator(".connect-page > section").evaluateAll((sections) => sections.map((section) => parseFloat(getComputedStyle(section).marginTop)))) {
          expect(margin).toBe(32);
        }
      }
      await expect(page.locator(".connect-connection-summary").getByText("Connected", { exact: true })).toHaveCount(1);
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

test("discovers registry-only native collections and reuses the normal invitation flow", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000007";
  const nativeOverview = {
    ...overview, connectors: [], collections: [], hosted_collections: [], collection_sharing_available: true,
    native_collections: [{ id, display_name: "Native garden", sync: "cloud_copy", access: { relationship: "owner", role: "owner", can_manage_members: true } }]
  };
  await page.unroute(`${portalOrigin}/v1/**`);
  await page.route(`${portalOrigin}/v1/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith("/members") ? { members: [] }
      : path.endsWith("/invitations") && route.request().method() === "POST" ? { invitation: { id: "invitation", token: "fixture-invitation-token" } }
      : path.endsWith("/invitations") ? { invitations: [] }
      : path === "/v1/account/sessions" ? { sessions: [] } : nativeOverview;
    await route.fulfill({ status: route.request().method() === "POST" ? 202 : 200, json });
  });
  await page.goto(`${portalOrigin}/?collection=${id}`);
  await expect(page).not.toHaveURL(/\/collections/);
  await expect(page.getByRole("heading", { name: "Native garden", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "People & sharing" })).toBeVisible();
  await page.getByRole("button", { name: "Invite person" }).click();
  await page.getByLabel("Email address", { exact: true }).fill("member@example.test");
  const invitation = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === `/v1/hosted/collections/${id}/invitations`);
  await page.getByRole("button", { name: "Create invitation" }).click();
  expect((await invitation).postDataJSON()).toEqual({ email: "member@example.test", role: "viewer" });
  await expect(page.getByText("Invitation ready", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "All collections", exact: true }).click();
  await expect(page.getByRole("main").getByText("Native garden", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`collection=${id}`));
  await page.getByRole("link", { name: "Storage & sync", exact: true }).click();
  await expect(page.getByText("Cloud copy configured", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sync folder", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
});

test("uses a collection chooser when direct entry is ambiguous", async ({ page }) => {
  await page.unroute(`${portalOrigin}/v1/**`);
  const ambiguousOverview = {
    ...overview,
    collections: [overview.collections[0], {
      ...overview.collections[0],
      id: "collection-two",
      local_id: "local-two",
      display_name: "Research notes"
    }]
  };
  await page.route(`${portalOrigin}/v1/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({ json: pathname === "/v1/account/sessions" ? { sessions: [] } : ambiguousOverview });
  });

  await page.goto(`${portalOrigin}/`);

  await expect(page).toHaveURL(/\/collections/);
  await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "All collections" })).toHaveAttribute("aria-current", "page");
});

for (const width of [834, 900]) {
  test(`keeps the Connect workspace usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${portalOrigin}/?collection=collection`);

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

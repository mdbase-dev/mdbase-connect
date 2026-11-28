import { createRequire } from "node:module";
import { expect, openScenario, test } from "./review/fixture";
import { clock, scenarios } from "./review/scenarios.mjs";

// Use the workspace's existing axe installation for browser checks.
const { AxeBuilder } = createRequire(new URL("../../editor/package.json", import.meta.url))("@axe-core/playwright");

for (const width of [360, 768, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`management and consent pass axe at ${width}px in ${colorScheme}`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 812 });
      await page.emulateMedia({ colorScheme });
      for (const scenario of ["heavy-account", "applications", "computers", "account-sessions", "collection-access", "authorization-review"]) {
        await openScenario(page, scenario);
        if (scenario === "applications") {
          await page.locator(".connect-application > summary").first().press("Enter");
          await expect(page.getByRole("button", { name: "Revoke app" })).toBeVisible();
        }
        const audit = await new AxeBuilder({ page }).analyze();
        expect(audit.violations.map(rule => ({ id: rule.id, nodes: rule.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })), scenario).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth), scenario).toBeLessThanOrEqual(width);
      }
    });
  }
}

test("keyboard navigation focuses the destination and Escape returns to the mobile menu button", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 812 });
  await openScenario(page, "typical-account");
  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.press("Enter");
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await menu.press("Enter");
  await navigation.getByRole("link", { name: "Computers" }).press("Enter");
  const heading = page.getByRole("heading", { name: "Computers", exact: true });
  await expect(heading).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Actions for Studio MacBook" })).toBeFocused();
});

test("clearing a filter from its empty state returns keyboard focus to search", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 812 });
  await openScenario(page, "heavy-account");
  const filter = page.getByRole("searchbox", { name: "Filter collections" });
  await filter.fill("unmatched collection");
  await page.getByRole("button", { name: "Clear filter" }).press("Enter");
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("");
  await expect(page.locator(".connect-collections-list [data-list-item]")).toHaveCount(66);
});

test("mounts permission and installation controls only after their app is expanded", async ({ page }) => {
  const heavy = structuredClone(scenarios.find(scenario => scenario.name === "heavy-account")!.state.overview);
  heavy.installation_access = Array.from({ length: 80 }, (_, index) => ({
    application_id: "app-0", application_family_id: "app-0", application_name: "TaskNotes", icon: null,
    application_origin: "https://tasknotes.mdbase.dev", device_kind: "app-runtime", created_at: clock,
    connector_id: `connector-${index}`, installation_id: `installation-${index}`, create_collections: false,
    collection_id: "collection-0", collection_name: "Field research", sync: "cloud_copy", available: true,
    role: "owner", approved_optional_file_actions: []
  }));
  await page.route(url => url.pathname === "/v1/me", route => route.fulfill({ json: heavy }));
  await openScenario(page, "applications");
  await expect(page.locator(".connect-application > summary")).toHaveCount(4);
  await expect(page.locator(".connect-application-body")).toHaveCount(0);
  const app = page.locator('[data-command="app:app-0"]');
  const summary = app.locator(":scope > summary");
  await summary.press("Enter");
  await expect(app.getByText("80 installations", { exact: true })).toBeVisible();
  await expect(page.locator(".connect-application-body")).toHaveCount(1);
  await expect(app.locator(".connect-grant.mdbase-disclosure")).toHaveCount(heavy.grants.length / 4);
  await expect(app.getByRole("button", { name: "Remove installation" })).toHaveCount(80);
  await summary.press("Enter");
  await expect(app.getByRole("button", { name: "Remove installation" })).toHaveCount(0);
});

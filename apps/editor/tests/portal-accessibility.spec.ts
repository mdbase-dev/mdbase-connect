import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./auth-portal";

const owner = { relationship: "owner", role: "owner", can_manage_members: true };
const overview = {
  user: { id: "person", name: "Example Person", email: "person@example.test", login: null },
  authentication: { provider: "session", registration: "open" },
  subscription: null, collections: [], hosted_collections: [], grants: [], pending_authorizations: [],
  connectors: [{ id: "computer", name: "Home computer", last_seen_at: new Date().toISOString() }],
  native_collections: [
    { id: "cloud", display_name: "Cloud notes", sync: "cloud_copy", access: owner, computer_ids: ["computer"] },
    { id: "private", display_name: "Private notes", sync: "private", access: owner, computer_ids: ["computer"] }
  ]
};
const account = {
  backend: "next", user: overview.user,
  authentication: {
    managed: true, current_provider: "session", identities: [],
    available_providers: { github: false, google: false, password: true },
    password: { configured: true, change_available: true, current: true, email: overview.user.email }
  },
  storage: { status: "available", collections: [], total_storage_bytes: 0 },
  email_preferences: { announcements: true, product_updates: false },
  deletion: { available: true, owned_collections: 2, hosted_collections: 0, local_collections: 0, computers: 1, development_confirmation: true }
};

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`portal main screens pass serious and critical axe checks at ${width}px in ${colorScheme}`, async ({ page, authPortal }, testInfo) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 812 });
      await page.route(`${authPortal}/v1/**`, route => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ json: path === "/v1/account" ? account : path === "/v1/account/sessions" ? { sessions: [] } : path === "/v1/ui-configuration" ? { editor_url: "https://editor.mdbase.dev" } : overview });
      });
      for (const path of ["/collections", "/?collection=cloud", "/storage?collection=cloud", "/storage?collection=private", "/access?collection=cloud", "/applications", "/computers", "/account"]) {
        await page.goto(`${authPortal}${path}`);
        await expect(page.locator(".connect-page > header h1")).toBeVisible();
        if (path === "/account") await page.getByRole("button", { name: "Delete account…" }).click();
        const audit = await new AxeBuilder({ page }).analyze();
        await testInfo.attach(`${encodeURIComponent(path)}-axe`, { body: JSON.stringify(audit), contentType: "application/json" });
        expect(audit.violations.filter(rule => rule.impact === "serious" || rule.impact === "critical"), path).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
      }
      const screenshot = testInfo.outputPath("account.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach("account", { path: screenshot, contentType: "image/png" });
    });
  }
}

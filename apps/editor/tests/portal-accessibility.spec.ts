import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./auth-portal";

const owner = { relationship: "owner", role: "owner", can_manage_members: true };
const overview = {
  user: { id: "person", name: "Example Person", email: "person@example.test", login: null },
  authentication: { provider: "session", registration: "open" },
  subscription: {
    kind: "beta", profiles: ["beta_v1"], permanent: true, usage: null,
    limits: { hosted_storage_bytes: 1_073_741_824, retained_file_bytes: 2_147_483_648,
      max_document_bytes: 2_097_152, max_single_file_bytes: 262_144_000,
      max_mirror_replicas_per_collection: 5, max_application_replicas_per_collection: 10 }
  }, collections: [], hosted_collections: [], grants: [], pending_authorizations: [],
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
        if (path === "/account") {
          await expect(page.getByText("Beta", { exact: true })).toBeVisible();
          await expect(page.getByText("Usage unavailable", { exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Delete account…" }).click();
          await page.locator(".connect-account-list .connect-account-row strong").first().evaluate(element => { element.textContent = "LongCollectionName".repeat(30); });
        }
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

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./auth-portal";

async function chooseItalian(page: Page, picker: Locator, storageKey: string, marker: string) {
  await expect(picker).toHaveAttribute("data-value", "en");
  await picker.click();
  const list = page.locator(`[id="${await picker.getAttribute("aria-controls")}"]`);
  await expect(list.getByRole("option")).toHaveCount(10);
  const italian = list.locator('[role="option"][data-value="it"]');
  await expect(italian).toHaveText("Italiano");
  // This response must arrive after the explicit choice, not on English startup.
  const chunk = page.waitForResponse(async (response) =>
    new URL(response.url()).origin === new URL(page.url()).origin &&
    /\/assets\/messages-[^/]+\.js$/.test(new URL(response.url()).pathname) &&
    response.ok() && (await response.text()).includes(marker));
  await italian.click();
  await chunk;
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("it");
  await expect(page.locator("html")).toHaveAttribute("lang", "it");
}

test("Italian editor picker loads its own chunk and renders singular/plural notes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("?demo=1&surface=settings");
  await chooseItalian(page, page.getByRole("combobox", { name: "Interface language", exact: true }),
    "mdbase-editor:locale", "Le note non vengono tradotte.");
  await expect(page.getByText("Scegli la lingua dell'interfaccia in questo browser. Le note non vengono tradotte.")).toBeVisible();
  for (const [count, label] of [[1, "1 nota"], [2, "2 note"]] as const) {
    await page.goto(`?demo=${count}`);
    await expect(page.locator(".list-header p")).toContainText(label);
    await expect(page.locator("html")).toHaveAttribute("lang", "it");
  }
  expect(errors).toEqual([]);
});

test("Italian portal picker loads its own chunk and renders singular/plural collections", async ({ page, authPortal }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const now = new Date().toISOString();
  const overview = {
    user: { id: "italian-smoke", name: "[test] Italian", email: "person@example.com", login: null },
    subscription: null,
    hosted_collections_available: true,
    authentication: { provider: "github", registration: "closed" },
    connectors: ["one", "two"].map((id) => ({ id, name: `[test] ${id}`, last_seen_at: now, created_at: now })),
    collections: ["one", "two", "two"].map((connector_id, index) => ({
      id: `collection-${index}`, connector_id, local_id: `local-${index}`, connector_name: `[test] ${connector_id}`,
      display_name: `[test] Collection ${index}`, spec_version: "1", enabled: true, contracts: [], last_seen_at: now
    })),
    hosted_collections: [], grants: [], pending_authorizations: []
  };
  const account = {
    backend: "next", user: overview.user,
    authentication: { managed: true, current_provider: "session", identities: [], available_providers: { github: false, google: false, password: true },
      password: { configured: true, change_available: true, current: true, email: overview.user.email } },
    storage: { status: "available", collections: [], total_storage_bytes: 0 },
    email_preferences: { announcements: true, product_updates: false },
    deletion: { available: true, owned_collections: 0, hosted_collections: 0, local_collections: 0, computers: 2, development_confirmation: true }
  };
  await page.route(`${authPortal}/v1/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === "/v1/ui-configuration" ? { editor_url: "http://editor.test/connect" }
      : path === "/v1/account" ? account : path === "/v1/account/sessions" ? { sessions: [] } : overview });
  });
  await page.goto(`${authPortal}/account`);
  await chooseItalian(page, page.getByRole("combobox", { name: "Language", exact: true }),
    "mdbase:portal:locale", "raccolte");
  await page.goto(`${authPortal}/computers`);
  await expect(page.getByText(/1 raccolta ·/)).toBeVisible();
  await expect(page.getByText(/2 raccolte ·/)).toBeVisible();
  await page.goto(`${authPortal}/account`);
  await expect(page.getByRole("combobox", { name: "Lingua", exact: true })).toHaveAttribute("data-value", "it");
  expect(errors).toEqual([]);
});

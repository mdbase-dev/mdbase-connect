import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

export async function portalLifecycleE2E({
  controlUrl,
  providerUrl,
  internalToken,
  rawRequest
}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${controlUrl}/login`);
    await page.getByRole("button", { name: "Continue" }).click();
    // A new account lands on Home, which sends its first collection to Collections.
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Add collection", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();

    await expect(page.getByRole("button", { name: "Add collection" })).toHaveCount(0);
    await page.getByRole("button", { name: /^New collection/ }).click();
    await page.getByLabel("Collection name").fill("Browser E2E collection");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "Collections", exact: true }).click();
    const row = page.locator(".connect-collection-row").filter({
      hasText: "Browser E2E collection"
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Cloud copy");

    const dashboard = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/me`, { credentials: "include" });
      return response.json();
    }, controlUrl);
    const collectionId = dashboard.hosted_collections.find(
      (collection) => collection.display_name === "Browser E2E collection"
    ).id;
    const uiConfiguration = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/ui-configuration`, { credentials: "include" });
      if (!response.ok) throw new Error("Editor configuration unavailable");
      return response.json();
    }, controlUrl);
    assert.ok(uiConfiguration.editor_url, "The fixture must configure a separate Editor");
    const editorUrl = new URL("/", uiConfiguration.editor_url);
    assert.notEqual(editorUrl.origin, new URL(controlUrl).origin, "Editor and management are distinct origins");
    editorUrl.searchParams.set("server", controlUrl);
    editorUrl.searchParams.set("collection", collectionId);
    await expect(row.getByRole("link", { name: "Open in editor: Browser E2E collection", exact: true }))
      .toHaveAttribute("href", editorUrl.href);

    // The portal no longer approves a new synced folder, so the folder that the
    // Storage tab lists and disconnects is registered through the account route.
    const registered = await page.evaluate(async ({ server, collection }) => {
      const response = await fetch(`${server}/v1/hosted/collections/${collection}/replicas`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Browser writable mirror", mode: "read_write", allowed_types: [] })
      });
      return response.status;
    }, { server: controlUrl, collection: collectionId });
    assert.equal(registered, 201, "The synced folder was not registered");

    await page.goto(controlUrl);
    await page.getByRole("link", { name: "Collections", exact: true }).click();
    const connectedRow = page.locator(".connect-collection-row").filter({
      hasText: "Browser E2E collection"
    });
    await connectedRow.getByRole("link", { name: "Browser E2E collection", exact: true }).click();
    await page.getByRole("link", { name: "Storage", exact: true }).click();
    const replicaRow = page.locator(".connect-row").filter({ hasText: "Browser writable mirror" });
    await expect(replicaRow).toContainText("Edits sync both ways");
    await replicaRow.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Browser writable mirror", { exact: true })).toHaveCount(0, { timeout: 20_000 });
    await page.getByRole("link", { name: "Collections", exact: true }).click();
    await connectedRow.getByRole("button", { name: "Actions for Browser E2E collection" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox", { name: "Rename Browser E2E collection" }).fill("Browser renamed collection");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    const renamedRow = page.locator(".connect-collection-row").filter({
      hasText: "Browser renamed collection"
    });
    await expect(renamedRow).toBeVisible({ timeout: 20_000 });
    await renamedRow.getByRole("button", { name: "Actions for Browser renamed collection" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const deletion = page.getByRole("dialog");
    await deletion.getByLabel("Type Browser renamed collection to confirm").fill("Browser renamed collection");
    await deletion.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByText("Browser renamed collection", { exact: true })).toHaveCount(0, {
      timeout: 20_000
    });

    await expect(page.getByRole("button", { name: "Add collection" })).toHaveCount(0);
    await page.getByRole("button", { name: /^New collection/ }).click();
    await page.getByLabel("Collection name").fill("Account deletion collection");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const deletionCollection = page.locator(".connect-collection-row").filter({
      hasText: "Account deletion collection"
    });
    await expect(deletionCollection).toBeVisible();
    const deletionDashboard = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/me`, { credentials: "include" });
      return response.json();
    }, controlUrl);
    const deletionCollectionId = deletionDashboard.hosted_collections.find(
      (collection) => collection.display_name === "Account deletion collection"
    ).id;

    await page.getByRole("link", { name: "Account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText(
      "Account deletion collection",
      { exact: true }
    )).toBeVisible();
    const account = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/account`, { credentials: "include" });
      return response.json();
    }, controlUrl);
    const accountCollection = account.storage.collections.find(
      (collection) => collection.id === deletionCollectionId
    );
    assert.equal(account.storage.status, "available");
    assert.equal(accountCollection.usage.collection_id, deletionCollectionId);
    assert.equal(accountCollection.usage.max_content_bytes, 1024 * 1024 * 1024);
    await page.getByRole("button", { name: "Delete account…" }).click();
    const accountDeletion = page.getByRole("dialog", { name: "Delete account" });
    await expect(accountDeletion.getByText(/Local files are never removed/)).toBeVisible();
    await expect(page.getByText(
      "Local collection and mirror files remain on your computers.",
      { exact: true }
    )).toBeVisible();
    await page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await page.getByRole("button", { name: "Delete account permanently" }).click();
    await expect(page).toHaveURL(new URL("/account-deleted", controlUrl).href);
    await expect(page.getByRole("heading", { name: "Your account has been deleted." }))
      .toBeVisible();
    await expect(page.getByText(/Hosted data deletion continues automatically/))
      .toBeVisible();
    await expect.poll(async () => (
      await rawRequest(
        providerUrl,
        `/internal/v1/collections/${deletionCollectionId}/usage`,
        { token: internalToken }
      )
    ).status, { timeout: 20_000 }).toBe(404);
  } finally {
    await browser.close();
  }
}


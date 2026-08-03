import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

export async function portalLifecycleE2E({
  controlUrl,
  providerUrl,
  browserMirrorDirectory,
  repoRoot,
  internalToken,
  mirrorProfileDirectory,
  waitForOutput,
  execute,
  rawRequest
}) {
  const browser = await chromium.launch({ headless: true });
  let connector;
  try {
    const page = await browser.newPage();
    await page.goto(`${controlUrl}/login`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New hosted collection" }).click();
    await page.getByLabel("Collection name").fill("Browser E2E collection");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "All collections" }).click();
    const row = page.locator(".connect-collection-row").filter({
      hasText: "Browser E2E collection"
    });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Hosted by mdbase");

    const dashboard = await page.evaluate(async (server) => {
      const response = await fetch(`${server}/v1/me`, { credentials: "include" });
      return response.json();
    }, controlUrl);
    const collectionId = dashboard.hosted_collections.find(
      (collection) => collection.display_name === "Browser E2E collection"
    ).id;
    const editorUrl = new URL("/", page.url());
    editorUrl.searchParams.set("collection", collectionId);
    editorUrl.searchParams.set("server", controlUrl);
    await expect(row.getByRole("link", { name: "Open", exact: true }))
      .toHaveAttribute("href", editorUrl.href);
    await expect(row.getByRole("link", { name: "Sync folder" }))
      .toHaveAttribute("href", `mdbase-connect://mirror?collection=${collectionId}`);

    const mirrorCli = join(repoRoot, "packages", "sync", "dist", "cli.js");
    connector = spawn(process.execPath, [
      mirrorCli,
      "connect",
      browserMirrorDirectory,
      "--server", controlUrl,
      "--collection", collectionId,
      "--name", "Browser writable mirror",
      "--no-open"
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let connectorOutput = "";
    let connectorError = "";
    connector.stdout.on("data", (chunk) => { connectorOutput += chunk; });
    connector.stderr.on("data", (chunk) => { connectorError += chunk; });
    const verificationUri = await waitForOutput(
      () => connectorOutput.match(/https?:\/\/[^\s]+\/mirror\/[0-9a-f-]+/)?.[0],
      "Mirror CLI did not print a browser approval URL"
    );
    await page.goto(verificationUri);
    await expect(page.getByRole("heading", { name: "Browser writable mirror" })).toBeVisible();
    await expect(page.getByLabel("Hosted collection").locator("option:checked"))
      .toHaveText("Browser E2E collection");
    await page.getByRole("button", { name: "Sync this collection" }).click();
    await expect(page.getByRole("heading", { name: "Return to your computer." })).toBeVisible();
    const connectorExit = connector.exitCode
      ?? await new Promise((resolveExit) => connector.once("exit", resolveExit));
    assert.equal(connectorExit, 0, `Mirror CLI failed:\n${connectorError}\n${connectorOutput}`);
    assert.match(connectorOutput, /Sync connected/);
    await assert.rejects(
      () => readFile(join(browserMirrorDirectory, ".mdbase", "connect-mirror.json"), "utf8"),
      { code: "ENOENT" }
    );
    assert.equal(
      (
        await stat(join(await mirrorProfileDirectory(browserMirrorDirectory), "credentials.json"))
      ).mode & 0o777,
      0o600
    );
    const browserStatus = JSON.parse(
      (await execute(process.execPath, [mirrorCli, "status", browserMirrorDirectory, "--json"])).stdout
    );
    assert.equal(browserStatus.state, "up_to_date");

    await page.goto(controlUrl);
    await page.getByRole("link", { name: "All collections" }).click();
    const connectedRow = page.locator(".connect-collection-row").filter({
      hasText: "Browser E2E collection"
    });
    await connectedRow.getByText("Synced folders", { exact: true }).click();
    await expect(connectedRow).toContainText("Browser writable mirror");
    await expect(connectedRow).toContainText("Two-way sync");
    await connectedRow.getByRole("button", { name: "Revoke" }).click();
    await connectedRow.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(connectedRow.getByText("Browser writable mirror")).toHaveCount(0, {
      timeout: 20_000
    });

    await connectedRow.getByRole("button", { name: "Rename" }).click();
    await connectedRow.getByLabel("Rename Browser E2E collection")
      .fill("Browser renamed collection");
    await connectedRow.getByRole("button", { name: "Save", exact: true }).click();
    const renamedRow = page.locator(".connect-collection-row").filter({
      hasText: "Browser renamed collection"
    });
    await expect(renamedRow).toBeVisible({ timeout: 20_000 });
    await renamedRow.getByRole("button", { name: "Delete" }).click();
    await renamedRow.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByText("Browser renamed collection", { exact: true })).toHaveCount(0, {
      timeout: 20_000
    });

    await page.getByRole("button", { name: "New hosted collection" }).click();
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

    await page.getByRole("link", { name: "Account & sessions" }).click();
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
    await expect(page.getByText(/Local files are never removed/)).toBeVisible();
    await expect(page.getByText(
      "Local collection and mirror files remain on your computers.",
      { exact: true }
    )).toBeVisible();
    await page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await page.getByRole("button", { name: "Delete account permanently" }).click();
    await expect(page).toHaveURL(/\/connect\/account-deleted(?:\?.*)?$/);
    await expect(page.getByRole("heading", { name: "Your account has been deleted." }))
      .toBeVisible();
    assert.equal(
      (
        await rawRequest(
          providerUrl,
          `/internal/v1/collections/${deletionCollectionId}/usage`,
          { token: internalToken }
        )
      ).status,
      404
    );
    assert.match(
      await readFile(join(browserMirrorDirectory, "mdbase.yaml"), "utf8"),
      /spec_version: 0\.3\.0/
    );
  } finally {
    if (connector?.exitCode === null && connector.signalCode === null) connector.kill("SIGTERM");
    await browser.close();
  }
}


import { expect, test, type Route } from "@playwright/test";

const serverUrl = "https://connect.mdbase.dev";
const manifestPath = ".well-known/mdbase-app.json";
const loopbackUrl = "http://127.0.0.1:28485";

test("recovers from a stale local grant without bypassing the connector", async ({ page }) => {
  const directOperations: string[] = [];
  const relayedOperations: string[] = [];

  await page.route(`${loopbackUrl}/**`, async (route) => {
    directOperations.push(route.request().url());
    await json(route, {
      error: {
        code: "direct_operation_rejected",
        message: "The local connector rejected this operation."
      }
    }, 403);
  });
  await page.route(`${serverUrl}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/apps/discover") {
      await json(route, {
        application: {
          id: "20000000-0000-4000-8000-000000000002",
          name: "mdbase editor",
          homepage: "http://127.0.0.1"
        }
      });
      return;
    }
    if (url.pathname.startsWith("/v1/collections/")) {
      relayedOperations.push(url.pathname);
      await json(route, { error: { code: "unexpected_relay", message: "Not expected." } }, 500);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Authorize mdbase editor</title>"
    });
  });

  await page.addInitScript(async ({ configuredServerUrl, configuredManifestPath }) => {
    const manifestUrl = new URL(configuredManifestPath, location.href).href;
    const grantHandle = "grant:stale-editor";
    const applicationKey = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    ) as CryptoKeyPair;
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      await crypto.subtle.exportKey("pkcs8", applicationKey.privateKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );
    const applicationPublicKey = base64Url(await crypto.subtle.exportKey("raw", applicationKey.publicKey));
    const connectorKey = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    ) as CryptoKeyPair;
    const connectorPublicKey = base64Url(await crypto.subtle.exportKey("raw", connectorKey.publicKey));
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("mdbase-connect-keys", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("grant-keys", { keyPath: "handle" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("grant-keys", "readwrite");
      transaction.objectStore("grant-keys").add({
        handle: grantHandle,
        privateKey,
        publicKey: applicationPublicKey,
        counter: "0"
      });
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
    database.close();

    localStorage.setItem(
      `mdbase-connect:token:${configuredServerUrl}:${manifestUrl}`,
      JSON.stringify({
        accessToken: "mdb_stale",
        refreshToken: "ref_stale",
        clientId: "20000000-0000-4000-8000-000000000002",
        collectionId: "30000000-0000-4000-8000-000000000003",
        operations: [
          "describe", "changes", "read", "query", "validate", "create", "update",
          "delete", "rename", "read_type", "create_type", "update_type"
        ],
        scope: { contracts: [] },
        expiresAt: Date.now() + 60_000,
        refreshExpiresAt: Date.now() + 120_000,
        grantId: "40000000-0000-4000-8000-000000000004",
        encryption: {
          protocol_version: 3,
          suite: "P256-HKDF-SHA256-AES256GCM",
          key_id: "enc_stale",
          scope_epoch: 1,
          connector_id: "50000000-0000-4000-8000-000000000005",
          collection_id: "30000000-0000-4000-8000-000000000003",
          application_public_key: applicationPublicKey,
          connector_public_key: connectorPublicKey
        },
        applicationOrigin: location.origin,
        keyHandle: grantHandle
      })
    );
    localStorage.setItem(`mdbase-connect:direct:${location.origin}`, "enabled");

    function base64Url(value: ArrayBuffer): string {
      return btoa(String.fromCharCode(...new Uint8Array(value)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    }
  }, { configuredServerUrl: serverUrl, configuredManifestPath: manifestPath });

  await page.goto("/");

  await expect(page.getByRole("alert")).toHaveText(
    "This collection needs authorization again. Choose the collection to continue."
  );
  await expect(page.getByRole("button", { name: "Choose a collection" })).toBeVisible();
  expect(directOperations.length).toBeGreaterThan(0);
  expect(relayedOperations).toEqual([]);
  expect(await page.evaluate(({ configuredServerUrl, configuredManifestPath }) => {
    const manifestUrl = new URL(configuredManifestPath, location.href).href;
    return localStorage.getItem(`mdbase-connect:token:${configuredServerUrl}:${manifestUrl}`);
  }, { configuredServerUrl: serverUrl, configuredManifestPath: manifestPath })).toBeNull();

  await page.getByRole("button", { name: "Choose a collection" }).click();

  await expect(page).toHaveURL(/connect\.mdbase\.dev\/oauth\/authorize/);
});

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body)
  });
}

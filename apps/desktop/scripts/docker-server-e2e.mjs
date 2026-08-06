import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chromium, _electron as electron } from "playwright-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  availablePort,
  startConnectTestEnvironment,
  waitForReady
} from "../../../scripts/lib/connect-test-environment.mjs";
import {
  MdbaseConnect
} from "../../../packages/client/dist/index.js";
import { requireConnectSuccess } from "../../../packages/testing/dist/index.js";
import {
  MemoryApplicationIdentityStore,
  MemoryGrantKeyStore
} from "../../../packages/client/dist/crypto-entry.js";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const executable = resolve(
  repoRoot,
  `target/debug/mdbase${process.platform === "win32" ? ".exe" : ""}`
);
const run = promisify(execFile);
await run("pnpm", ["--filter", "mdbase-editor", "build"], { cwd: repoRoot });
let editor;
let scratch;
let pairingData;
let connectedData;
let collectionPath;
let loopbackPort;
let environment;
let pairingApp;
let connectedApp;
let portalBrowser;

try {
  editor = await startEditorServer();
  scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-desktop-docker-"));
  pairingData = join(scratch, "pairing-profile");
  connectedData = join(scratch, "connected-profile");
  collectionPath = join(scratch, "fixture-collection");
  loopbackPort = await availablePort();
  environment = await startConnectTestEnvironment({
    allowLocalApps: true,
    editorOrigin: editor.origin
  });

  phase("pairing an isolated Electron profile with the Docker server");
  pairingApp = await launchDesktop(pairingData);
  await pairingApp.evaluate(({ app, shell }) => {
    shell.openExternal = async () => "";
    app.relaunch = () => {};
    app.exit = () => {};
  });
  const pairingWindow = await pairingApp.firstWindow({ timeout: 30_000 });
  pairingWindow.setDefaultTimeout(30_000);
  await pairingWindow
    .getByRole("heading", { name: "Connect this computer." })
    .waitFor();
  await pairingWindow
    .getByText("Use another Connect server", { exact: true })
    .click();
  await pairingWindow
    .getByLabel("Server address")
    .fill(environment.serverUrl);
  await pairingWindow
    .getByLabel("Computer name")
    .fill("Docker test computer");
  await pairingWindow
    .getByRole("button", { name: "Continue in browser" })
    .click();

  const waiting = pairingWindow
    .getByRole("status")
    .filter({ hasText: "Waiting for browser approval" });
  await waiting.waitFor();
  const verificationUri = await waiting.locator("code").textContent();
  assert.ok(verificationUri, "Electron did not display a verification URI");
  const pairingId = new URL(verificationUri).pathname.split("/").at(-1);
  assert.ok(pairingId, "Electron did not display a pairing ID");

  phase("approving the computer through the packaged portal");
  portalBrowser = await chromium.launch({ headless: true });
  const portalContext = await portalBrowser.newContext();
  const portalPage = await portalContext.newPage();
  portalPage.setDefaultTimeout(30_000);
  await portalPage.goto(verificationUri);
  await portalPage.getByLabel("Name").fill("Desktop Docker E2E");
  await portalPage
    .getByLabel("Email")
    .fill("desktop-docker-e2e@example.com");
  await portalPage.getByRole("button", { name: "Continue" }).click();
  await portalPage
    .getByRole("heading", { name: "Docker test computer" })
    .waitFor();
  await portalPage
    .getByRole("button", { name: "Approve computer" })
    .click();
  await portalPage
    .getByRole("heading", { name: "Return to mdbase connect." })
    .waitFor();
  const sessionCookie = (await portalContext.cookies(environment.serverUrl))
    .find((candidate) => candidate.name === "mdbase_session");
  assert.ok(sessionCookie, "Portal login did not retain a session cookie");
  const cookie = `${sessionCookie.name}=${sessionCookie.value}`;
  await pairingWindow
    .getByText("Computer approved. Connecting securely…")
    .waitFor({ timeout: 10_000 });
  await pairingWindow
    .getByText("mdbase connect is restarting with the new secure connection.")
    .waitFor();

  const stored = JSON.parse(
    await readFile(join(pairingData, "connect-home", "cloud.json"), "utf8")
  );
  assert.equal(stored.server_url, environment.serverUrl);
  const secrets = JSON.parse(
    await readFile(
      join(pairingData, "connect-home", "test-secrets.json"),
      "utf8"
    )
  );
  const connectorToken = secrets.values.connector;
  assert.match(connectorToken, /^con_/);
  await pairingApp.close();
  pairingApp = undefined;

  phase("running the real connector against the disposable credential");
  connectedApp = await launchDesktop(connectedData, connectorToken);
  const connectedWindow = await connectedApp.firstWindow({ timeout: 30_000 });
  connectedWindow.setDefaultTimeout(30_000);
  await connectedWindow
    .getByText("Connected securely")
    .waitFor({ timeout: 20_000 });
  const account = await connectedWindow.evaluate(() =>
    window.mdbaseConnect.accessSnapshot()
  );
  assert.equal(account.online, true);
  assert.equal(account.account.connector_name, "Docker test computer");
  assert.equal(
    account.account.user_email,
    "desktop-docker-e2e@example.com"
  );

  phase("creating a real fixture collection through Electron and the agent");
  const created = await connectedWindow.evaluate(
    ({ path }) =>
      window.mdbaseConnect.createCollection({
        path,
        name: "Docker fixture",
        timezone: "UTC"
      }),
    { path: collectionPath }
  );
  assert.equal(created.display_name, "Docker fixture");
  await connectedWindow
    .getByRole("button", { name: /Collections/ })
    .click();
  await connectedWindow
    .getByText("Docker fixture", { exact: true })
    .waitFor({ timeout: 10_000 });

  phase("authorizing a consumer and routing an operation through Docker");
  const dashboard = await waitForValue(
    async () => {
      const response = await fetch(`${environment.serverUrl}/v1/me`, {
        headers: { cookie }
      });
      return response.json();
    },
    (value) => value.collections?.length === 1,
    15_000
  );
  const collection = dashboard.collections[0];
  const manifest = {
    manifest_version: 1,
    id: "dev.mdbase.desktop-docker-e2e",
    name: "Docker fixture consumer",
    homepage: "https://desktop-docker-e2e.example",
    redirect_uris: ["https://desktop-docker-e2e.example/callback"],
    requirements: { contracts: [], access: "full_collection" },
    provisions: { type_packs: [] },
    notifications: { criteria: [] }
  };
  await portalPage.route(
    "https://desktop-docker-e2e.example/**",
    (route) => route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "Consumer callback reached"
    })
  );
  const consumerStorage = memoryStorage();
  let authorizationUrl;
  const consumer = new MdbaseConnect({
    serverUrl: environment.serverUrl,
    manifest,
    redirectUri: manifest.redirect_uris[0],
    storage: consumerStorage,
    keyStore: new MemoryGrantKeyStore(),
    identityStore: new MemoryApplicationIdentityStore(),
    navigate: (value) => { authorizationUrl = value; }
  });
  const authorization = consumer.authorize({
    operations: ["describe"],
    target: { kind: "collection", collectionId: collection.id }
  });
  await waitForValue(
    async () => authorizationUrl,
    (value) => typeof value === "string",
    15_000
  );
  await portalPage.goto(authorizationUrl);
  await portalPage
    .getByRole("heading", { name: "Docker fixture consumer" })
    .waitFor();
  await portalPage
    .locator(".selected-collection-summary")
    .filter({ hasText: "Docker fixture" })
    .waitFor({ state: "attached", timeout: 15_000 });
  await portalPage
    .getByRole("button", { name: "Allow Docker fixture consumer" })
    .click();
  await portalPage.waitForURL("https://desktop-docker-e2e.example/callback**", {
    timeout: 15_000
  });
  assert.deepEqual(requireConnectSuccess(await authorization), { kind: "redirecting" });
  const authorized = requireConnectSuccess(
    await consumer.completeAuthorization(portalPage.url())
  );
  const described = requireConnectSuccess(
    await authorized.connection.describe()
  );
  assert.equal(described.displayName, "Docker fixture");
  const token = consumerStorage.token();
  assert.match(token.accessToken, /^mdb_/);
  assert.ok(token.grantId);
  await connectedWindow.getByRole("button", { name: "App access" }).click();
  await connectedWindow
    .locator("details.application-grant-group")
    .filter({ hasText: "Docker fixture consumer" })
    .waitFor({ timeout: 10_000 });

  phase("reviewing and revoking application access through the editor");
  const applicationsUrl = new URL("/connect/applications", editor.origin);
  applicationsUrl.searchParams.set("server", environment.serverUrl);
  await portalPage.goto(applicationsUrl.href);
  await portalPage
    .getByRole("heading", { name: "Applications", exact: true })
    .waitFor();
  const portalApplication = portalPage
    .locator("details.connect-application")
    .filter({ hasText: "Docker fixture consumer" });
  await portalApplication.waitFor();
  await portalApplication.locator(":scope > summary").click();
  const portalGrant = portalApplication
    .locator("details.connect-grant")
    .filter({ hasText: "Docker fixture" });
  await portalGrant.locator(":scope > summary").click();
  await portalGrant.getByRole("button", { name: "Revoke", exact: true }).click();
  await portalGrant.getByRole("button", { name: "Revoke", exact: true }).click();
  await portalApplication.waitFor({ state: "detached" });
  await waitForValue(
    () => connectedWindow.evaluate(() => window.mdbaseConnect.accessSnapshot()),
    (snapshot) => !snapshot.grants.some((grant) => grant.id === token.grantId),
    10_000
  );
  const revoked = await jsonRequest(
    `/v1/authorities/${collection.id}/operations/describe`,
    {
      method: "POST",
      authorization: `Bearer ${token.accessToken}`,
      body: {
        protocol_version: 1,
        request_id: randomUUID(),
        input: {}
      }
    }
  );
  assert.equal(revoked.response.status, 401);

  phase("enforcing local pause and recovering from a server restart");
  await connectedWindow.evaluate(() =>
    window.mdbaseConnect.setAccessPaused(true)
  );
  await connectedWindow
    .getByRole("button", { name: /Overview/ })
    .click();
  await connectedWindow
    .getByRole("heading", { name: "Access is paused." })
    .waitFor({ timeout: 10_000 });
  await connectedWindow.evaluate(() =>
    window.mdbaseConnect.setAccessPaused(false)
  );
  await connectedWindow
    .getByRole("heading", { name: "This computer is ready." })
    .waitFor({ timeout: 10_000 });

  await environment.compose(["restart", "connect"]);
  await waitForReady(environment.serverUrl);
  await waitForValue(
    () => connectedWindow.evaluate(() => window.mdbaseConnect.accessSnapshot()),
    (snapshot) => snapshot.online === true,
    20_000
  );
  const persisted = await fetch(`${environment.serverUrl}/v1/connectors/control`, {
    headers: { authorization: `Bearer ${connectorToken}` }
  });
  assert.equal(persisted.status, 200);

  process.stdout.write("Docker-backed Electron end-to-end path passed\n");
} catch (error) {
  await environment?.compose(["logs", "--no-color"]).catch(() => {});
  throw error;
} finally {
  for (const userData of [pairingData, connectedData].filter(Boolean)) {
    await run(executable, [
      "--state-dir",
      resolve(userData, "connect-home"),
      "connect",
      "daemon",
      "stop"
    ]).catch(() => {});
  }
  await connectedApp?.close().catch(() => {});
  await pairingApp?.close().catch(() => {});
  await portalBrowser?.close().catch(() => {});
  await environment?.close().catch(() => {});
  if (editor) {
    await new Promise((resolveClose) => editor.server.close(resolveClose));
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

async function startEditorServer() {
  const root = join(repoRoot, "apps", "editor", "dist");
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://editor.test").pathname;
      const asset = pathname.startsWith("/assets/") ? pathname.slice(1) : "index.html";
      if (!/^(?:index\.html|assets\/[A-Za-z0-9_.-]+)$/u.test(asset)) {
        response.writeHead(404).end();
        return;
      }
      const contentType = asset.endsWith(".js")
        ? "text/javascript"
        : asset.endsWith(".css")
          ? "text/css"
          : asset.endsWith(".woff2")
            ? "font/woff2"
            : asset.endsWith(".woff")
              ? "font/woff"
              : "text/html";
      response.setHeader("content-type", contentType);
      response.end(await readFile(join(root, asset)));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Editor server is unavailable");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function launchDesktop(userData, connectorToken) {
  return electron.launch({
    cwd: desktopRoot,
    args: [
      ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
      ".",
      `--user-data-dir=${userData}`
    ],
    env: {
      ...process.env,
      MDBASE_CONNECT_BIN: executable,
      MDBASE_CONNECT_HOME: resolve(userData, "connect-home"),
      MDBASE_CONNECT_ENV: "test",
      MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file",
      MDBASE_CONNECT_LOOPBACK_PORT: String(loopbackPort),
      MDBASE_CONNECT_USER_DATA_DIR: userData,
      ...(connectorToken
        ? {
            MDBASE_CONNECT_SERVER_URL: environment.serverUrl,
            MDBASE_CONNECT_CONNECTOR_TOKEN: connectorToken
          }
        : {})
    }
  });
}

async function jsonRequest(path, options = {}) {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.authorization) {
    headers.set("authorization", options.authorization);
  }
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${environment.serverUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return {
    response,
    body: await response.json().catch(() => null)
  };
}

async function waitForValue(read, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for Electron state: ${JSON.stringify(value)}`);
}

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
    token() {
      const value = [...values.entries()]
        .find(([key]) => key.includes(":token:"))?.[1];
      assert.ok(value, "SDK did not persist the desktop Docker E2E token");
      return JSON.parse(value);
    }
  };
}

function phase(message) {
  process.stdout.write(`\n== ${message}\n`);
}

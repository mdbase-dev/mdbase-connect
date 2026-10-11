import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../dist/renderer");
let browser;
let server;
let origin;
before(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
    try {
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
      response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((ready, reject) => { server.once("error", reject); server.listen(42390, "127.0.0.1", ready); });
  origin = "http://127.0.0.1:42390";
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
});

// Lean UX checks for the daemon-backed renderer, on a mocked preload API. Pure
// presentation (wording, grouping) is covered by test/daemon-view.test.mjs.
async function desktop({ signedIn = true, collections = [], access = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(({ signedIn, collections, access }) => {
    const calls = [];
    const record = (name) => async (...args) => { calls.push([name, ...args]); return null; };
    const fixture = {
      calls, collections, access, requireApproval: false,
      account: { configured: signedIn, serverUrl: signedIn ? "https://connect.example.test" : null, online: signedIn, pairing: null, lastError: null },
      status: () => ({ target: "isolated_profile", state_dir: "/disposable", account: { signed_in: fixture.account.configured, online: fixture.account.configured }, collections: fixture.collections })
    };
    window.fixture = fixture;
    window.mdbaseConnect = {
      status: async () => fixture.status(),
      updateStatus: async () => ({ phase: "unavailable", current_version: "test", channel: "beta", message: "Development build", can_check: false, can_install: false }),
      migrationStatus: async () => fixture.migration ?? { record: null, running: false },
      listCollections: async () => fixture.collections,
      getCloudConfig: async () => ({ ...fixture.account }),
      listAccess: async () => fixture.access,
      getSettings: async () => ({ require_grant_approval: fixture.requireApproval }),
      getLaunchAtLogin: async () => ({ enabled: false, available: false }),
      addCollection: record("addCollection"),
      chooseCreateFolder: async () => "/disposable/parent",
      createCollection: async (input) => { calls.push(["createCollection", input]); return { name: input.name }; },
      enableSync: record("enableSync"),
      removeCollection: record("removeCollection"),
      listHolds: async () => [],
      listActivity: async () => fixture.activity ?? [],
      updateCollection: async (id, changes) => { calls.push(["updateCollection", id, changes]); if (fixture.failUpdate) throw new Error(fixture.failUpdate); return { ...fixture.collections[0], ...changes }; },
      renameComputer: async (name) => { calls.push(["renameComputer", name]); fixture.account = { ...fixture.account, computerName: name }; return { name }; },
      approveAccess: record("approveAccess"),
      acknowledgeAccess: record("acknowledgeAccess"),
      revokeAccess: record("revokeAccess"),
      denyAccess: record("denyAccess"),
      signIn: async () => {
        calls.push(["signIn"]);
        fixture.account = { ...fixture.account, pairing: "https://connect.example.test/pair/same-request", lastError: null };
        return { verificationUri: fixture.account.pairing, expiresIn: 600 };
      },
      reopenSignIn: async () => {},
      onNavigate: () => () => {}, onUpdateStatus: () => () => {}
    };
  }, { signedIn, collections, access });
  await page.goto(origin);
  await page.getByText(signedIn ? "Connected securely" : "Not signed in", { exact: true }).first().waitFor();
  const calls = (name) => page.evaluate((name) => window.fixture.calls.filter((call) => call[0] === name).map((call) => call.slice(1)), name);
  return { page, errors, calls };
}

const nav = (page, name) => page.locator(".product-sidebar-link").filter({ hasText: name });

async function screenshot(page, name) {
  if (process.env.CONNECTOR_UX_SHOTS) await page.screenshot({ path: `${process.env.CONNECTOR_UX_SHOTS}/${name}.png`, fullPage: true });
}

const collection = (overrides = {}) => ({
  id: "c-notes", name: "Notes", root: "/disposable/a/very/long/path/that/should/never/push/the/layout/wider/than/the/window/Notes",
  mode: "local", origin: "local", log: "none", state: "ready", notices: [], ...overrides
});

const entry = (overrides = {}) => ({
  grant: "g1", collection: "c-notes", app_id: "reader", app_name: "Reader", client_pk: "pk", capabilities: ["read", "write"],
  state: "active", first_seen_ms: Date.now(), acknowledged: true, ...overrides
});

test("adding a collection asks for sign-in first; one sign-in survives navigation and approval needs no restart", async () => {
  const { page, errors, calls } = await desktop({ signedIn: false });
  try {
    await nav(page, "Collections").click();
    await page.getByRole("button", { name: "Add existing", exact: true }).click();
    await page.getByText("Sign in first, then add your collection.", { exact: true }).waitFor();
    assert.equal((await calls("addCollection")).length, 0);
    await page.getByRole("button", { name: "Sign in with your browser" }).click();
    await page.getByText("Waiting for browser approval", { exact: true }).waitFor();
    await nav(page, "Settings").click();
    await screenshot(page, "sign-in-navigation");
    assert.equal(await page.getByText("Waiting for browser approval", { exact: true }).isVisible(), true);
    await page.evaluate(() => { window.fixture.account = { configured: true, serverUrl: "https://connect.example.test", online: true, pairing: null, lastError: null }; });
    await page.clock.runFor(2_000);
    await nav(page, "Collections").click();
    await page.getByRole("button", { name: "Sign in with your browser" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Add existing", exact: true }).click();
    assert.equal((await calls("signIn")).length, 1);
    assert.equal((await calls("addCollection")).length, 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a failed sign-in shows the daemon's reason and offers a fresh one", async () => {
  const { page, errors } = await desktop({ signedIn: false });
  try {
    await page.getByRole("button", { name: "Sign in with your browser" }).click();
    await page.getByText("Waiting for browser approval", { exact: true }).waitFor();
    await page.evaluate(() => { window.fixture.account = { ...window.fixture.account, pairing: null, lastError: "sign-in expired" }; });
    await page.clock.runFor(2_000);
    await page.getByText("sign-in expired", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign in with your browser" }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("create needs a name and a location, and sends both", async () => {
  const { page, errors, calls } = await desktop();
  try {
    await nav(page, "Collections").click();
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const submit = dialog.getByRole("button", { name: "Create collection" });
    await dialog.getByLabel("Collection name").fill("[test] Workouts");
    assert.equal(await submit.isDisabled(), true, "no location chosen yet");
    const picker = dialog.locator(".folder-picker");
    await picker.click();
    await picker.getByText("/disposable/parent", { exact: true }).waitFor();
    await submit.click();
    await page.getByText("[test] Workouts was created.", { exact: true }).waitFor();
    assert.deepEqual(await calls("createCollection"), [[{ parent: "/disposable/parent", name: "[test] Workouts" }]]);
    await nav(page, "Settings").click();
    assert.equal(await page.getByText("[test] Workouts was created.", { exact: true }).count(), 0, "confirmations do not follow you to other views");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("turning on sync defaults to private and removal is confirmed; long paths stay inside the minimum window", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection()] });
  try {
    await page.setViewportSize({ width: 820, height: 580 });
    await nav(page, "Collections").click();
    const card = page.locator(".collection-card").filter({ hasText: "Notes" });
    await card.getByText("On this computer only · Ready").waitFor();
    await screenshot(page, "collections-minimum");
    assert.equal(await page.locator(".content").evaluate((element) => element.scrollWidth > element.clientWidth), false);
    await card.getByRole("button", { name: "Turn on sync" }).click();
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByRole("radio", { name: /Private/ }).isChecked(), true);
    await dialog.getByRole("button", { name: "Turn on sync" }).click();
    await page.getByText("Notes now syncs privately.", { exact: true }).waitFor();
    assert.deepEqual(await calls("enableSync"), [["c-notes", "private", false]]);
    page.once("dialog", (prompt) => prompt.dismiss());
    await card.getByRole("button", { name: "Remove" }).click();
    assert.deepEqual(await calls("removeCollection"), [], "dismissing the confirmation keeps the collection");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("turning on sync for a taken-over folder shows the files held at takeover and needs them checked", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection()] });
  try {
    await page.evaluate(() => {
      window.fixture.migration = {
        record: { state: "complete", collections: { "c-notes": { state: "held", holds: 1 } } },
        holds: { "c-notes": [{ path: "Inbox/plan.md", reason: "conflict" }] },
        running: false
      };
    });
    await nav(page, "Collections").click();
    await page.locator(".collection-card").filter({ hasText: "Notes" }).getByRole("button", { name: "Turn on sync" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Inbox/plan.md", { exact: true }).waitFor();
    const confirm = dialog.getByRole("button", { name: "Turn on sync" });
    assert.equal(await confirm.isDisabled(), true, "held files must be checked first");
    await dialog.getByRole("checkbox", { name: "I have checked these files" }).check();
    await confirm.click();
    await page.getByText("Notes now syncs privately.", { exact: true }).waitFor();
    assert.deepEqual(await calls("enableSync"), [["c-notes", "private", true]]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("access: pending approvals, new-access notices and revocation reach the daemon", async () => {
  const access = [
    entry({ grant: "pending", app_id: "planner", app_name: "Planner", state: "pending_approval" }),
    entry({ grant: "new", acknowledged: false })
  ];
  const { page, errors, calls } = await desktop({ collections: [collection()], access });
  try {
    assert.equal(await nav(page, "App access").innerText(), "App access\n2");
    await nav(page, "App access").click();
    await page.getByRole("button", { name: "Approve…" }).click();
    assert.deepEqual(await calls("approveAccess"), [["pending"]]);
    const reader = page.locator(".application-grant-group").filter({ hasText: "Reader" });
    await reader.getByText("Notes", { exact: true }).waitFor();
    await reader.getByRole("button", { name: "Mark as seen" }).click();
    assert.deepEqual(await calls("acknowledgeAccess"), [["new"]]);
    page.once("dialog", (prompt) => prompt.accept());
    await reader.getByRole("button", { name: "Revoke" }).click();
    await page.getByText("Reader can no longer use Notes through this computer.", { exact: true }).waitFor();
    assert.deepEqual(await calls("revokeAccess"), [["new"]]);
    await screenshot(page, "access");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a stopped daemon never leaves a stale connected indicator, and recovery is automatic", async () => {
  const { page, errors } = await desktop();
  try {
    await page.evaluate(() => { window.mdbaseConnect.status = async () => { throw new Error("Error invoking remote method 'connect:status': Error: connect ECONNREFUSED"); }; });
    await page.clock.runFor(5_000);
    await page.getByRole("status").filter({ hasText: "mdbase is not running on this computer." }).waitFor();
    assert.equal(await page.getByText("Connected securely", { exact: true }).count(), 0);
    assert.equal(await page.locator(".product-sidebar-status .status-dot").evaluate((element) => getComputedStyle(element).animationName), "none");
    await page.evaluate(() => { window.mdbaseConnect.status = async () => window.fixture.status(); });
    await page.clock.runFor(5_000);
    await page.getByText("Connected securely", { exact: true }).first().waitFor();
    assert.equal(await page.getByText("mdbase is not running on this computer.").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("daemon errors are shown without Electron's IPC method name", async () => {
  const { page, errors } = await desktop();
  try {
    await page.evaluate(() => {
      window.mdbaseConnect.addCollection = async () => { throw new Error("Error invoking remote method 'connect:collections:add': DaemonControlError: That folder is already a collection."); };
    });
    await nav(page, "Collections").click();
    await page.getByRole("button", { name: "Add existing", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("alert").locator("span").innerText(), "That folder is already a collection.");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("collection details keep the draft when saving fails, then save name and description", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection()] });
  try {
    await nav(page, "Collections").click();
    const card = page.locator(".collection-card").filter({ hasText: "Notes" });
    await card.getByRole("button", { name: "Details" }).click();
    await card.getByLabel("Name").fill("Journal");
    await card.getByLabel("Description").fill("Daily notes");
    await page.evaluate(() => { window.fixture.failUpdate = "Error invoking remote method 'connect:collections:update': DaemonControlError: a collection name is 1 to 100 characters"; });
    await card.getByRole("button", { name: "Save details" }).click();
    await card.getByRole("alert").filter({ hasText: "a collection name is 1 to 100 characters" }).waitFor();
    assert.equal(await card.getByLabel("Description").inputValue(), "Daily notes");
    await page.evaluate(() => { window.fixture.failUpdate = null; });
    await card.getByRole("button", { name: "Save details" }).click();
    await page.getByText("Journal was saved.", { exact: true }).waitFor();
    assert.deepEqual((await calls("updateCollection")).at(-1), ["c-notes", { name: "Journal", description: "Daily notes" }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("settings renames this computer; activity lists recent changes", async () => {
  const { page, errors, calls } = await desktop();
  try {
    await page.evaluate(() => {
      window.fixture.account = { ...window.fixture.account, computerName: "laptop" };
      window.fixture.activity = [
        { at_ms: Date.now(), kind: "app_revoked", app_name: "Reader", collection_name: "Notes" },
        { at_ms: Date.now() - 60_000, kind: "collection_added", collection_name: "Notes" }
      ];
    });
    await page.clock.runFor(5_000);
    await nav(page, "Settings").click();
    await page.getByText("laptop", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Computer name").fill("Studio iMac");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("This computer is now called Studio iMac.", { exact: true }).waitFor();
    assert.deepEqual(await calls("renameComputer"), [["Studio iMac"]]);
    await nav(page, "Activity").click();
    const items = page.locator(".activity-list li span");
    assert.deepEqual(await items.allInnerTexts(), ["You revoked Reader on Notes", "Notes was added"]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

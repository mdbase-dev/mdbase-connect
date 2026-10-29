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
  // Port 0: a fixed port in the ephemeral range can already be held by an outbound socket.
  await new Promise((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
});

// Lean UX checks for the daemon-backed renderer, on a mocked preload API. Pure
// presentation (wording, grouping) is covered by test/daemon-view.test.mjs.
async function desktop({ signedIn = true, collections = [], access = [], devices = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(({ signedIn, collections, access, devices }) => {
    const calls = [];
    const record = (name) => async (...args) => { calls.push([name, ...args]); return null; };
    const fixture = {
      calls, collections, access, devices, requireApproval: false,
      account: { configured: signedIn, serverUrl: signedIn ? "https://connect.example.test" : null, online: signedIn, pairing: null, lastError: null },
      status: () => ({ target: "isolated_profile", state_dir: "/disposable", account: { signed_in: fixture.account.configured, online: fixture.account.configured }, collections: fixture.collections })
    };
    window.fixture = fixture;
    window.mdbaseConnect = {
      getLocale: async () => localStorage.getItem("fixture:locale") ?? "en",
      setLocale: async (locale) => { calls.push(["setLocale", locale]); localStorage.setItem("fixture:locale", locale); },
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
      enableSync: async (...args) => {
        calls.push(["enableSync", ...args]);
        const failure = fixture.failEnableSync;
        fixture.failEnableSync = null;
        if (failure) throw new Error(failure);
        return null;
      },
      removeCollection: record("removeCollection"),
      listHolds: async () => fixture.holds ?? [],
      resolveHold: async (id, hold, how) => { calls.push(["resolveHold", id, hold, how]); fixture.holds = (fixture.holds ?? []).filter((h) => h.id !== hold);
        const held = fixture.migration?.holds?.[id];
        if (held) fixture.migration.holds[id] = held.filter((h) => h.id !== hold);
        return null;
      },
      listActivity: async () => fixture.activity ?? [],
      updateCollection: async (id, changes) => { calls.push(["updateCollection", id, changes]); if (fixture.failUpdate) throw new Error(fixture.failUpdate); return { ...fixture.collections[0], ...changes }; },
      renameComputer: async (name) => { calls.push(["renameComputer", name]); fixture.account = { ...fixture.account, computerName: name }; return { name }; },
      approveAccess: record("approveAccess"),
      acknowledgeAccess: record("acknowledgeAccess"),
      revokeAccess: record("revokeAccess"),
      denyAccess: record("denyAccess"),
      listPendingDevices: async () => fixture.devices ?? [],
      approveDevice: async (...args) => { calls.push(["approveDevice", ...args]); fixture.devices = []; return {}; },
      rejectDevice: record("rejectDevice"),
      signIn: async () => {
        calls.push(["signIn"]);
        fixture.account = { ...fixture.account, pairing: "https://connect.example.test/pair/same-request", lastError: null };
        return { verificationUri: fixture.account.pairing, expiresIn: 600 };
      },
      reopenSignIn: async () => {},
      onNavigate: () => () => {}, onUpdateStatus: () => () => {}
    };
  }, { signedIn, collections, access, devices });
  await page.goto(origin);
  await page.getByText(signedIn ? "Connected securely" : "Not signed in", { exact: true }).first().waitFor();
  const calls = (name) => page.evaluate((name) => window.fixture.calls.filter((call) => call[0] === name).map((call) => call.slice(1)), name);
  return { page, errors, calls };
}

test("renderer loads real locale chunks and restores the preload language preference", async () => {
  const { page, errors, calls } = await desktop();
  try {
    await page.locator(".product-sidebar-link").filter({ hasText: "Settings" }).click();
    const picker = page.locator('select:has(option[value="ja"])');
    assert.deepEqual(await picker.locator("option").evaluateAll(options => options.map(option => option.value)),
      ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh", "it"]);
    await picker.selectOption("it");
    await page.waitForFunction(() => document.documentElement.lang === "it");
    await picker.selectOption("ja");
    await page.waitForFunction(() => document.documentElement.lang === "ja");
    assert.deepEqual(await calls("setLocale"), [["it"], ["ja"]]);
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.lang === "ja");
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

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
    await page.evaluate(() => { window.fixture.account = { ...window.fixture.account, pairing: null, lastError: "sign_in_expired" }; });
    await page.clock.runFor(2_000);
    await page.getByText("The sign-in request expired. Start again.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign in with your browser" }).click();
    await page.getByText("Waiting for browser approval", { exact: true }).waitFor();
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

test("a failed turn-on of sync is explained inside the dialog, which stays open for a retry", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection()] });
  try {
    await nav(page, "Collections").click();
    const card = page.locator(".collection-card").filter({ hasText: "Notes" });
    await card.getByRole("button", { name: "Turn on sync" }).click();
    const dialog = page.getByRole("dialog");
    await page.evaluate(() => {
      window.fixture.failEnableSync = "Error invoking remote method 'connect:collections:sync-enable': DaemonControlError: this build has no authenticated trust for synced collections";
    });
    await dialog.getByRole("button", { name: "Turn on sync" }).click();
    const alert = dialog.getByRole("alert");
    await alert.waitFor();
    assert.match(await alert.innerText(), /^This version of mdbase can't turn on sync\. Update mdbase, then try again\. The folder and its files are unchanged\.$/);
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "Turn on sync" }).click();
    await page.getByText("Notes now syncs privately.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal((await calls("enableSync")).length, 2);
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

test("files held at the takeover are resolved one by one before sync turns on", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection()] });
  try {
    await page.evaluate(() => {
      window.fixture.holds = [{ id: "takeover:1", path: "Inbox/plan.md", reason: "taken_over", since: Date.now(), saves: 0, has_theirs: true, binary: false }];
      window.fixture.migration = {
        record: { state: "complete", collections: { "c-notes": { state: "held", holds: 1 } } },
        holds: { "c-notes": [{ id: "takeover:1", path: "Inbox/plan.md", reason: "conflict" }] },
        running: false
      };
    });
    await nav(page, "Collections").click();
    await page.locator(".collection-card").filter({ hasText: "Notes" }).getByRole("button", { name: "Turn on sync" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Inbox/plan.md", { exact: true }).waitFor();
    const confirm = dialog.getByRole("button", { name: "Turn on sync" });
    assert.equal(await confirm.isDisabled(), true, "held files are resolved first");
    assert.equal(await dialog.getByRole("checkbox").count(), 0, "no blanket acceptance when each file can be resolved");
    await dialog.getByRole("button", { name: "Keep both" }).click();
    await dialog.getByText("Inbox/plan.md", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await confirm.isDisabled(), false);
    await confirm.click();
    await page.getByText("Notes now syncs privately.", { exact: true }).waitFor();
    assert.deepEqual(await calls("resolveHold"), [["c-notes", "takeover:1", "keep_both"]]);
    assert.deepEqual(await calls("enableSync"), [["c-notes", "private", false]]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("access: pending approvals, new-access notices and revocation reach the daemon", async () => {
  const access = [
    entry({ grant: "pending", app_id: "planner", app_name: "Planner", state: "pending_approval" }),
    entry({ grant: "new", acknowledged: false }),
    entry({ grant: "log", collection: "c-private", app_name: "Journal", state: "pending_approval", source: "log", terms_unavailable: true })
  ];
  const { page, errors, calls } = await desktop({ collections: [collection(), collection({ id: "c-private", name: "Diary", mode: "synced_e2e" })], access });
  try {
    assert.equal(await nav(page, "App access").innerText(), "App access\n3");
    await nav(page, "App access").click();
    const journal = page.locator(".approval-prompt").filter({ hasText: "Journal wants to use Diary" });
    await journal.getByText("mdbase could not fetch what this app is asking for", { exact: false }).waitFor();
    assert.equal(await journal.getByRole("button", { name: "Approve…" }).isDisabled(), true);
    const planner = page.locator(".approval-prompt").filter({ hasText: "Planner wants to use Notes" });
    await planner.getByText("If you approve, Planner will be able to read notes and create and edit notes in Notes", { exact: false }).waitFor();
    await planner.getByRole("button", { name: "Approve…" }).click();
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

test("access: markup-shaped app names are shown literally in the key check", async () => {
  const name = "<0/> <b>Planner</b>";
  const access = [
    entry({ grant: "keyed", app_name: name, state: "pending_approval", fingerprint: "abcd1234" }),
    entry({ grant: "unkeyed", collection: "c-private", app_name: name, state: "pending_approval" })
  ];
  const { page, errors } = await desktop({ collections: [collection(), collection({ id: "c-private", name: "Diary" })], access });
  try {
    await nav(page, "App access").click();
    await page.getByText(`Check that ${name} shows the same key.`, { exact: true }).waitFor();
    await page.getByText(`mdbase shows the app's key when you approve. Check that ${name} shows the same key.`, { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a new device is approved only with the code shown on its screen", async () => {
  const { page, errors, calls } = await desktop({
    collections: [collection({ id: "c-private", name: "Diary", mode: "synced_e2e" })],
    devices: [{ collection: "c-private", device: "d-laptop", account: "a1", kind: "desktop", code: "482913" }]
  });
  try {
    await nav(page, "Collections").click();
    const prompt = page.locator(".approval-prompt").filter({ hasText: "A new computer wants to open Diary" });
    await prompt.waitFor();
    assert.equal(await nav(page, "Collections").innerText(), "Collections\n1");
    const approve = prompt.getByRole("button", { name: "Approve" });
    assert.equal(await approve.isDisabled(), true);
    await prompt.getByLabel("Enter the six-digit code shown on the new computer").fill("482 914");
    await approve.click();
    await prompt.getByRole("alert").waitFor();
    await screenshot(page, "device-approval");
    assert.deepEqual(await calls("approveDevice"), []);
    await prompt.getByLabel("Enter the six-digit code shown on the new computer").fill("482 913");
    await approve.click();
    await page.getByText("The new computer can now open Diary.", { exact: true }).waitFor();
    assert.deepEqual(await calls("approveDevice"), [["c-private", "d-laptop", "482913"]]);
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

test("collection notices list skipped files and reuse the hold review list", async () => {
  const skipped = [
    { code: "unsupported_entry", path: "notes/latin.md", message: "Not valid UTF-8; note is not synced." },
    { code: "unsupported_entry", path: "notes/linked.md", message: "Symlink not followed." },
    { code: "name_collision", path: "note.md", message: "Case or Unicode name collision with Note.md; file held." }
  ];
  const { page, errors } = await desktop({ collections: [collection({ notices: [...skipped, { code: "file_held", path: "held.md", message: "Changed here and elsewhere; file held." }] })] });
  try {
    await nav(page, "Collections").click();
    for (const notice of skipped) {
      const row = page.locator(".collection-notice").filter({ hasText: notice.path });
      await row.waitFor();
      assert.equal(await row.locator("code").innerText(), notice.path);
      assert.ok((await row.innerText()).includes(notice.message));
    }
    assert.equal(await page.locator(".collection-notice").filter({ hasText: "held.md" }).count(), 0);
    await page.evaluate(() => { window.fixture.collections[0].notices.shift(); });
    await page.clock.runFor(5_000);
    assert.equal(await page.locator(".collection-notice").count(), 2);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

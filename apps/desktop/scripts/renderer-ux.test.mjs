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

async function desktop({ configured = true, hostedOnline = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(({ configured, hostedOnline }) => {
    const mirror = {
      collection_id: "hosted-notes", replica_id: "notes-mirror", name: "Notes", mode: "read_write",
      selective_sync: { file_classes: [], excluded_folders: [] }, path: "/disposable/Notes",
      state: "up_to_date", pending: 0, conflicts: [], local_issues: [], cursor: 1,
      last_synced_at: new Date().toISOString(), syncing: false, promotion_pending: false
    };
    const hosted = {
      online: true, hosted_collections_available: true, grants: [], pending_authorizations: [],
      hosted_collections: [{ id: "hosted-notes", display_name: "Notes", template: "mdbase", sync_url: "https://storage.example.test", spec_version: "0.3.0", contracts: [], authority_state: "active", authority_epoch: 1, transferred_collection_id: null, created_at: new Date().toISOString(), replicas: [] }]
    };
    window.fixture = { mirror, hosted, hostedOnline };
    window.mdbaseConnect = {
      status: async () => ({ readiness: { schema_version: 1, ready: true, binary_version: "test" }, protocol_version: 1, state: "connected", paused: false, registered_collections: 0, direct_access_available: true }),
      updateStatus: async () => ({ phase: "unavailable", current_version: "test", channel: "beta", message: "Development build", can_check: false, can_install: false }),
      listCollections: async () => [], getLaunchAtLogin: async () => ({ enabled: false, available: false }),
      getCloudConfig: async () => ({ configured, serverUrl: configured ? "http://127.0.0.1:42391" : null }),
      accessSnapshot: async () => ({ configured, online: configured, grants: [], pending_authorizations: [], authority_conflicts: [] }),
      listActivity: async () => [],
      hostedSnapshot: async () => window.fixture.hostedOnline ? hosted : { ...hosted, online: false, hosted_collections: [] },
      listMirrors: async () => [mirror],
      onNavigate: () => () => {}, onUpdateStatus: () => () => {}
    };
  }, { configured, hostedOnline });
  await page.goto(origin);
  await page.getByRole("button", { name: /^Collections/ }).click();
  if (configured && hostedOnline) await page.getByRole("heading", { name: "Notes", exact: true }).waitFor();
  return { page, errors, row: page.locator(".hosted-collection") };
}

async function screenshot(page, name) {
  if (process.env.CONNECTOR_UX_SHOTS) await page.screenshot({ path: `${process.env.CONNECTOR_UX_SHOTS}/${name}.png`, fullPage: true });
}

test("sync completion reports outstanding conflicts, not a false success", async () => {
  const { page, row, errors } = await desktop();
  try {
    await page.evaluate(() => {
      window.mdbaseConnect.syncMirror = async () => {
        window.fixture.mirror.state = "attention";
        window.fixture.mirror.conflicts = [{ entity: "record", object_id: "note", decision_id: "decision", path: "note.md", kind: "conflicted", message: "Both copies changed." }];
        return window.fixture.mirror;
      };
    });
    await row.getByRole("button", { name: "Sync", exact: true }).click();
    await row.getByRole("button", { name: "Sync now" }).click();
    await row.locator(".mirror-state-row").getByText("Conflicts need a decision", { exact: true }).waitFor();
    await screenshot(page, "conflict-completion");
    assert.equal(await page.getByText("Notes is synchronized.", { exact: true }).count(), 0);
    assert.match(await page.locator(".notice-message").innerText(), /Conflicts need a decision/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("collapsed hosted rows expose sync conflicts separately from hosted availability", async () => {
  const { page, row, errors } = await desktop();
  try {
    await page.evaluate(() => {
      window.fixture.mirror.state = "attention";
      window.fixture.mirror.conflicts = [{ entity: "record", object_id: "note", decision_id: "decision", path: "note.md", kind: "conflicted", message: "Both copies changed." }];
    });
    await page.clock.runFor(5_000);
    await screenshot(page, "collapsed-conflict");
    assert.equal(await row.locator(".collection-summary").getByText("Available", { exact: true }).isVisible(), true);
    assert.equal(await row.locator(".collection-summary").getByText("Conflicts need a decision", { exact: true }).isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("cold-start offline keeps locally controlled synced folders visible and usable", async () => {
  const { page, errors } = await desktop({ hostedOnline: false });
  try {
    await page.getByRole("status").filter({ hasText: "hosted could not refresh" }).waitFor();
    await screenshot(page, "offline-folders");
    assert.equal(await page.getByRole("heading", { name: "No hosted collections", exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Notes", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: /^Collections/ }).innerText(), "Collections\n1");
    const localRow = page.locator(".standalone-mirror");
    await localRow.getByRole("button", { name: "Sync", exact: true }).click();
    await page.evaluate(() => {
      window.fixture.openedFolders = [];
      window.mdbaseConnect.openMirror = async (id) => { window.fixture.openedFolders.push(id); };
    });
    await localRow.getByRole("button", { name: "Open folder", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.openedFolders), ["notes-mirror"]);
    // Once remote metadata arrives, the same mirror is shown exactly once with
    // its hosted collection rather than remaining in a parallel inventory.
    await page.evaluate(() => { window.fixture.hostedOnline = true; });
    await page.clock.runFor(5_000);
    await page.locator(".hosted-collection").getByRole("heading", { name: "Notes", exact: true }).waitFor();
    assert.equal(await page.locator(".standalone-mirror").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

async function beginPairing(page, { expiresIn = 600, firstError } = {}) {
  await page.evaluate(({ expiresIn, firstError }) => {
    window.fixture.pairingBegins = 0;
    window.fixture.pairingChecks = [];
    window.mdbaseConnect.beginPairing = async () => {
      window.fixture.pairingBegins++;
      return { pairingId: "same-request", verificationUri: "http://127.0.0.1:42391/pair/same-request", expiresIn };
    };
    window.mdbaseConnect.reopenPairing = async () => {};
    window.mdbaseConnect.pairingStatus = async (id) => {
      window.fixture.pairingChecks.push(id);
      if (firstError && window.fixture.pairingChecks.length === 1) throw new Error(firstError);
      return { status: window.fixture.approved ? "paired" : "pending" };
    };
  }, { expiresIn, firstError });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Continue in browser" }).click();
}

test("pending computer approval survives navigation without creating another request", async () => {
  const { page, errors } = await desktop({ configured: false });
  try {
    await beginPairing(page);
    await page.getByText("Waiting for browser approval", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await screenshot(page, "pairing-navigation");
    assert.equal(await page.getByText("Waiting for browser approval", { exact: true }).isVisible(), true);
    await page.getByRole("button", { name: /^Collections/ }).click();
    await page.getByRole("button", { name: "App access", exact: true }).click();
    assert.equal(await page.getByText("Waiting for browser approval", { exact: true }).isVisible(), true);
    await page.evaluate(() => { window.fixture.approved = true; });
    await page.clock.runFor(2_000);
    await page.getByText("Computer approved. Connecting securely…", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.pairingBegins), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("authoritatively expired pairing stops retrying and offers a fresh request", async () => {
  const { page, errors } = await desktop({ configured: false });
  try {
    await beginPairing(page, { firstError: "That pairing request expired. Start again." });
    await page.getByText("Setup request expired", { exact: true }).waitFor();
    await page.clock.runFor(4_000);
    assert.equal(await page.evaluate(() => window.fixture.pairingChecks.length), 1);
    assert.equal(await page.getByRole("button", { name: "Open browser again" }).count(), 0);
    await page.getByRole("button", { name: "Start again" }).click();
    await page.getByRole("button", { name: "Continue in browser" }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("already-approved pairing retries local configuration after the browser request expires", async () => {
  const { page, errors } = await desktop({ configured: false });
  try {
    await beginPairing(page, { expiresIn: 1, firstError: "Connector still starting" });
    await page.getByText("Connection interrupted", { exact: true }).waitFor();
    await page.evaluate(() => { window.fixture.approved = true; });
    await page.clock.runFor(2_000);
    await screenshot(page, "pairing-expiry");
    assert.equal(await page.evaluate(() => window.fixture.pairingChecks.length), 2);
    assert.equal(await page.getByText("Computer approved. Connecting securely…", { exact: true }).isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

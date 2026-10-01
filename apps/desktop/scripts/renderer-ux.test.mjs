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

async function desktop() {
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(() => {
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
    window.fixture = { mirror, hosted };
    window.mdbaseConnect = {
      status: async () => ({ readiness: { schema_version: 1, ready: true, binary_version: "test" }, protocol_version: 1, state: "connected", paused: false, registered_collections: 0, direct_access_available: true }),
      updateStatus: async () => ({ phase: "unavailable", current_version: "test", channel: "beta", message: "Development build", can_check: false, can_install: false }),
      listCollections: async () => [], getLaunchAtLogin: async () => ({ enabled: false, available: false }),
      getCloudConfig: async () => ({ configured: true, serverUrl: "http://127.0.0.1:42391" }),
      accessSnapshot: async () => ({ configured: true, online: true, grants: [], pending_authorizations: [], authority_conflicts: [] }),
      listActivity: async () => [], hostedSnapshot: async () => hosted, listMirrors: async () => [mirror],
      onNavigate: () => () => {}, onUpdateStatus: () => () => {}
    };
  });
  await page.goto(origin);
  await page.getByRole("button", { name: /^Collections/ }).click();
  await page.getByRole("heading", { name: "Notes", exact: true }).waitFor();
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

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
async function desktop({ signedIn = true, collections = [], access = [], devices = [], activity = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1060, height: 720 } });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(({ signedIn, collections, access, devices, activity }) => {
    const calls = [];
    const record = (name) => async (...args) => { calls.push([name, ...args]); return null; };
    const fixture = {
      calls, collections, access, devices, activity, requireApproval: false,
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
      openCollectionFolder: record("openCollectionFolder"),
      setCollectionEnabled: record("setCollectionEnabled"),
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
  }, { signedIn, collections, access, devices, activity });
  await page.goto(origin);
  await page.getByText(signedIn ? "Connected securely" : "Not signed in", { exact: true }).first().waitFor().catch(error => { throw new Error(`${error.message}\nRenderer errors: ${errors.join("; ")}`); });
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

async function collectionAction(page, name, card = page.locator(".collection-card")) {
  await card.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function screenshot(page, name) {
  if (process.env.CONNECTOR_UX_SHOTS) await page.screenshot({ path: `${process.env.CONNECTOR_UX_SHOTS}/${name}.png`, fullPage: true });
}

const collection = (overrides = {}) => ({
  id: "c-notes", name: "Notes", root: "/disposable/a/very/long/path/that/should/never/push/the/layout/wider/than/the/window/Notes",
  mode: "local", origin: "local", log: "none", state: "ready", notices: [], ...overrides
});

for (const theme of ["light", "dark"]) {
  test(`desktop parity: overview links, collection search and overflow in ${theme}`, async () => {
    const { page, errors, calls } = await desktop({ collections: [collection(), collection({ id: "c-work", name: "Work" })] });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const current = nav(page, "Overview");
      for (let attempt = 0; attempt < 40 && !await current.evaluate(element => element === document.activeElement); attempt++) await page.keyboard.press("Tab");
      assert.equal(await current.evaluate(element => element === document.activeElement), true);
      const selection = await current.evaluate(element => {
        const style = getComputedStyle(element);
        return { border: style.borderLeftWidth, shadow: style.boxShadow, before: getComputedStyle(element, "::before").content,
          background: style.backgroundColor, outline: style.outlineStyle };
      });
      assert.equal(selection.border, "0px");
      assert.equal(selection.shadow, "none");
      assert.equal(selection.before, "none");
      assert.notEqual(selection.background, "rgba(0, 0, 0, 0)");
      assert.equal(selection.outline, "solid");
      assert.equal(await page.getByRole("heading", { name: "Overview", exact: true }).count(), 1);
      assert.equal(await page.locator(".overview-row").count(), 3);
      assert.equal(await page.locator(".overview-row button").count(), 0);
      await screenshot(page, `parity-overview-${theme}`);
      await page.getByRole("link", { name: /^Apps / }).click();
      await page.getByRole("heading", { name: "Apps", exact: true }).waitFor();
      for (const name of ["Collections", "Apps", "Activity", "Settings"]) {
        await nav(page, name).click();
        await page.getByRole("heading", { name, exact: true }).waitFor();
      }
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Commands" });
      await palette.getByText("Commands", { exact: true }).last().waitFor();
      assert.ok((await palette.locator(".mdbase-command-results").boundingBox()).height > 152, "palette opens with its results already laid out");
      await palette.getByRole("combobox").fill("Work");
      await palette.getByRole("option", { name: /Work/ }).waitFor();
      await screenshot(page, `parity-palette-${theme}`);
      await page.keyboard.press("Enter");
      assert.deepEqual(await calls("openCollectionFolder"), [["c-work"]]);
      await palette.waitFor({ state: "detached" });
      await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await help.waitFor();
      assert.equal(new Set(await help.locator("dd").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x))).size, 1);
      await screenshot(page, `parity-shortcuts-${theme}`);
      await page.getByRole("tooltip").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("tooltip").waitFor({ state: "detached" });
      assert.equal(await help.isVisible(), true);
      await page.keyboard.press("Escape");
      await help.waitFor({ state: "detached" });
      await nav(page, "Collections").click();
      const card = page.locator(".collection-card").filter({ has: page.getByRole("heading", { name: "Notes", exact: true }) });
      assert.equal(await card.getByRole("button").count(), 1);
      const trigger = card.getByRole("button", { name: "Actions for Notes" });
      await screenshot(page, `parity-collections-${theme}`);
      await trigger.click();
      const menu = page.getByRole("menu", { name: "Notes" });
      await menu.getByRole("menuitem", { name: "Open folder", exact: true }).waitFor();
      await screenshot(page, `parity-menu-${theme}`);
      await page.keyboard.press("Escape");
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      await collectionAction(page, "Pause", card);
      assert.deepEqual(await calls("setCollectionEnabled"), [["c-notes", false]]);
      await collectionAction(page, "Remove", card);
      const confirm = page.getByRole("dialog", { name: /^Remove Notes/ });
      assert.deepEqual(await calls("removeCollection"), []);
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      await collectionAction(page, "Remove", card);
      await confirm.getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByText("Notes was removed. Its files were not touched.", { exact: true }).waitFor();
      assert.deepEqual(await calls("removeCollection"), [["c-notes"]]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("removal waits for the daemon and reports a failure without removing the row", async () => {
  const { page, errors } = await desktop({ collections: [collection()] });
  try {
    await nav(page, "Collections").click();
    await page.evaluate(() => {
      window.mdbaseConnect.removeCollection = () => new Promise((_resolve, reject) => {
        window.fixture.rejectRemoval = () => reject(new Error("The collection could not be removed."));
      });
    });
    await collectionAction(page, "Remove");
    const dialog = page.getByRole("dialog", { name: /^Remove Notes/ });
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await dialog.getByRole("button", { name: "Removing…", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Cancel" }).isDisabled(), true);
    assert.equal(await page.locator(".collection-card").count(), 1);
    await page.evaluate(() => window.fixture.rejectRemoval());
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("alert").filter({ hasText: "The collection could not be removed." }).waitFor();
    assert.equal(await page.locator(".collection-card").count(), 1);
    assert.equal(await page.getByText("Notes was removed. Its files were not touched.", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("ready synced collections do not offer the unavailable turn-off action", async () => {
  const { page, errors } = await desktop({ signedIn: true, collections: [collection({ mode: "synced", log: "hosted", sync: { pending: 0, holds: 0, unresolved: 0, connection: "online" } })] });
  try {
    await nav(page, "Collections").click();
    await page.locator(".collection-card").waitFor();
    await page.getByRole("button", { name: "Actions for Notes" }).click();
    assert.equal(await page.getByRole("menuitem", { name: "Turn off sync" }).count(), 0);
    assert.equal(await page.getByRole("menuitem", { name: "Turn on sync" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

const entry = (overrides = {}) => ({
  grant: "g1", collection: "c-notes", app_id: "reader", app_name: "Reader", client_pk: "pk", capabilities: ["read", "write"],
  state: "active", first_seen_ms: Date.now(), acknowledged: true, ...overrides
});

for (const theme of ["light", "dark"]) {
  test(`W25 two-line collection slots and shared disclosures in ${theme}`, async () => {
    const { page, errors } = await desktop({
      collections: [collection(), collection({ id: "c-team", name: "Team library", mode: "synced", sync: { pending: 0, holds: 0, unresolved: 0, connection: "online" } })],
      access: [entry()]
    });
    try {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const width of [1440, 820]) {
        await page.setViewportSize({ width, height: width === 820 ? 580 : 900 });
        await nav(page, "Collections").click();
        const geometry = await page.locator(".collection-card").evaluateAll(rows => rows.map(row => {
          const name = row.querySelector("h3").getBoundingClientRect();
          const path = row.querySelector(".collection-card-main code").getBoundingClientRect();
          const status = row.querySelector(".collection-card-status").getBoundingClientRect();
          const menu = row.querySelector(".collection-menu-trigger").getBoundingClientRect();
          return { height: row.getBoundingClientRect().height, nameY: name.y - row.getBoundingClientRect().y, pathX: path.x, pathY: path.y - row.getBoundingClientRect().y, nameX: name.x, statusX: status.x, menuX: menu.x };
        }));
        assert.equal(geometry[0].statusX, geometry[1].statusX);
        assert.equal(geometry[0].menuX, geometry[1].menuX);
        assert.equal(geometry[0].nameX, geometry[0].pathX);
        assert.ok(geometry[0].pathY > geometry[0].nameY);
        assert.ok(geometry.every(row => row.height < 80));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await screenshot(page, `w25-collections-${width}-${theme}`);
      }
      await nav(page, "Apps").click();
      const summary = page.locator(".application-grant-group > summary");
      assert.equal(await summary.locator("b:not(.new-access)").count(), 0);
      assert.equal(await summary.evaluate(element => getComputedStyle(element, "::after").rotate), "-45deg");
      await summary.click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".application-grant-group > summary"), "::after").rotate === "45deg");
      await screenshot(page, `w25-apps-${theme}`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("W25 growing lists filter, return focus to their results and advertise only available filters", async () => {
  const { page, errors, calls } = await desktop({
    collections: Array.from({ length: 12 }, (_, index) => collection({ id: `c-${index}`, name: `Collection ${index}` })),
    access: [...Array.from({ length: 12 }, (_, index) => entry({ grant: `g-${index}`, app_id: `app-${index}`, app_name: `App ${index}` })), entry({ grant: "pending", app_name: "Reader", state: "pending_approval" })],
    devices: [{ collection: "c-0", device: "d-laptop", name: "Laptop", kind: "desktop", sas: "012345" }],
    activity: Array.from({ length: 12 }, (_, index) => ({ at_ms: Date.now() - index * 1000, kind: "collection_added", collection_name: `Collection ${index}` }))
  });
  try {
    for (const [route, label, rows, query] of [
      ["Collections", "Filter collections", ".collection-card", "Collection 11"],
      ["Apps", "Filter apps", ".application-grant-group", "App 11"],
      ["Activity", "Filter activity", ".activity-list > li", "Collection 11"]
    ]) {
      await nav(page, route).click();
      await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await help.getByText("Filter the current list", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await help.waitFor({ state: "hidden" });
      await page.keyboard.press("/");
      const filter = page.getByRole("searchbox", { name: label });
      assert.equal(await filter.getAttribute("class"), "mdbase-field");
      assert.equal(await filter.evaluate(element => element === document.activeElement), true);
      for (const key of ["ArrowDown", "Enter"]) {
        await filter.fill(query);
        assert.equal(await page.locator(rows).count(), 1);
        await page.keyboard.press(key);
        assert.equal(await page.locator(rows).first().evaluate(element => element.contains(document.activeElement)), true);
        await page.keyboard.press("/");
      }
      await filter.fill("no matching result");
      assert.equal(await page.locator(rows).count(), 0);
      await page.keyboard.press("Escape");
      assert.equal(await filter.inputValue(), "");
      assert.equal(await filter.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(rows).first().evaluate(element => element.contains(document.activeElement)), true);
      await page.keyboard.press("j");
      assert.equal(await filter.inputValue(), "");
      await screenshot(page, `w25-filter-${route}`);
    }
    assert.deepEqual(await calls("approveAccess"), []);
    assert.deepEqual(await calls("approveDevice"), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("shared keyboard shortcuts navigate, filter and move list focus without approving", async () => {
  const { page, errors, calls } = await desktop({ collections: Array.from({ length: 14 }, (_, index) => collection({ id: `c-${index}`, name: `Notes ${String(index).padStart(2, "0")}` })) });
  try {
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.getByRole("heading", { name: "Collections", exact: true }).waitFor();
    await page.keyboard.press("j");
    assert.equal(await page.locator(".collection-card").nth(0).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("j");
    assert.equal(await page.locator(".collection-card").nth(1).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("k");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Commands", exact: true });
    await palette.waitFor();
    assert.equal(await palette.locator(".mdbase-command-group").first().innerText(), "Notes 00");
    assert.match(await palette.getByRole("option").first().innerText(), /Notes 00/);
    await page.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".collection-card").nth(0).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.getByRole("menu", { name: "Notes 00" }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "Open folder", exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.keyboard.press("/");
    const filter = page.getByRole("searchbox", { name: "Filter collections" });
    assert.equal(await filter.evaluate(element => element === document.activeElement), true);
    await filter.fill("Notes 13");
    assert.equal(await page.locator(".collection-card").count(), 1);
    await page.keyboard.type("ga?/");
    assert.equal(await page.getByRole("heading", { name: "Collections", exact: true }).count(), 1);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await filter.inputValue(), "");
    assert.equal(await filter.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".collection-card").first().evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("j");
    assert.equal(await page.locator(".collection-card").nth(1).evaluate(element => element === document.activeElement), true);
    assert.equal(await filter.inputValue(), "");
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    await page.getByRole("heading", { name: "Apps", exact: true }).waitFor();
    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    await page.getByRole("heading", { name: "Activity", exact: true }).waitFor();
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await help.waitFor();
    assert.match(await help.innerText(), /G C/);
    assert.match(await help.innerText(), /G A/);
    assert.match(await help.innerText(), /G S/);
    assert.match(await help.innerText(), /G L/);
    assert.equal(await help.getByText("Filter the current list", { exact: true }).count(), 0);
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    assert.equal(await page.getByRole("heading", { name: "Activity", exact: true }).count(), 1);
    await page.keyboard.press("Escape");
    await help.waitFor({ state: "hidden" });
    await page.keyboard.press("Control+/");
    await help.waitFor();
    assert.deepEqual(await calls("approveAccess"), []);
    assert.deepEqual(await calls("approveDevice"), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const theme of ["light", "dark"]) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`round 9 focused collection leads and opens from its palette group ${viewport.width} ${theme}`, async () => {
      const { page, errors, calls } = await desktop({ collections: [collection({ id: "first", name: "First notes" }), collection({ id: "second", name: "Second notes" })] });
      try {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
        await page.keyboard.press("g"); await page.keyboard.press("c");
        await page.getByRole("heading", { name: "Collections", exact: true }).waitFor();
        await page.keyboard.press("j"); await page.keyboard.press("j");
        await page.keyboard.press("Control+k");
        const palette = page.getByRole("dialog", { name: "Commands", exact: true });
        await palette.waitFor();
        assert.equal(await palette.locator(".mdbase-command-group").first().innerText(), "Second notes");
        assert.match(await palette.getByRole("option").first().innerText(), /Second notes/);
        await page.keyboard.press("Enter");
        await palette.waitFor({ state: "hidden" });
        assert.deepEqual(await calls("openCollectionFolder"), [["second"]]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
    test(`W19 palette reviews pending approvals at ${viewport.width} in ${theme}`, async () => {
      const { page, errors, calls } = await desktop({
        collections: [collection()],
        access: [entry({ state: "pending_approval", fingerprint: "abcd1234" })],
        devices: [{ collection: "c-notes", device: "d-laptop", name: "Laptop", kind: "desktop", sas: "012345" }]
      });
      try {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
        assert.equal(await page.locator(".mdbase-motion-keys-first").count(), 0);
        assert.equal(await page.locator(".product-brand-mark").first().evaluate(element => getComputedStyle(element.querySelector("rect")).opacity), "1");
        for (const [name, route, command] of [["Reader", "Apps", "approval:g1"], ["Laptop", "Collections", "device:c-notes/d-laptop"]]) {
          await page.keyboard.press("Control+k");
          const palette = page.getByRole("dialog", { name: "Commands" });
          await palette.getByRole("option", { name: new RegExp(`Review ${name}`) }).waitFor();
          assert.match(await palette.getByRole("option").first().innerText(), /Review Reader/);
          await palette.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
          assert.equal(await palette.getByRole("option").first().evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
          }), true);
          await screenshot(page, `w25-palette-first-${viewport.width}-${theme}`);
          await palette.getByRole("combobox").fill(name);
          await palette.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
          await screenshot(page, `w19-palette-${name}-${viewport.width}-${theme}`);
          await page.keyboard.press("Enter");
          await palette.waitFor({ state: "hidden" });
          await page.getByRole("heading", { name: route, exact: true }).waitFor();
          await page.waitForFunction(command => document.activeElement?.getAttribute("data-command") === command, command);
          const prompt = page.locator(".approval-prompt").filter({ hasText: name });
          await prompt.getByRole("button", { name: name === "Reader" ? "Approve…" : "Allow", exact: true }).waitFor();
          await screenshot(page, `w19-review-${name}-${viewport.width}-${theme}`);
          assert.deepEqual(await calls("approveAccess"), []);
          assert.deepEqual(await calls("approveDevice"), []);
          assert.deepEqual(await calls("denyAccess"), []);
          assert.deepEqual(await calls("rejectDevice"), []);
        }
        await page.keyboard.press("Control+k");
        await page.keyboard.press("Control+k");
        await page.getByRole("dialog", { name: "Commands" }).waitFor({ state: "hidden" });
        assert.equal(await page.locator(".approval-prompt").evaluate(element => element === document.activeElement), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

test("the mark builds only during sign-in and reduced motion stays static", async () => {
  const { page, errors } = await desktop({ signedIn: false });
  try {
    assert.equal(await page.locator(".mdbase-motion-keys-first").count(), 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".mdbase-motion-keys-first rect").evaluateAll(elements => elements.every(element => getComputedStyle(element).animationName === "none")), true);
    await page.evaluate(() => { window.fixture.account.configured = true; });
    await page.clock.runFor(5_000);
    assert.equal(await page.locator(".mdbase-motion-keys-first").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const theme of ["light", "dark"]) {
  for (const viewport of [{ width: 1060, height: 720 }, { width: 820, height: 580 }]) {
    test(`desktop finish: surfaces, locations and approvals at ${viewport.width} in ${theme}`, async () => {
      const { page, errors, calls } = await desktop({
        collections: [collection()],
        access: [entry({ state: "pending_approval", fingerprint: "abcd1234" })],
        devices: [{ collection: "c-notes", device: "d-laptop", name: "Laptop", kind: "desktop", sas: "012345" }]
      });
      try {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.evaluate(() => { window.fixture.account.computerName = "Studio workstation"; });
        await page.clock.runFor(5_000);
        const surfaces = await page.evaluate(() => ({
          sidebar: getComputedStyle(document.querySelector(".product-sidebar")).backgroundColor,
          canvas: getComputedStyle(document.querySelector("main")).backgroundColor,
          border: getComputedStyle(document.querySelector(".product-sidebar")).borderRightWidth
        }));
        assert.notEqual(surfaces.sidebar, surfaces.canvas);
        assert.equal(surfaces.border, "1px");
        for (const [label, heading] of [[/^Collections 1 collection/, "Collections"], [/^Apps 1 item needs you/, "Apps"]]) {
          const link = page.getByRole("link", { name: label });
          await link.focus();
          await page.keyboard.press("Enter");
          await page.getByRole("heading", { name: heading, exact: true }).waitFor();
          await nav(page, "Overview").click();
        }
        await screenshot(page, `finish-overview-${viewport.width}-${theme}`);
        for (const route of ["Collections", "Apps"]) {
          await nav(page, route).click();
          const prompt = page.locator(".approval-prompt");
          await prompt.waitFor();
          const layout = await prompt.evaluate(element => {
            const identity = element.querySelector(".grant-identity").getBoundingClientRect();
            const actions = element.querySelector(".decision-actions").getBoundingClientRect();
            const buttons = [...element.querySelectorAll("button")].map(button => button.getBoundingClientRect().toJSON());
            return { identity: identity.toJSON(), actions: actions.toJSON(), buttons };
          });
          assert.ok(Math.abs(layout.identity.width - layout.actions.width) < 1);
          assert.ok(layout.actions.top >= layout.identity.bottom);
          assert.equal(layout.buttons.length, 2);
          assert.ok(Math.abs(layout.buttons[0].top - layout.buttons[1].top) < 1);
          assert.ok(layout.buttons.every(button => button.width < 160));
          assert.ok(Math.abs(layout.buttons[1].right - layout.actions.right) < 1);
          assert.equal(await page.evaluate(() => document.querySelector("main").scrollWidth > document.querySelector("main").clientWidth), false);
          if (route === "Collections") {
            const card = page.locator(".collection-card");
            await card.getByRole("img", { name: "Studio workstation", exact: true }).waitFor();
            assert.equal(await card.locator(".collection-card-main > svg").count(), 1);
            assert.equal(await card.locator(".collection-card-main > .status-glyph").count(), 0);
            assert.equal(await card.locator(".collection-card-main code").first().innerText(), collection().root);
          }
          await screenshot(page, `finish-${route.toLowerCase()}-${viewport.width}-${theme}`);
        }
        assert.deepEqual(await calls("approveAccess"), []);
        assert.deepEqual(await calls("approveDevice"), []);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

test("app approval remains pending until acknowledged and a failure never claims access", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection()], access: [entry({ state: "pending_approval" })] });
  try {
    await nav(page, "Apps").click();
    const prompt = page.locator(".approval-prompt");
    await page.evaluate(() => {
      window.mdbaseConnect.approveAccess = grant => new Promise((resolve, reject) => {
        window.fixture.calls.push(["approveAccess", grant]);
        window.fixture.finishApproval = () => { window.fixture.access = [{ ...window.fixture.access[0], state: "active" }]; resolve(null); };
        window.fixture.failApproval = () => reject(new Error("Approval could not be recorded."));
      });
    });
    assert.deepEqual(await calls("approveAccess"), []);
    await prompt.getByRole("button", { name: "Approve…" }).click();
    await page.waitForFunction(() => typeof window.fixture.failApproval === "function");
    assert.equal(await prompt.getByRole("button", { name: "Approve…" }).isDisabled(), true);
    assert.equal(await prompt.getByRole("button", { name: "Decline" }).isDisabled(), true);
    assert.equal(await page.getByText("Reader can now use Notes.", { exact: true }).count(), 0);
    assert.equal(await page.locator(".application-grant-group").count(), 0);
    await page.evaluate(() => window.fixture.failApproval());
    await page.getByRole("alert").filter({ hasText: "Approval could not be recorded." }).waitFor();
    assert.equal(await prompt.isVisible(), true);
    assert.equal(await page.getByText("Reader can now use Notes.", { exact: true }).count(), 0);
    await prompt.getByRole("button", { name: "Approve…" }).click();
    await page.waitForFunction(() => window.fixture.calls.filter(call => call[0] === "approveAccess").length === 2);
    await page.evaluate(() => window.fixture.finishApproval());
    await page.getByText("Reader can now use Notes.", { exact: true }).waitFor();
    await prompt.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
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
    await card.locator(".collection-card-status").getByText("Ready", { exact: true }).waitFor();
    assert.equal(await card.locator(".collection-card-status small").innerText(), "On this computer only");
    await screenshot(page, "collections-minimum");
    assert.equal(await page.locator(".content").evaluate((element) => element.scrollWidth > element.clientWidth), false);
    await collectionAction(page, "Turn on sync", card);
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByRole("radio", { name: /Private/ }).isChecked(), true);
    await dialog.getByRole("button", { name: "Turn on sync" }).click();
    await page.getByText("Notes now syncs privately.", { exact: true }).waitFor();
    assert.deepEqual(await calls("enableSync"), [["c-notes", "private", false]]);
    await collectionAction(page, "Remove", card);
    const confirmation = page.getByRole("dialog", { name: /^Remove / });
    await confirmation.getByText(/^Remove Notes from mdbase/).waitFor();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    assert.deepEqual(await calls("removeCollection"), [], "cancelling the confirmation keeps the collection");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a failed turn-on of sync is explained inside the dialog, which stays open for a retry", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection()] });
  try {
    await nav(page, "Collections").click();
    const card = page.locator(".collection-card").filter({ hasText: "Notes" });
    await collectionAction(page, "Turn on sync", card);
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
    await dialog.waitFor({ state: "detached" });
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
    await collectionAction(page, "Turn on sync");
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
    await collectionAction(page, "Turn on sync");
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
    assert.equal(await nav(page, "Apps").innerText(), "Apps\n3");
    await nav(page, "Apps").click();
    const journal = page.locator(".approval-prompt").filter({ hasText: "Journal wants to use Diary" });
    await journal.getByText("mdbase could not fetch what this app is asking for", { exact: false }).waitFor();
    assert.equal(await journal.getByRole("button", { name: "Approve…" }).isDisabled(), true);
    const planner = page.locator(".approval-prompt").filter({ hasText: "Planner wants to use Notes" });
    await planner.getByText("If you approve, Planner will be able to read records and create and edit records in Notes", { exact: false }).waitFor();
    await planner.getByRole("button", { name: "Approve…" }).click();
    assert.deepEqual(await calls("approveAccess"), [["pending"]]);
    const reader = page.locator(".application-grant-group").filter({ hasText: "Reader" });
    await reader.getByText("Can read records and create and edit records", { exact: true }).waitFor();
    await reader.getByText("Notes", { exact: true }).waitFor();
    await reader.getByRole("button", { name: "Mark as seen" }).click();
    assert.deepEqual(await calls("acknowledgeAccess"), [["new"]]);
    await reader.getByRole("button", { name: "Revoke" }).click();
    assert.match(await page.getByRole("dialog").getAttribute("class"), /mdbase-confirm-dialog/, "revoke uses the shared confirmation surface");
    await page.getByRole("dialog").getByRole("button", { name: "Revoke access" }).click();
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
    await nav(page, "Apps").click();
    await page.getByText(`Check that ${name} shows the same key.`, { exact: true }).waitFor();
    await page.getByText(`mdbase shows the app's key when you approve. Check that ${name} shows the same key.`, { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("another computer shows its comparison code and is allowed with one click, without typing", async () => {
  const { page, errors, calls } = await desktop({
    collections: [collection({ id: "c-private", name: "Diary", mode: "synced_e2e" })],
    devices: [{ collection: "c-private", collection_name: "Diary", device: "d-laptop", name: "Laptop", kind: "desktop", sas: "012345" }]
  });
  try {
    await nav(page, "Collections").click();
    const prompt = page.locator(".approval-prompt").filter({ hasText: "Laptop wants to open Diary" });
    await prompt.waitFor();
    assert.equal(await nav(page, "Collections").innerText(), "Collections\n1");
    assert.equal(await prompt.locator("input").count(), 0);
    await prompt.getByText("Only allow if this matches the code on Laptop", { exact: true }).waitFor();
    await prompt.getByText("012 345", { exact: true }).waitFor();
    assert.equal(await prompt.getByRole("button", { name: "Deny" }).count(), 1);
    const spacing = await page.locator(".device-requests").evaluate(element => ({
      gap: element.getBoundingClientRect().top - document.querySelector(".topbar").getBoundingClientRect().bottom,
      counts: element.querySelectorAll(".section-heading .count").length
    }));
    assert.equal(spacing.gap, 32);
    assert.equal(spacing.counts, 0);
    await screenshot(page, "device-approval");
    await prompt.getByRole("button", { name: "Allow" }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Laptop can now open Diary.", { exact: true }).waitFor();
    assert.deepEqual(await calls("approveDevice"), [["c-private", "d-laptop", "012345"]]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Allow waits for a revealed code while Deny remains available", async () => {
  const { page, errors, calls } = await desktop({
    devices: [{ collection: "c-private", collection_name: "Diary", device: "d-laptop", name: "Laptop", kind: "desktop", sas: null }]
  });
  try {
    await nav(page, "Collections").click();
    const prompt = page.locator(".approval-prompt");
    await prompt.getByText("Preparing comparison code…", { exact: true }).waitFor();
    assert.equal(await prompt.getByRole("button", { name: "Allow", exact: true }).isDisabled(), true);
    assert.equal(await prompt.getByRole("button", { name: "Deny", exact: true }).isDisabled(), false);
    assert.deepEqual(await calls("approveDevice"), []);
    await prompt.getByRole("button", { name: "Deny", exact: true }).click();
    assert.deepEqual(await calls("rejectDevice"), [["c-private", "d-laptop"]]);
    await page.evaluate(() => { window.fixture.devices[0].sas = "123456"; });
    await page.clock.runFor(5_000);
    await prompt.getByText("123 456", { exact: true }).waitFor();
    assert.equal(await prompt.getByRole("button", { name: "Allow", exact: true }).isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a waiting computer shows its comparison code and clears it after approval", async () => {
  const { page, errors } = await desktop({
    collections: [collection({ mode: "synced_e2e", state: "opening", reason: "waiting_for_approval", approval_code: null })]
  });
  try {
    await nav(page, "Collections").click();
    const card = page.locator(".collection-card");
    assert.equal(await card.locator(".approval-code").count(), 0);
    await page.evaluate(() => { window.fixture.collections[0].approval_code = "012345"; });
    await page.clock.runFor(5_000);
    await card.getByText("Check this code matches on your other computer:", { exact: true }).waitFor();
    await card.getByText("012 345", { exact: true }).waitFor();
    await screenshot(page, "waiting-device-approval");
    await page.evaluate(() => { Object.assign(window.fixture.collections[0], { state: "ready", reason: null, approval_code: null }); });
    await page.clock.runFor(5_000);
    assert.equal(await card.locator(".approval-code").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a computer of another account is named generically", async () => {
  const { page, errors } = await desktop({
    collections: [collection({ id: "c-private", name: "Diary", mode: "synced_e2e" })],
    devices: [{ collection: "c-private", collection_name: "Diary", device: "d-other", kind: "desktop" }]
  });
  try {
    await nav(page, "Collections").click();
    await page.locator(".approval-prompt").filter({ hasText: "Another computer wants to open Diary" }).waitFor();
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
    assert.equal(await page.locator(".product-sidebar-status .status-glyph").getAttribute("data-state"), "attention");
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
    await collectionAction(page, "Details", card);
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

test("deleted collection keeps skipped-file details without repeating the deletion notice", async () => {
  const { page, errors } = await desktop({ collections: [collection({
    mode: "synced", log: "hosted", state: "failed", reason: "collection_deleted",
    notices: [
      { code: "collection_deleted", message: "This collection was deleted by its owner. Your local files are untouched." },
      { code: "unsupported_entry", path: "notes/latin.md", message: "Not valid UTF-8; note is not synced." }
    ]
  })] });
  try {
    await nav(page, "Collections").click();
    const card = page.locator(".collection-card");
    await card.getByText("Collection deleted", { exact: false }).waitFor();
    assert.equal((await card.innerText()).match(/deleted by its owner/g)?.length, 1);
    const notice = card.locator(".collection-notice");
    assert.equal(await notice.locator("code").innerText(), "notes/latin.md");
    assert.ok((await notice.innerText()).includes("Not valid UTF-8"));
    await card.getByRole("button", { name: "Actions for Notes" }).click();
    assert.equal(await page.getByRole("menuitem", { name: "Remove", exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("a view-only new file can be discarded without a synced version", async () => {
  const { page, errors, calls } = await desktop({ collections: [collection({ sync: { holds: 1 } })] });
  try {
    await page.evaluate(() => {
      window.fixture.holds = [{ id: "viewer:1", path: "new.md", reason: "read_only", since: Date.now(), saves: 1, has_theirs: false, binary: false }];
    });
    await nav(page, "Collections").click();
    await collectionAction(page, "Review 1 file");
    await page.getByText("new.md", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Keep both", exact: true }).count(), 1);
    const discard = page.getByRole("button", { name: "Discard local changes", exact: true });
    await discard.click();
    const confirmation = page.getByRole("dialog", { name: /^Discard / });
    await confirmation.getByText(/new\.md.*haven't been synced/).waitFor();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await confirmation.waitFor({ state: "detached" });
    assert.deepEqual(await calls("resolveHold"), []);
    await discard.click();
    await confirmation.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByText("Nothing is waiting.", { exact: true }).waitFor();
    assert.deepEqual(await calls("resolveHold"), [["c-notes", "viewer:1", "take_theirs"]]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

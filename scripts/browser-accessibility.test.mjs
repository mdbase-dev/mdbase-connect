import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";

const roots = {
  portal: resolve("apps/portal/dist"),
  desktop: resolve("apps/desktop/dist/renderer"),
  editor: resolve("apps/editor/dist")
};
const servers = await Promise.all(
  Object.values(roots).map((root) => serveStaticApplication(root))
);
const browser = await chromium.launch({ headless: true });

try {
  await auditPortalLogin();
  await auditEditorConnect();
  await auditPortalColdStartAuthorization();
  await auditPortalDeviceAuthorization();
  await auditDesktopResumedAuthorization();
  await auditDesktopRoutes();
  console.log(
    "Browser accessibility passed: landmarks, names, headings, keyboard reachability, and reduced motion."
  );
} finally {
  await browser.close();
  await Promise.all(
    servers.map(
      ({ server }) =>
        new Promise((resolveClose) => server.close(resolveClose))
    )
  );
}

async function auditPortalLogin() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") {
      await route.fulfill({ status: 401, json: { error: "not_authenticated" } });
      return;
    }
    if (pathname === "/v1/auth/config") {
      await route.fulfill({
        json: {
          provider: "github",
          providers: [],
          password_login: true,
          password_recovery: true,
          password_registration: false,
          registration: "open"
        }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto(`${servers[0].origin}/login`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await auditPage(page, "portal login", { keyboard: true });
  assert.deepEqual(
    errors.filter((error) => !error.includes("status of 401")),
    []
  );
  await page.close();
}

async function auditEditorConnect() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  const now = new Date().toISOString();
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") {
      await route.fulfill({
        json: {
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Example User",
            email: "user@example.com",
            login: "example"
          },
          subscription: {
            kind: "beta",
            profiles: ["beta_v1"],
            permanent: true,
            limits: {
              hosted_storage_bytes: 1_073_741_824,
              retained_file_bytes: 2_147_483_648,
              max_document_bytes: 2_097_152,
              max_single_file_bytes: 262_144_000,
              max_replicas_per_collection: 10,
              max_hosted_collections: 250,
              max_files_per_collection: 10_000
            },
            usage: {
              hosted_collections: 1,
              live_content_bytes: 4_096,
              live_file_bytes: 10_485_760,
              live_storage_bytes: 10_489_856,
              retained_file_bytes: 2_097_152
            },
            reconciliation: { entitlement_revision: 1, provider_revision: 1 }
          },
          hosted_collections_available: true,
          authentication: { provider: "github", registration: "open" },
          connectors: [],
          collections: [{
            id: "22222222-2222-4222-8222-222222222222",
            connector_id: "33333333-3333-4333-8333-333333333333",
            local_id: "local-collection",
            connector_name: "Example computer",
            display_name: "Accessibility collection",
            spec_version: "1",
            enabled: true,
            contracts: [],
            last_seen_at: new Date().toISOString()
          }],
          hosted_collections: [],
          grants: [{
            id: "grant-active",
            operations: ["read", "query", "update"],
            scope: { contracts: [], access: "full_collection" },
            created_at: now,
            revoked_at: null,
            revocation_status: "active",
            collection_id: "22222222-2222-4222-8222-222222222222",
            collection_name: "Accessibility collection",
            collection_kind: "local",
            application_id: "photo-catalog",
            application_name: "Photo catalog",
            distribution: "web",
            homepage: "https://photos.example",
            project_url: null,
            application_origin: "https://photos.example",
            icon: null
          }, {
            id: "grant-revoking",
            operations: ["read"],
            scope: { contracts: [], access: "full_collection" },
            created_at: now,
            revoked_at: now,
            revocation_status: "revoking",
            collection_id: "22222222-2222-4222-8222-222222222222",
            collection_name: "Accessibility collection",
            collection_kind: "local",
            application_id: "archive-tool",
            application_name: "Archive tool",
            distribution: "web",
            homepage: "https://archive.example",
            project_url: null,
            application_origin: "https://archive.example",
            icon: null
          }],
          pending_authorizations: [{
            id: "pending-request",
            flow: "authorization_code",
            requested_operations: ["read"],
            collection_id: "22222222-2222-4222-8222-222222222222",
            expires_at: "2099-08-01T00:00:00.000Z",
            application_id: "reading-list",
            application_name: "Reading list",
            distribution: "web",
            homepage: "https://reading.example",
            project_url: null,
            icon: null
          }]
        }
      });
      return;
    }
    if (pathname === "/v1/account/sessions") {
      await route.fulfill({ json: { sessions: [{
        id: "current-session",
        provider: "password",
        client_name: "Accessibility browser",
        created_at: now,
        last_seen_at: now,
        expires_at: "2099-08-01T00:00:00.000Z",
        current: true
      }] } });
      return;
    }
    if (pathname === "/v1/account") {
      await route.fulfill({ json: {
        user: { id: "user", name: "Example User", email: "user@example.com", login: "example" },
        authentication: {
          managed: true,
          current_provider: "password",
          available_providers: { github: false, google: false, password: true },
          identities: [],
          password: { configured: true, email: "user@example.com", current: true, change_available: true }
        },
        storage: {
          status: "available",
          total_content_bytes: 4_096,
          total_file_bytes: 10_485_760,
          total_storage_bytes: 10_489_856,
          total_stored_file_bytes: 12_582_912,
          total_records: 2,
          collections: [{
            id: "hosted",
            display_name: "Hosted research",
            usage: {
              collection_id: "hosted",
              record_count: 2,
              content_bytes: 4_096,
              max_records: 100_000,
              max_content_bytes: 1_073_741_824,
              max_document_bytes: 2_097_152,
              file_count: 2,
              file_bytes: 10_485_760,
              stored_file_bytes: 12_582_912,
              max_files: 10_000,
              max_file_bytes: 1_073_741_824,
              max_stored_file_bytes: 2_147_483_648,
              max_single_file_bytes: 262_144_000
            }
          }]
        },
        deletion: { available: true, hosted_collections: 1, local_collections: 1, computers: 1, development_confirmation: true }
      } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto(`${servers[2].origin}/connect`);
  await page.getByRole("heading", { name: "Accessibility collection" }).waitFor();
  await auditPage(page, "editor Connect workspace", { keyboard: true });

  await page.getByRole("link", { name: "App access" }).click();
  await page.getByRole("heading", { name: "Application access" }).waitFor();
  await page.getByText("Photo catalog", { exact: true }).click();
  await page.getByText("Permissions", { exact: true }).click();
  await auditPage(page, "editor Connect expanded permissions", { keyboard: true });

  await page.getByRole("link", { name: "Account & sessions" }).click();
  await page.getByRole("heading", { name: "Hosted storage" }).waitFor();
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByRole("button", { name: "Delete account…" }).click();
  await auditPage(page, "editor Connect account forms", { keyboard: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Account & sessions.*Open menu/ }).click();
  await page.getByRole("link", { name: "Back to editor" }).waitFor();
  await auditPage(page, "editor Connect mobile navigation", { keyboard: true });
  assert.deepEqual(errors, []);
  await page.close();
}

async function auditPortalDeviceAuthorization() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  await page.goto(`${servers[0].origin}/device`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await auditPage(page, "portal device authorization", { keyboard: true });
  assert.deepEqual(errors, []);
  await page.close();
}

async function auditPortalColdStartAuthorization() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  const requestId = "22222222-2222-4222-8222-222222222222";
  const authorization = portalAuthorizationFixture(requestId);
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `/v1/authorization-requests/${requestId}`) {
      await route.fulfill({
        json: {
          authorization,
          collections: [{
            id: "44444444-4444-4444-8444-444444444444",
            kind: "local",
            connector_name: "Home computer",
            display_name: "Personal notes",
            spec_version: "0.3.0",
            contracts: [],
            types: []
          }, {
            id: "55555555-5555-4555-8555-555555555555",
            kind: "hosted",
            connector_name: "Hosted by mdbase",
            display_name: "Shared notes",
            spec_version: "0.3.0",
            contracts: [],
            types: []
          }],
          hosted_collections_available: true,
          unavailable_connectors: []
        }
      });
      return;
    }
    if (pathname === `/v1/authorization-requests/${requestId}/status`) {
      await route.fulfill({ json: { status: "pending" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto(`${servers[0].origin}/authorize/${requestId}`);
  await page.getByRole("heading", { name: "Workout journal" }).waitFor();
  const reviewAccess = page.getByRole("button", { name: "Review access" });
  assert.equal(await reviewAccess.isDisabled(), true, "portal authorization: multiple collections require a deliberate choice");
  assert.equal(await page.getByRole("radio").count(), 2, "portal authorization: compatible collections are visible");
  assert.equal(await page.getByRole("radio", { checked: true }).count(), 0, "portal authorization: no ambiguous collection is preselected");
  assert.equal(await page.getByText("Delete records", { exact: true }).count(), 0, "portal authorization: permissions wait until collection choice");
  await page.getByText("Need a different collection?", { exact: true }).click();
  const localFolder = page.getByRole("link", { name: "Use a local folder" });
  assert.equal(
    await localFolder.getAttribute("href"),
    `mdbase-connect://authorize?request_id=${requestId}`,
    "portal authorization: desktop link preserves request ID"
  );
  await localFolder.evaluate((element) => {
    element.addEventListener("click", (event) => event.preventDefault(), { once: true });
  });
  await localFolder.click();
  await page.getByRole("heading", { name: "Choose the folder in mdbase connect." }).waitFor();
  assert.equal(
    new URL(page.url()).searchParams.get("continue_in_desktop"),
    "1",
    "portal authorization: browser records desktop continuation"
  );
  await auditPage(page, "portal desktop continuation", { keyboard: true });
  await page.getByRole("button", { name: "Review in this browser" }).click();
  await page.getByText("Need a different collection?", { exact: true }).click();
  await localFolder.waitFor();
  assert.equal(
    new URL(page.url()).searchParams.has("continue_in_desktop"),
    false,
    "portal authorization: browser review remains available"
  );
  await page.getByRole("radio", { name: /Personal notes.*Home computer/ }).check();
  await reviewAccess.click();
  await page.getByText("View and find records", { exact: true }).first().waitFor();
  await page.getByText("Create and edit records", { exact: true }).first().waitFor();
  await page.getByText("Delete records", { exact: true }).first().waitFor();
  await page.getByText("Higher impact", { exact: true }).first().waitFor();
  await page.reload();
  await page.getByText("Personal notes", { exact: true }).first().waitFor();
  await page.getByText("Delete records", { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Allow Workout journal" }).count(), 1, "portal authorization: review state survives refresh");
  await auditPage(page, "portal application access review", { keyboard: true });
  assert.deepEqual(errors, []);
  await page.close();
}

async function auditDesktopResumedAuthorization() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  const requestId = "33333333-3333-4333-8333-333333333333";
  await page.addInitScript((authorizationId) => {
    localStorage.setItem("mdbase:resume-authorization", authorizationId);
    const status = {
      protocol_version: 1,
      state: "connected",
      registered_collections: 0,
      paused: false,
      direct_access_available: true
    };
    const updateStatus = {
      phase: "idle",
      current_version: "0.1.0",
      channel: "beta",
      message: "Up to date",
      can_check: true,
      can_install: false
    };
    window.mdbaseConnect = {
      status: async () => status,
      updateStatus: async () => updateStatus,
      listCollections: async () => [],
      getLaunchAtLogin: async () => ({ enabled: false, available: true }),
      getCloudConfig: async () => ({ configured: false, serverUrl: null }),
      accessSnapshot: async () => ({
        configured: false,
        online: false,
        grants: [],
        pending_authorizations: [],
        authority_conflicts: []
      }),
      listActivity: async () => [],
      hostedSnapshot: async () => ({
        online: false,
        hosted_collections_available: false,
        hosted_collections: [],
        grants: [],
        pending_authorizations: []
      }),
      listMirrors: async () => [],
      onNavigate: () => () => undefined,
      onUpdateStatus: () => () => undefined
    };
  }, requestId);
  await page.goto(servers[1].origin);
  await page.getByRole("heading", { name: "Decide what apps can do." }).waitFor();
  await page.getByRole("heading", { name: "Connect this computer to continue." }).waitFor();
  const serverAddress = page.getByLabel("Server address");
  assert.equal(await serverAddress.isVisible(), false, "desktop pairing: server address starts hidden");
  await page.getByText("Use another Connect server", { exact: true }).click();
  await serverAddress.waitFor({ state: "visible" });
  await auditPage(page, "desktop resumed authorization", { keyboard: true });
  assert.deepEqual(errors, []);
  await page.close();
}

async function auditDesktopRoutes() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  await page.addInitScript((pendingAuthorization) => {
    const status = {
      protocol_version: 1,
      state: "connected",
      registered_collections: 0,
      paused: false,
      direct_access_available: true
    };
    const updateStatus = {
      phase: "idle",
      current_version: "0.1.0",
      channel: "beta",
      message: "Up to date",
      can_check: true,
      can_install: false
    };
    const access = {
      configured: true,
      online: true,
      account: {
        connector_id: "11111111-1111-4111-8111-111111111111",
        connector_name: "Test computer",
        user_name: "Example User",
        user_email: "user@example.com"
      },
      grants: [],
      pending_authorizations: [pendingAuthorization],
      authority_conflicts: []
    };
    window.mdbaseConnect = {
      status: async () => status,
      updateStatus: async () => updateStatus,
      listCollections: async () => [],
      getLaunchAtLogin: async () => ({ enabled: false, available: true }),
      getCloudConfig: async () => ({
        configured: true,
        serverUrl: "https://connect.mdbase.dev"
      }),
      accessSnapshot: async () => access,
      listActivity: async () => [],
      hostedSnapshot: async () => ({
        online: true,
        hosted_collections_available: true,
        hosted_collections: [],
        grants: [],
        pending_authorizations: []
      }),
      listMirrors: async () => [],
      onNavigate: () => () => undefined,
      onUpdateStatus: () => () => undefined,
      setAccessPaused: async () => undefined,
      setLaunchAtLogin: async () => ({ enabled: false, available: true }),
      checkForUpdates: async () => updateStatus,
      installUpdate: async () => updateStatus,
      openAuthorization: async () => undefined
    };
  }, desktopAuthorizationFixture("44444444-4444-4444-8444-444444444444"));
  await page.goto(servers[1].origin);
  await page.getByRole("heading", { name: "Your local connection." }).waitFor();
  await page.getByRole("button", { name: "Add existing folder" }).waitFor();
  await page.getByRole("button", { name: "Create collection" }).waitFor();
  await page.getByRole("button", { name: "Pause app access" }).waitFor();
  await auditPage(page, "desktop overview", { keyboard: true });

  for (const route of [
    ["Collections", "Your collections."],
    ["App access", "Decide what apps can do."],
    ["Activity", "What reached this computer."],
    ["Settings", "Connection and startup."]
  ]) {
    await page.getByRole("button", { name: route[0] }).click();
    await page.getByRole("heading", { name: route[1] }).waitFor();
    if (route[0] === "App access") {
      await page.getByRole("button", { name: "Review in portal" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Reject" }).count(), 0);
    }
    await auditPage(page, `desktop ${route[0].toLowerCase()}`);
  }
  assert.deepEqual(errors, []);
  await page.close();
}

function portalAuthorizationFixture(id) {
  return {
    id,
    flow: "authorization_code",
    requested_operations: ["read", "create", "delete"],
    collection_id: null,
    expires_at: "2099-08-01T00:00:00.000Z",
    application_id: "app-workout-journal",
    application_name: "Workout journal",
    distribution: "web",
    homepage: "https://journal.example",
    project_url: null,
    icon: null,
    requirements: { contracts: [], access: "full_collection" },
    provisions: { type_packs: [] },
    notifications: { criteria: [] },
    available_collections: [],
    unavailable_connectors: []
  };
}

function desktopAuthorizationFixture(id) {
  return {
    id,
    application_id: "app-workout-journal",
    application_name: "Workout journal",
    application_distribution: "web",
    application_homepage: "https://journal.example",
    flow: "authorization_code",
    requested_operations: ["read", "create", "delete"],
    requirements: { contracts: [], access: "full_collection" },
    provisions: { type_packs: [] },
    notifications: { criteria: [] },
    compatible_collection_ids: [],
    provisionable_collection_ids: [],
    collection_types: [],
    expires_at: "2099-08-01T00:00:00.000Z"
  };
}

async function expectText(page, value) {
  await page.getByText(value, { exact: true }).waitFor();
}

async function auditPage(page, label, options = {}) {
  assert.equal(await page.locator("html").getAttribute("lang"), "en", `${label}: language`);
  assert.equal(await page.locator("main").count(), 1, `${label}: one main landmark`);
  assert.equal(await page.locator("h1").count(), 1, `${label}: one primary heading`);

  const structuralProblems = await page.evaluate(() => {
    const visible = (element) => {
      const closedDetails = element.closest("details:not([open])");
      if (closedDetails) {
        const summary = closedDetails.querySelector(":scope > summary");
        if (!summary?.contains(element)) return false;
      }
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && bounds.width > 0
        && bounds.height > 0;
    };
    const labels = new Map();
    for (const element of document.querySelectorAll("[id]")) {
      labels.set(element.id, (labels.get(element.id) ?? 0) + 1);
    }
    const duplicateIds = [...labels.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
    const unnamedControls = [
      ...document.querySelectorAll(
        "button, a[href], input, select, textarea, summary, [role=button], [role=switch]"
      )
    ].filter((element) => {
      if (!visible(element) || element.matches(":disabled")) return false;
      const labelledBy = element.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const enclosingLabel = element.closest("label")?.textContent;
      const explicitLabel = element.id
        ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent
        : "";
      const name = element.getAttribute("aria-label")
        || labelledBy
        || explicitLabel
        || enclosingLabel
        || element.getAttribute("title")
        || element.textContent
        || element.getAttribute("placeholder");
      return !name?.trim();
    }).map((element) => element.outerHTML.slice(0, 180));
    const headingLevels = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter(visible)
      .map((heading) => Number(heading.tagName.slice(1)));
    const headingSkips = headingLevels
      .slice(1)
      .filter((level, index) => level > headingLevels[index] + 1);
    return { duplicateIds, unnamedControls, headingSkips };
  });
  assert.deepEqual(
    structuralProblems,
    { duplicateIds: [], unnamedControls: [], headingSkips: [] },
    `${label}: semantic structure`
  );

  const session = await page.context().newCDPSession(page);
  const { nodes } = await session.send("Accessibility.getFullAXTree");
  await session.detach();
  const interactiveRoles = new Set([
    "button",
    "checkBox",
    "comboBox",
    "link",
    "radioButton",
    "switch",
    "textField"
  ]);
  const unnamedAccessibleControls = nodes
    .filter((node) => !node.ignored && interactiveRoles.has(node.role?.value))
    .filter((node) => !node.name?.value?.trim())
    .map((node) => node.role?.value);
  assert.deepEqual(
    unnamedAccessibleControls,
    [],
    `${label}: accessibility-tree control names`
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  const movingElements = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const durations = [
          ...style.animationDuration.split(","),
          ...style.transitionDuration.split(",")
        ].map((value) => value.endsWith("ms")
          ? Number.parseFloat(value) / 1_000
          : Number.parseFloat(value));
        return durations.some((duration) => Number.isFinite(duration) && duration > 0.02);
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
      .slice(0, 10)
  );
  assert.deepEqual(movingElements, [], `${label}: reduced-motion styling`);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  if (options.keyboard) await assertKeyboardReachability(page, label);
}

async function assertKeyboardReachability(page, label) {
  const expected = await page.evaluate(() => {
    const visible = (element) => {
      const closedDetails = element.closest("details:not([open])");
      if (closedDetails) {
        const summary = closedDetails.querySelector(":scope > summary");
        if (!summary?.contains(element)) return false;
      }
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && bounds.width > 0
        && bounds.height > 0;
    };
    return [
      ...document.querySelectorAll(
        "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary"
      )
    ].filter(visible).map((element, index) => {
      const id = `a11y-${index}`;
      element.setAttribute("data-a11y-test", id);
      return { id, element: element.outerHTML.slice(0, 180) };
    });
  });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    document.body.focus();
  });
  const reached = new Set();
  for (let index = 0; index < expected.length * 2 + 2 && reached.size < expected.length; index += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-a11y-test") ?? ""
    );
    if (active) reached.add(active);
  }
  const expectedIds = expected.map(({ id }) => id);
  const missing = expected.filter(({ id }) => !reached.has(id));
  assert.deepEqual([...reached].sort(), expectedIds.sort(),
    `${label}: every visible control is keyboard reachable; missing ${missing.map(({ element }) => element).join(", ")}`);
}

function watchPageErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });
  return errors;
}

async function serveStaticApplication(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
      let target = resolve(root, relativePath || "index.html");
      if (!target.startsWith(`${root}${sep}`) && target !== root) {
        response.writeHead(400).end();
        return;
      }
      try {
        if (!(await stat(target)).isFile()) throw new Error("not a file");
      } catch {
        target = resolve(root, "index.html");
      }
      response.writeHead(200, {
        "content-type": contentType(target),
        "cache-control": "no-store"
      });
      response.end(await readFile(target));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function contentType(path) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  }[extname(path)] ?? "application/octet-stream";
}

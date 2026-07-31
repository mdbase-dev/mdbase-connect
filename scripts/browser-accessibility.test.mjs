import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";

const roots = {
  portal: resolve("apps/portal/dist"),
  desktop: resolve("apps/desktop/dist/renderer")
};
const screenshotDirectory = process.env.MDBASE_CONNECT_A11Y_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const servers = await Promise.all(
  Object.values(roots).map((root) => serveStaticApplication(root))
);
const browser = await chromium.launch({ headless: true });

try {
  await auditPortalLogin();
  await auditPortalDashboard();
  await auditPortalAccount();
  await auditPortalAccountDeleted();
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

async function auditPortalDashboard() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
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
          hosted_collections_available: true,
          authentication: { provider: "github", registration: "open" },
          connectors: [],
          collections: [],
          hosted_collections: [],
          grants: [],
          pending_authorizations: []
        }
      });
      return;
    }
    if (pathname === "/v1/account/sessions") {
      await route.fulfill({ json: { sessions: [] } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto(servers[0].origin);
  await page.getByRole("heading", { name: "Your connections." }).waitFor();
  const portalNavigation = page.getByRole("navigation", { name: "mdbase connect navigation" });
  await portalNavigation.waitFor();
  await assertThemeMenu(page, "portal dashboard");
  await auditPage(page, "portal dashboard", { keyboard: true });

  await portalNavigation.getByRole("link", { name: /^Requests/ }).click();
  await page.getByRole("heading", { name: "Review access requests." }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/requests", "portal requests: stable route");
  assert.equal(await portalNavigation.getByRole("link", { name: /^Requests/ }).getAttribute("aria-current"), "page");
  await page.goBack();
  await page.getByRole("heading", { name: "Your connections." }).waitFor();

  for (const route of [
    ["Requests", "/requests", "Review access requests."],
    ["Hosted collections", "/hosted-collections", "Collections hosted by mdbase."],
    ["App access", "/app-access", "Decide what apps can do."],
    ["Computers", "/computers", "Your connected computers."]
  ]) {
    await portalNavigation.getByRole("link", { name: new RegExp(`^${route[0]}`) }).click();
    await page.getByRole("heading", { name: route[2] }).waitFor();
    assert.equal(new URL(page.url()).pathname, route[1], `portal ${route[0]}: stable route`);
    assert.equal(
      await portalNavigation.getByRole("link", { name: new RegExp(`^${route[0]}`) }).getAttribute("aria-current"),
      "page",
      `portal ${route[0]}: current page exposed`
    );
    await auditPage(page, `portal ${route[0].toLowerCase()}`);
    if (screenshotDirectory) {
      await page.screenshot({
        path: resolve(screenshotDirectory, `portal-${route[0].toLowerCase().replaceAll(" ", "-")}.png`),
        fullPage: true
      });
    }
  }
  await page.reload();
  await page.getByRole("heading", { name: "Your connected computers." }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/computers", "portal route survives reload");
  await portalNavigation.getByRole("link", { name: /^Overview/ }).click();
  await page.getByRole("heading", { name: "Your connections." }).waitFor();
  await assertResponsiveSidebar(page, "portal dashboard");
  assert.deepEqual(errors, []);
  await page.close();
}

async function auditPortalAccount() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
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
          hosted_collections_available: true,
          authentication: { provider: "password", registration: "open" },
          connectors: [],
          collections: [],
          hosted_collections: [],
          grants: [],
          pending_authorizations: []
        }
      });
      return;
    }
    if (pathname === "/v1/account") {
      await route.fulfill({
        json: {
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Example User",
            email: "user@example.com",
            login: "example"
          },
          authentication: {
            managed: true,
            current_provider: "password",
            available_providers: {
              github: true,
              google: true,
              password: true
            },
            identities: [{
              provider: "github",
              subject: "12345",
              login: "example",
              email: null,
              email_verified: false,
              linked_at: "2026-07-31T01:02:03.000Z",
              current: false,
              removable: true
            }],
            password: {
              configured: true,
              email: "user@example.com",
              current: true,
              change_available: true
            }
          },
          storage: {
            status: "available",
            total_content_bytes: 12_345,
            total_records: 42,
            collections: [{
              id: "22222222-2222-4222-8222-222222222222",
              display_name: "Research notes",
              usage: {
                collection_id: "22222222-2222-4222-8222-222222222222",
                record_count: 42,
                content_bytes: 12_345,
                max_records: 100_000,
                max_content_bytes: 1_073_741_824,
                max_document_bytes: 2_097_152
              }
            }]
          },
          deletion: {
            available: true,
            hosted_collections: 1,
            local_collections: 2,
            computers: 1,
            development_confirmation: false
          }
        }
      });
      return;
    }
    if (pathname === "/v1/account/sessions") {
      await route.fulfill({ json: { sessions: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.goto(`${servers[0].origin}/account`);
  await page.getByRole("heading", { name: "Account and storage." }).waitFor();
  await expectText(page, "42 records");
  assert.equal(
    await page.getByRole("progressbar", { name: "Research notes storage" })
      .getAttribute("aria-valuenow"),
    "12345"
  );
  await auditPage(page, "portal account", { keyboard: true });
  if (screenshotDirectory) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: resolve(screenshotDirectory, "portal-account.png"),
      fullPage: true
    });
  }
  await page.getByRole("button", { name: "Change password" }).click();
  await page.getByLabel("Current password").waitFor();
  assert.equal(
    await page.getByLabel("New password", { exact: true }).getAttribute("minlength"),
    "15"
  );
  assert.equal(await page.getByLabel("Confirm new password").getAttribute("minlength"), "15");
  await auditPage(page, "portal password change", { keyboard: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Current password").waitFor({ state: "detached" });
  await assertResponsiveSidebar(page, "portal account");
  await page.getByRole("button", { name: "Delete account…" }).click();
  await expectText(page, "Local files are never removed from your computers.");
  await expectText(page, "Local collection and mirror files remain on your computers.");
  assert.equal(
    await page.getByRole("button", { name: "Delete account permanently" }).isDisabled(),
    true
  );
  await auditPage(page, "portal account deletion", { keyboard: true });
  if (screenshotDirectory) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: resolve(screenshotDirectory, "portal-account-deletion.png"),
      fullPage: true
    });
  }
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
          collections: [],
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
  const localFolder = page.getByRole("link", { name: "Use a local folder" });
  assert.equal(
    await localFolder.getAttribute("href"),
    `mdbase-connect://authorize?request_id=${requestId}`,
    "portal authorization: desktop link preserves request ID"
  );
  await expectText(page, "View and find records · Create and edit records · Delete records");
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
  await localFolder.waitFor();
  assert.equal(
    new URL(page.url()).searchParams.has("continue_in_desktop"),
    false,
    "portal authorization: browser review remains available"
  );
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

async function auditPortalAccountDeleted() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  await page.goto(`${servers[0].origin}/account-deleted`);
  await page.getByRole("heading", { name: "Your account has been deleted." }).waitFor();
  await expectText(page, "Any local collection and mirror files remain on your computers.");
  await auditPage(page, "portal account deleted", { keyboard: true });
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
      openAccount: async () => undefined,
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
      installUpdate: async () => updateStatus
    };
  }, desktopAuthorizationFixture("44444444-4444-4444-8444-444444444444"));
  await page.goto(servers[1].origin);
  await page.getByRole("heading", { name: "Your local connection." }).waitFor();
  await page.getByRole("button", { name: "Add existing folder" }).waitFor();
  await page.getByRole("button", { name: "Create collection" }).waitFor();
  await page.getByRole("button", { name: "Pause app access" }).waitFor();
  await page.getByRole("navigation", { name: "mdbase connect navigation" }).waitFor();
  await auditPage(page, "desktop overview", { keyboard: true });
  if (screenshotDirectory) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: resolve(screenshotDirectory, "desktop-overview.png"),
      fullPage: true
    });
  }

  for (const route of [
    ["Collections", "Your collections."],
    ["App access", "Decide what apps can do."],
    ["Activity", "What reached this computer."],
    ["Settings", "Connection and startup."]
  ]) {
    await page.getByRole("button", { name: route[0] }).click();
    await page.getByRole("heading", { name: route[1] }).waitFor();
    if (route[0] === "App access") {
      await page.getByRole("button", { name: "Add a folder" }).waitFor();
      await page.getByRole("button", { name: "Create collection" }).waitFor();
      await expectText(page, "View and find records · Create and edit records · Delete records");
    }
    if (route[0] === "Settings") {
      await assertThemeMenu(page, "desktop settings");
    }
    await auditPage(page, `desktop ${route[0].toLowerCase()}`, {
      keyboard: route[0] === "Settings"
    });
    if (screenshotDirectory && route[0] === "Settings") {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: resolve(screenshotDirectory, "desktop-settings.png"),
        fullPage: true
      });
    }
  }
  await assertResponsiveSidebar(page, "desktop application");
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

async function assertThemeMenu(page, label) {
  const trigger = page.getByRole("button", { name: /^Color theme:/ }).first();
  await trigger.waitFor();
  assert.equal((await trigger.textContent())?.trim(), "", `${label}: trigger is icon only`);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false", `${label}: menu starts closed`);

  await trigger.click();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true", `${label}: menu exposes open state`);
  const menu = page.getByRole("menu", { name: "Color theme" });
  await menu.waitFor();
  assert.equal(await page.getByRole("menuitemradio").count(), 3, `${label}: every theme is available`);
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitemradio");
  if (screenshotDirectory) {
    await page.screenshot({
      path: resolve(screenshotDirectory, `${label.replaceAll(" ", "-")}-theme-menu.png`)
    });
  }

  await page.keyboard.press("End");
  const dark = page.getByRole("menuitemradio", { name: "Dark" });
  assert.equal(await dark.evaluate((element) => element === document.activeElement), true, `${label}: keyboard focus reaches dark`);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", `${label}: dark theme applies`);
  assert.equal(await trigger.getAttribute("aria-label"), "Color theme: Dark", `${label}: current theme is named`);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false", `${label}: selecting closes menu`);

  await trigger.click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitemradio");
  if (screenshotDirectory) {
    await page.screenshot({
      path: resolve(screenshotDirectory, `${label.replaceAll(" ", "-")}-dark-theme-menu.png`)
    });
  }
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("html").getAttribute("data-theme"), null, `${label}: system theme applies`);

  await trigger.click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitemradio");
  await page.keyboard.press("Escape");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false", `${label}: Escape closes menu`);
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, `${label}: Escape restores trigger focus`);
}

async function assertResponsiveSidebar(page, label) {
  const navigation = page.getByRole("navigation", { name: "mdbase connect navigation" });
  await navigation.waitFor({ state: "visible" });
  assert.equal(await navigation.isVisible(), true, `${label}: desktop sidebar visible`);
  await page.setViewportSize({ width: 720, height: 820 });
  await navigation.waitFor({ state: "hidden" });
  assert.equal(await navigation.isVisible(), false, `${label}: mobile sidebar starts closed`);
  const toggle = page.getByRole("button", { name: "Open navigation" });
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${label}: mobile navigation state exposed`);
  await navigation.waitFor({ state: "visible" });
  await page.waitForTimeout(220);
  assert.equal(await navigation.isVisible(), true, `${label}: mobile sidebar opens`);
  const navigationBounds = await navigation.boundingBox();
  assert(
    navigationBounds
      && navigationBounds.x >= 0
      && navigationBounds.x + navigationBounds.width <= 250,
    `${label}: mobile sidebar finishes on screen (${JSON.stringify(navigationBounds)})`
  );
  if (screenshotDirectory) {
    await page.screenshot({
      path: resolve(
        screenshotDirectory,
        `${label.replaceAll(" ", "-")}-mobile-navigation.png`
      )
    });
  }
  await page.getByRole("button", { name: "Close navigation" }).click();
  await navigation.waitFor({ state: "hidden" });
  assert.equal(await navigation.isVisible(), false, `${label}: mobile sidebar closes`);
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function auditPage(page, label, options = {}) {
  assert.equal(await page.locator("html").getAttribute("lang"), "en", `${label}: language`);
  assert.equal(await page.locator("main").count(), 1, `${label}: one main landmark`);
  assert.equal(await page.locator("h1").count(), 1, `${label}: one primary heading`);

  const structuralProblems = await page.evaluate(() => {
    const visible = (element) => {
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
        "button, a[href], input, select, textarea, [role=button], [role=switch]"
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
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && bounds.width > 0
        && bounds.height > 0;
    };
    return [
      ...document.querySelectorAll(
        "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)"
      )
    ].filter(visible).map((element, index) => {
      const id = `a11y-${index}`;
      element.setAttribute("data-a11y-test", id);
      return id;
    });
  });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    document.body.focus();
  });
  const reached = new Set();
  for (let index = 0; index < expected.length + 2; index += 1) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-a11y-test") ?? ""
    );
    if (active) reached.add(active);
  }
  assert.deepEqual(
    [...reached].sort(),
    [...expected].sort(),
    `${label}: every visible control is keyboard reachable`
  );
}

function watchPageErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });
  return errors;
}

async function expectText(page, value) {
  await page.getByText(value, { exact: false }).first().waitFor();
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

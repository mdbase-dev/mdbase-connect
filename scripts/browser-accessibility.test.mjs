import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";

const roots = {
  portal: resolve("apps/portal/dist"),
  desktop: resolve("apps/desktop/dist/renderer")
};
const servers = await Promise.all(
  Object.values(roots).map((root) => serveStaticApplication(root))
);
const browser = await chromium.launch({ headless: true });

try {
  await auditPortalLogin();
  await auditPortalDashboard();
  await auditPortalDeviceAuthorization();
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
  await auditPage(page, "portal dashboard", { keyboard: true });
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

async function auditDesktopRoutes() {
  const page = await browser.newPage();
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
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
      pending_authorizations: [],
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
      installUpdate: async () => updateStatus
    };
  });
  await page.goto(servers[1].origin);
  await page.getByRole("heading", { name: "Your local connection." }).waitFor();
  await auditPage(page, "desktop overview", { keyboard: true });

  for (const route of [
    ["Collections", "Your collections, in one place."],
    ["App access", "Decide what apps can do."],
    ["Activity", "What reached this computer."],
    ["Settings", "Connection and startup."]
  ]) {
    await page.getByRole("button", { name: route[0] }).click();
    await page.getByRole("heading", { name: route[1] }).waitFor();
    await auditPage(page, `desktop ${route[0].toLowerCase()}`);
  }
  assert.deepEqual(errors, []);
  await page.close();
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

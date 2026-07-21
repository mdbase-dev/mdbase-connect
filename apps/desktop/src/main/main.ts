import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray
} from "electron";
import { createHash } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { requestAgent } from "./control-client";
import { relaunchAfterAgentStops } from "./agent-lifecycle";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentProcess: ChildProcess | null = null;
let agentStartup: Promise<void> | null = null;
let quitting = false;
const activePairings = new Map<string, { serverUrl: string; secret: string }>();

interface StoredCloudConfig {
  server_url: string;
  encrypted_token: string;
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function stateDirectory(): string {
  return join(app.getPath("userData"), "agent");
}

function controlEndpoint(): string {
  const stateDir = stateDirectory();
  if (process.platform !== "win32") return join(stateDir, "agent.sock");
  const suffix = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\mdbase-connect-${suffix}`;
}

function agentBinary(): string {
  const extension = process.platform === "win32" ? ".exe" : "";
  const override = process.env.MDBASE_CONNECT_AGENT_BIN;
  if (override) return override;
  if (app.isPackaged) {
    return join(process.resourcesPath, `mdbase-connect-agent${extension}`);
  }
  return resolve(__dirname, `../../../../target/debug/mdbase-connect-agent${extension}`);
}

async function ensureAgent(): Promise<void> {
  if (agentStartup) return agentStartup;
  agentStartup = startAgent().finally(() => {
    agentStartup = null;
  });
  return agentStartup;
}

async function requestReadyAgent<T>(
  method: string,
  params?: unknown,
  timeoutMs = 5_000
): Promise<T> {
  await ensureAgent();
  return requestAgent<T>(controlEndpoint(), method, params, timeoutMs);
}

interface AgentPing {
  pong: boolean;
  ready?: boolean;
}

async function waitForAgentReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const ping = await requestAgent<AgentPing>(controlEndpoint(), "ping", undefined, 500);
      if (ping.ready !== false) return;
    } catch {
      // The process may still be binding its local endpoint.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("The local connector did not finish starting in time.");
}

function endpointIsUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function startAgent(): Promise<void> {
  let running = false;
  try {
    const ping = await requestAgent<AgentPing>(controlEndpoint(), "ping", undefined, 400);
    running = true;
    if (ping.ready !== false) return;
  } catch (error) {
    if (!endpointIsUnavailable(error)) return waitForAgentReady();
  }
  if (running) return waitForAgentReady();

  const binary = agentBinary();
  if (!existsSync(binary)) {
    throw new Error(`Connector agent is missing: ${binary}`);
  }
  await mkdir(stateDirectory(), { recursive: true });
  const cloud = await effectiveCloudConfig();
  const cloudArgs = cloud
    ? ["--server-url", cloud.serverUrl, "--connector-token", cloud.connectorToken]
    : [];
  const spawned = spawn(
    binary,
    ["--state-dir", stateDirectory(), "--endpoint", controlEndpoint(), ...cloudArgs],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  agentProcess = spawned;
  spawned.stdout?.on("data", (chunk) => console.info(String(chunk).trim()));
  spawned.stderr?.on("data", (chunk) => console.error(String(chunk).trim()));
  spawned.once("exit", () => {
    if (agentProcess === spawned) agentProcess = null;
  });
  await waitForAgentReady();
}

function trustedIpc(event: Electron.IpcMainInvokeEvent): void {
  const source = event.senderFrame?.url ?? "";
  if (!source.startsWith("file://")) {
    throw new Error("Untrusted renderer attempted to use the connector API.");
  }
}

async function chooseFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a collection folder",
    properties: ["openDirectory", "createDirectory"]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

function registerIpc(): void {
  ipcMain.handle("connect:status", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("status");
  });
  ipcMain.handle("connect:collections:list", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("collections.list");
  });
  ipcMain.handle("connect:collections:add", async (event) => {
    trustedIpc(event);
    const path = await chooseFolder();
    if (!path) return null;
    return requestReadyAgent("collections.add", { path });
  });
  ipcMain.handle("connect:collections:choose-create", async (event) => {
    trustedIpc(event);
    return chooseFolder();
  });
  ipcMain.handle("connect:collections:create", async (event, input: unknown) => {
    trustedIpc(event);
    if (!input || typeof input !== "object") throw new Error("Invalid collection input.");
    const { path, name } = input as { path?: unknown; name?: unknown };
    if (typeof path !== "string" || path.length === 0) throw new Error("Choose a folder.");
    if (typeof name !== "string" || name.trim().length === 0) throw new Error("Enter a collection name.");
    return requestReadyAgent("collections.create", { path, name: name.trim() });
  });
  ipcMain.handle("connect:collections:update-metadata", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection metadata.");
    const collectionId = value.collectionId;
    const name = value.name;
    const description = value.description;
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    if (typeof name !== "string" || name.trim().length === 0 || [...name.trim()].length > 100) {
      throw new Error("Collection name must be between 1 and 100 characters.");
    }
    if (description !== undefined && (typeof description !== "string" || [...description.trim()].length > 500)) {
      throw new Error("Collection description must be 500 characters or fewer.");
    }
    return requestReadyAgent("collections.update-metadata", {
      collection_id: collectionId,
      name: name.trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : undefined
    });
  });
  ipcMain.handle("connect:collections:set-enabled", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection setting.");
    if (typeof value.collectionId !== "string" || typeof value.enabled !== "boolean") {
      throw new Error("Invalid collection setting.");
    }
    return requestReadyAgent("collections.set-enabled", {
      collection_id: value.collectionId,
      enabled: value.enabled
    });
  });
  ipcMain.handle("connect:collections:validate", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    return requestReadyAgent("collections.validate", {
      collection_id: collectionId
    });
  });
  ipcMain.handle("connect:collections:remove", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    return requestReadyAgent("collections.remove", {
      collection_id: collectionId
    });
  });
  ipcMain.handle("connect:path:open", async (event, path: unknown) => {
    trustedIpc(event);
    if (typeof path !== "string") throw new Error("Invalid path.");
    const collection = (await requestReadyAgent<Array<{ path: string }>>(
      "collections.list"
    )).find((candidate) => candidate.path === path);
    if (!collection) throw new Error("That path is not a registered collection.");
    return shell.openPath(collection.path);
  });
  ipcMain.handle("connect:collections:open-config", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    const collection = (await requestReadyAgent<Array<{ id: string; path: string }>>(
      "collections.list"
    )).find((candidate) => candidate.id === collectionId);
    if (!collection) throw new Error("That collection is not registered.");
    return shell.openPath(join(collection.path, "mdbase.yaml"));
  });
  ipcMain.handle("connect:startup:get", async (event) => {
    trustedIpc(event);
    return getLaunchAtLogin();
  });
  ipcMain.handle("connect:startup:set", async (event, enabled: unknown) => {
    trustedIpc(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid startup setting.");
    return setLaunchAtLogin(enabled);
  });
  ipcMain.handle("connect:cloud:get", async (event) => {
    trustedIpc(event);
    const cloud = await effectiveCloudConfig();
    return { configured: Boolean(cloud), serverUrl: cloud?.serverUrl ?? null };
  });
  ipcMain.handle("connect:cloud:set", async (event, input: unknown) => {
    trustedIpc(event);
    if (!input || typeof input !== "object") throw new Error("Invalid cloud connection input.");
    const { serverUrl, connectorToken } = input as {
      serverUrl?: unknown;
      connectorToken?: unknown;
    };
    if (typeof serverUrl !== "string" || typeof connectorToken !== "string") {
      throw new Error("Server URL and connector token are required.");
    }
    await writeCloudConfig(serverUrl, connectorToken);
    restartApplication();
    return { configured: true, serverUrl };
  });
  ipcMain.handle("connect:cloud:clear", async (event) => {
    trustedIpc(event);
    await rm(cloudConfigPath(), { force: true });
    restartApplication();
    return { configured: false, serverUrl: null };
  });
  ipcMain.handle("connect:pairing:begin", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid pairing input.");
    const serverUrl = validateServerUrl(value.serverUrl);
    const connectorName = typeof value.connectorName === "string" && value.connectorName.trim()
      ? value.connectorName.trim().slice(0, 100)
      : hostname();
    const response = await fetch(`${serverUrl}/v1/pairing-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connector_name: connectorName })
    });
    const body = await response.json() as {
      pairing_id?: string;
      pairing_secret?: string;
      verification_uri?: string;
      expires_in?: number;
      error?: { message?: string };
    };
    if (!response.ok || !body.pairing_id || !body.pairing_secret || !body.verification_uri) {
      throw new Error(body.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
    }
    const verification = new URL(body.verification_uri);
    if (verification.origin !== new URL(serverUrl).origin) {
      throw new Error("The pairing server returned an untrusted verification address.");
    }
    activePairings.set(body.pairing_id, { serverUrl, secret: body.pairing_secret });
    await shell.openExternal(body.verification_uri);
    return {
      pairingId: body.pairing_id,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in ?? 600
    };
  });
  ipcMain.handle("connect:pairing:status", async (event, pairingId: unknown) => {
    trustedIpc(event);
    if (typeof pairingId !== "string") throw new Error("Invalid pairing request.");
    const pairing = activePairings.get(pairingId);
    if (!pairing) throw new Error("That pairing request is no longer active.");
    const response = await fetch(`${pairing.serverUrl}/v1/pairing-requests/${pairingId}/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${pairing.secret}` }
    });
    const body = await response.json() as {
      status?: "pending" | "paired";
      token?: string;
      connector?: { id: string; name: string };
      error?: { message?: string };
    };
    if (response.status === 202) return { status: "pending" };
    if (!response.ok || body.status !== "paired" || !body.token) {
      throw new Error(body.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
    }
    activePairings.delete(pairingId);
    await writeCloudConfig(pairing.serverUrl, body.token);
    restartApplication(1_000);
    return { status: "paired", connector: body.connector };
  });
  ipcMain.handle("connect:access:snapshot", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("access.snapshot", undefined, 8_000);
  });
  ipcMain.handle("connect:access:pause", async (event, paused: unknown) => {
    trustedIpc(event);
    if (typeof paused !== "boolean") throw new Error("Invalid pause setting.");
    return requestReadyAgent("access.pause", { paused }, 10_000);
  });
  ipcMain.handle("connect:account:rename-computer", async (event, name: unknown) => {
    trustedIpc(event);
    if (typeof name !== "string" || name.trim().length === 0 || [...name.trim()].length > 100) {
      throw new Error("Computer name must be between 1 and 100 characters.");
    }
    return requestReadyAgent("account.rename-computer", { name: name.trim() }, 10_000);
  });
  ipcMain.handle("connect:apps:discover", async (event, manifestUrl: unknown) => {
    trustedIpc(event);
    if (typeof manifestUrl !== "string") throw new Error("Enter an application manifest URL.");
    return requestReadyAgent("apps.discover", { manifest_url: manifestUrl }, 15_000);
  });
  ipcMain.handle("connect:grants:create", async (event, input: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("grants.create", grantInput(input, true), 10_000);
  });
  ipcMain.handle("connect:grants:update", async (event, input: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("grants.update", grantInput(input, false), 10_000);
  });
  ipcMain.handle("connect:grants:revoke", async (event, grantId: unknown) => {
    trustedIpc(event);
    if (typeof grantId !== "string") throw new Error("Invalid grant ID.");
    return requestReadyAgent("grants.revoke", { grant_id: grantId }, 10_000);
  });
  ipcMain.handle("connect:authorizations:approve", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid authorization decision.");
    if (typeof value.requestId !== "string" || typeof value.collectionId !== "string") {
      throw new Error("Choose a collection for this request.");
    }
    const operations = stringArray(value.operations, "Choose at least one operation.");
    return requestReadyAgent(
      "authorizations.approve",
      { request_id: value.requestId, collection_id: value.collectionId, operations },
      10_000
    );
  });
  ipcMain.handle("connect:authorizations:deny", async (event, requestId: unknown) => {
    trustedIpc(event);
    if (typeof requestId !== "string") throw new Error("Invalid authorization request.");
    return requestReadyAgent(
      "authorizations.deny",
      { request_id: requestId },
      10_000
    );
  });
  ipcMain.handle("connect:activity:list", async (event, limit: unknown) => {
    trustedIpc(event);
    const value = typeof limit === "number" ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    return requestReadyAgent("activity.list", { limit: value });
  });
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new Error(message);
  }
  return [...new Set(value as string[])];
}

function grantInput(input: unknown, includeTarget: boolean): Record<string, unknown> {
  const value = asObject(input, "Invalid application access input.");
  const result: Record<string, unknown> = {
    operations: stringArray(value.operations, "Choose at least one operation.")
  };
  if (includeTarget) {
    if (typeof value.applicationId !== "string" || typeof value.collectionId !== "string") {
      throw new Error("Choose an application and collection.");
    }
    result.application_id = value.applicationId;
    result.collection_id = value.collectionId;
  } else {
    if (typeof value.grantId !== "string") throw new Error("Invalid grant ID.");
    result.grant_id = value.grantId;
  }
  return result;
}

function cloudConfigPath(): string {
  return join(app.getPath("userData"), "cloud.json");
}

async function readCloudConfig(): Promise<{
  serverUrl: string;
  connectorToken: string;
} | null> {
  let stored: StoredCloudConfig;
  try {
    stored = JSON.parse(await readFile(cloudConfigPath(), "utf8")) as StoredCloudConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cloud connection settings could not be read.");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this computer.");
  }
  try {
    return {
      serverUrl: stored.server_url,
      connectorToken: safeStorage.decryptString(Buffer.from(stored.encrypted_token, "base64"))
    };
  } catch {
    throw new Error("The stored connector credential could not be decrypted.");
  }
}

async function effectiveCloudConfig(): Promise<{ serverUrl: string; connectorToken: string } | null> {
  const stored = await readCloudConfig();
  if (stored) return stored;
  const serverUrl = process.env.MDBASE_CONNECT_SERVER_URL;
  const connectorToken = process.env.MDBASE_CONNECT_CONNECTOR_TOKEN;
  if (!serverUrl && !connectorToken) return null;
  if (!serverUrl || !connectorToken) {
    throw new Error("Both MDBASE_CONNECT_SERVER_URL and MDBASE_CONNECT_CONNECTOR_TOKEN are required.");
  }
  return { serverUrl: validateServerUrl(serverUrl), connectorToken };
}

async function writeCloudConfig(serverUrl: string, connectorToken: string): Promise<void> {
  const url = new URL(validateServerUrl(serverUrl));
  if (!connectorToken.startsWith("con_") || connectorToken.length < 24) {
    throw new Error("That connector token is not valid.");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this computer.");
  }
  const stored: StoredCloudConfig = {
    server_url: url.href.replace(/\/$/, ""),
    encrypted_token: safeStorage.encryptString(connectorToken.trim()).toString("base64")
  };
  await writeFile(cloudConfigPath(), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

function validateServerUrl(serverUrl: unknown): string {
  if (typeof serverUrl !== "string") throw new Error("Enter a server address.");
  const url = new URL(serverUrl.trim());
  const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new Error("Remote mdbase connect servers must use HTTPS.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function restartApplication(delay = 250): void {
  setTimeout(() => {
    quitting = true;
    const runningAgent = agentProcess;
    void relaunchAfterAgentStops(
      runningAgent,
      () => app.relaunch(),
      () => app.exit(0)
    ).catch((error) => {
      quitting = false;
      dialog.showErrorBox(
        "mdbase connect could not restart",
        error instanceof Error ? error.message : String(error)
      );
    });
  }, delay);
}

function registerDeepLinks(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("mdbase-connect", process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("mdbase-connect");
  }
}

function handleDeepLink(value: string | undefined): void {
  if (!value?.startsWith("mdbase-connect://")) return;
  try {
    const url = new URL(value);
    if (url.hostname === "authorize") {
      showRoute("access");
    } else if (url.hostname === "paired") {
      showRoute("overview");
    }
  } catch {
    // Ignore malformed protocol invocations.
  }
}

function showRoute(route: string): void {
  mainWindow?.show();
  mainWindow?.focus();
  const send = () => mainWindow?.webContents.send("connect:navigate", route);
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
  else send();
}

async function getLaunchAtLogin(): Promise<{ enabled: boolean; available: boolean }> {
  if (!app.isPackaged) return { enabled: false, available: false };
  if (process.platform === "linux") {
    const path = join(app.getPath("appData"), "autostart", "mdbase-connect.desktop");
    try {
      await stat(path);
      return { enabled: true, available: true };
    } catch {
      return { enabled: false, available: true };
    }
  }
  return { enabled: app.getLoginItemSettings().openAtLogin, available: true };
}

async function setLaunchAtLogin(enabled: boolean): Promise<{ enabled: boolean; available: boolean }> {
  if (!app.isPackaged) return { enabled: false, available: false };
  if (process.platform === "linux") {
    const directory = join(app.getPath("appData"), "autostart");
    const path = join(directory, "mdbase-connect.desktop");
    if (enabled) {
      await mkdir(directory, { recursive: true });
      const executable = app.getPath("exe").replaceAll('"', '\\"');
      await writeFile(
        path,
        `[Desktop Entry]\nType=Application\nName=mdbase connect\nExec="${executable}" --hidden\nX-GNOME-Autostart-enabled=true\n`,
        { mode: 0o600 }
      );
    } else {
      await rm(path, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
  }
  return getLaunchAtLogin();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    show: false,
    backgroundColor: "#ffffff",
    title: "mdbase connect",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (target !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) mainWindow?.show();
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  const image = createTrayImage();
  tray = new Tray(image);
  tray.setToolTip("mdbase connect");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show mdbase connect", click: () => mainWindow?.show() },
      { type: "separator" },
      { label: "Local connector running", enabled: false },
      { type: "separator" },
      {
        label: "Quit mdbase connect",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("double-click", () => mainWindow?.show());
}

function createTrayImage(): Electron.NativeImage {
  const width = 18;
  const height = 18;
  const bitmap = Buffer.alloc(width * height * 4);
  const pixel = (
    x: number,
    y: number,
    red: number,
    green: number,
    blue: number,
    alpha = 255
  ) => {
    const offset = (y * width + x) * 4;
    bitmap[offset] = blue;
    bitmap[offset + 1] = green;
    bitmap[offset + 2] = red;
    bitmap[offset + 3] = alpha;
  };
  for (let y = 5; y < 16; y += 1) {
    for (let x = 2; x < 16; x += 1) pixel(x, y, 32, 51, 75);
  }
  for (let y = 3; y < 6; y += 1) {
    for (let x = 3; x < 9; x += 1) pixel(x, y, 32, 51, 75);
  }
  for (let y = 8; y < 13; y += 1) {
    for (let x = 5; x < 13; x += 1) pixel(x, y, 61, 105, 255);
  }
  for (let y = 1; y < 6; y += 1) {
    for (let x = 12; x < 17; x += 1) {
      const dx = x - 14;
      const dy = y - 3;
      if (dx * dx + dy * dy <= 5) pixel(x, y, 40, 167, 124);
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
}

app.whenReady().then(async () => {
  app.on("web-contents-created", (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  });
  registerDeepLinks();
  registerIpc();
  createWindow();
  createTray();
  handleDeepLink(process.argv.find((value) => value.startsWith("mdbase-connect://")));
  try {
    await ensureAgent();
  } catch (error) {
    dialog.showErrorBox(
      "mdbase connect could not start",
      error instanceof Error ? error.message : String(error)
    );
  }
});

app.on("second-instance", (_event, argv) => {
  mainWindow?.show();
  mainWindow?.focus();
  handleDeepLink(argv.find((value) => value.startsWith("mdbase-connect://")));
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
  mainWindow?.show();
});

app.on("before-quit", () => {
  quitting = true;
  agentProcess?.kill();
});

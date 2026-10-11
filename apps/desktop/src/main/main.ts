import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  Tray
} from "electron";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { checkApprovalUrl } from "./approval-url";
import { BootGate } from "./boot-gate";
import { DaemonCli, type DaemonProfile } from "./daemon-cli";
import { DaemonControlError } from "./daemon-client";
import { resolveDaemonRuntime, type DaemonRuntime } from "./daemon-runtime";
import { DaemonSession, healthLabel } from "./daemon-session";
import { routeForDeepLink, shouldRegisterDeepLinks } from "./deep-link";
import { buildEditorUrl } from "./editor-url";
import { guardDesktopProcessOutput } from "./process-output";
import { isTrustedSender } from "./ipc-trust";
import { createTrayImage } from "./tray-image";
import type { DesktopUpdateStatus } from "./update-coordinator";
import { channelForVersion } from "./update-policy";

guardDesktopProcessOutput();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bootGate: BootGate;
let localHealthLabel = "mdbase starting";
let runtime: DaemonRuntime | null = null;
let profile: DaemonProfile | null = null;
let session: DaemonSession | null = null;
let cli: DaemonCli | null = null;
let migrationRun: Promise<unknown> | null = null;
let quitting = false;

/** The app updater is re-pointed at the new daemon in a later step of the port. */
function updateStatus(): DesktopUpdateStatus {
  return {
    phase: "unavailable",
    current_version: app.getVersion(),
    channel: channelForVersion(app.getVersion()),
    message: "Updates are not available in this development build.",
    can_check: false,
    can_install: false
  };
}

const userDataOverride = process.env.MDBASE_CONNECT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", resolve(userDataOverride));

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

autoUpdater.on("before-quit-for-update", () => {
  quitting = true;
});

async function openLocalPath(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) throw new Error(`The folder or file could not be opened. ${error}`);
}

async function registeredCollectionPath(collectionId: unknown): Promise<string> {
  if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
  const collection = (await requestReadyAgent<Array<{ id: string; root: string }>>(
    "collection.list"
  )).find((candidate) => candidate.id === collectionId);
  if (!collection) throw new Error("That collection is not registered.");
  return collection.root;
}

function daemonCli(): DaemonCli {
  if (!cli) throw new Error("mdbase has not been initialized.");
  return cli;
}

/**
 * An explicit, user-chosen move from the old Connect engine. It is never called
 * automatically: the daemon moves on its own once the account's rollout allows it.
 * `migrate start` is privileged, so it runs through the CLI (keychain control key).
 */
function startMigration(stopMirrors: boolean): Promise<unknown> {
  if (migrationRun) return migrationRun;
  const run = bootGate.request(() => daemonCli().run(
    ["migrate", "start", ...(stopMirrors ? ["--stop-mirrors"] : [])],
    MIGRATION_TIMEOUT_MS
  ));
  migrationRun = run.finally(() => { migrationRun = null; });
  return migrationRun;
}
// The daemon's own drain is bounded well below this; the CLI call waits for the run.
const MIGRATION_TIMEOUT_MS = 650_000;

interface AccountInfo {
  signed_in: boolean;
  online: boolean;
  pairing?: string;
  last_error?: string;
  server?: string;
  environment?: string;
}

async function account(): Promise<AccountInfo> {
  return (await requestReadyAgent<{ account: AccountInfo }>("status")).account;
}

/** Pages are opened only on the control plane this daemon was built for. */
function approvalPolicy(current: AccountInfo) {
  return {
    environment: current.environment,
    allowLoopback: !app.isPackaged && runtime?.isolatedStateDir != null
  };
}

/** The control plane this computer is signed in to, for the account page. */
async function signedInServer(): Promise<string> {
  const current = await account();
  if (!current.signed_in || !current.server) throw new Error("Sign in to mdbase on this computer first.");
  return checkApprovalUrl(current.server, approvalPolicy(current));
}

/** Only the daemon's own approval page is opened, exactly as it was issued. */
async function openSignInPage(uri: unknown): Promise<string> {
  const href = checkApprovalUrl(uri, approvalPolicy(await account()));
  await shell.openExternal(href);
  return href;
}

function daemonSession(): DaemonSession {
  if (!session) throw new Error("mdbase has not been initialized.");
  return session;
}

async function initializeDaemon(): Promise<void> {
  runtime = await resolveDaemonRuntime({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    env: process.env
  });
  profile = await DaemonCli.discover(runtime.binary, runtime.isolatedStateDir);
  cli = new DaemonCli(() => runtime!.binary, profile.target, profile.stateDir);
  session = new DaemonSession({ profile, bundled: runtime, cli });
  session.subscribe((state) => {
    localHealthLabel = healthLabel(state);
    refreshTrayMenu();
    mainWindow?.webContents.send("connect:daemon-state", state);
  });
}

async function requestReadyAgent<T>(
  method: string,
  params?: unknown,
  timeoutMs = 5_000
): Promise<T> {
  return bootGate.request(() => daemonSession().request<T>(method, params ?? {}, timeoutMs));
}

const RENDERER_FILE = join(__dirname, "../renderer/index.html");
const RENDERER_URL = pathToFileURL(RENDERER_FILE).href;

function trustedIpc(event: Electron.IpcMainInvokeEvent): void {
  if (!isTrustedSender(event, mainWindow, RENDERER_URL)) {
    throw new Error("Untrusted renderer attempted to use the connector API.");
  }
}

async function chooseFolder(title = "Choose a collection folder"): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
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
  ipcMain.handle("connect:migration:status", async (event) => {
    trustedIpc(event);
    return { ...await requestReadyAgent<object>("migrate.status"), running: migrationRun !== null };
  });
  ipcMain.handle("connect:migration:start", async (event, input: unknown) => {
    trustedIpc(event);
    const stopMirrors = asObject(input, "Invalid migration input.").stopMirrors === true;
    return startMigration(stopMirrors);
  });
  ipcMain.handle("connect:updates:status", (event) => {
    trustedIpc(event);
    return updateStatus();
  });
  ipcMain.handle("connect:updates:check", async (event) => {
    trustedIpc(event);
    return updateStatus();
  });
  ipcMain.handle("connect:updates:install", async (event) => {
    trustedIpc(event);
    throw new Error("Updates are not available in this development build.");
  });
  ipcMain.handle("connect:collections:list", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("collection.list");
  });
  ipcMain.handle("connect:collections:add", async (event) => {
    trustedIpc(event);
    const path = await chooseFolder("Choose a folder to add");
    if (!path) return null;
    return requestReadyAgent("collection.add", { path }, 60_000);
  });
  ipcMain.handle("connect:collections:choose-create", async (event) => {
    trustedIpc(event);
    return chooseFolder("Choose where to create the collection folder");
  });
  // A new collection is a new, empty folder registered as a local collection.
  ipcMain.handle("connect:collections:create", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection input.");
    const name = collectionName(value.name);
    if (typeof value.parent !== "string" || !value.parent) throw new Error("Choose where to create the folder.");
    const folder = join(resolve(value.parent), folderName(name));
    try {
      await mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`A folder named "${folderName(name)}" already exists there. Choose another name or use Add existing.`);
      }
      throw error;
    }
    try {
      return await requestReadyAgent("collection.add", { path: folder, name }, 60_000);
    } catch (error) {
      await rm(folder, { recursive: false }).catch(() => undefined);
      throw error;
    }
  });
  ipcMain.handle("connect:collections:remove", async (event, collectionId: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("collection.remove", { collection: collectionIdOf(collectionId) }, 30_000);
  });
  ipcMain.handle("connect:collections:set-enabled", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection input.");
    if (typeof value.enabled !== "boolean") throw new Error("Invalid collection input.");
    return requestReadyAgent(value.enabled ? "collection.resume" : "collection.pause",
      { collection: collectionIdOf(value.collectionId) }, 30_000);
  });
  // Privileged (it moves the log to mdbase): through the CLI.
  ipcMain.handle("connect:collections:sync-enable", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid sync input.");
    if (value.mode !== "e2e" && value.mode !== "synced") throw new Error("Choose how to sync.");
    return bootGate.request(() => daemonCli().run(
      ["sync", "enable", collectionIdOf(value.collectionId), "--mode", value.mode as string], 600_000
    ));
  });
  ipcMain.handle("connect:collections:sync-disable", async (event, collectionId: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("sync.disable", { collection: collectionIdOf(collectionId) }, 600_000);
  });
  ipcMain.handle("connect:collections:holds", async (event, collectionId: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("collection.holds", { collection: collectionIdOf(collectionId) }, 15_000);
  });
  ipcMain.handle("connect:collections:resolve-hold", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid hold input.");
    if (typeof value.id !== "string" || !["keep_mine", "take_theirs", "keep_both", "delete"].includes(value.how as string)) {
      throw new Error("Invalid hold input.");
    }
    return requestReadyAgent("collection.resolve_hold",
      { collection: collectionIdOf(value.collectionId), id: value.id, how: value.how }, 30_000);
  });
  ipcMain.handle("connect:collections:open-folder", async (event, collectionId: unknown) => {
    trustedIpc(event);
    return openLocalPath(await registeredCollectionPath(collectionId));
  });
  ipcMain.handle("connect:editor:open", async (event, collectionId: unknown) => {
    trustedIpc(event);
    return shell.openExternal(buildEditorUrl(collectionId));
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
    const current = await account();
    return {
      configured: current.signed_in,
      serverUrl: current.server ?? null,
      online: current.online,
      pairing: current.pairing ?? null,
      lastError: current.last_error ?? null
    };
  });
  ipcMain.handle("connect:account:open", async (event) => {
    trustedIpc(event);
    await shell.openExternal(new URL("/account", await signedInServer()).href);
  });
  // `account.sign_in` is privileged, so it runs through the CLI; with --json it
  // returns the approval page without opening it, and the app opens it here.
  ipcMain.handle("connect:account:sign-in", async (event) => {
    trustedIpc(event);
    const result = await bootGate.request(() => daemonCli().run<{ verification_uri?: string; expires_in?: number }>(
      ["account", "sign-in"], 30_000
    ));
    const verificationUri = await openSignInPage(result.verification_uri);
    return { verificationUri, expiresIn: result.expires_in ?? null };
  });
  ipcMain.handle("connect:account:reopen-sign-in", async (event) => {
    trustedIpc(event);
    await openSignInPage((await account()).pairing);
  });
  ipcMain.handle("connect:account:sign-out", async (event) => {
    trustedIpc(event);
    await bootGate.request(() => daemonCli().run(["account", "sign-out"], 30_000));
  });
  ipcMain.handle("connect:access:list", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("access.list");
  });
  // Approve and acknowledge are privileged: the CLI authenticates them, and the
  // daemon still asks on this computer's screen before approving. `--yes` only
  // skips the CLI's terminal prompt, which an app cannot answer.
  ipcMain.handle("connect:access:approve", async (event, grant: unknown) => {
    trustedIpc(event);
    return bootGate.request(() => daemonCli().run(["--yes", "access", "approve", grantIdOf(grant)], 180_000));
  });
  ipcMain.handle("connect:access:ack", async (event, grant: unknown) => {
    trustedIpc(event);
    return bootGate.request(() => daemonCli().run(["access", "ack", grantIdOf(grant)], 30_000));
  });
  ipcMain.handle("connect:access:deny", async (event, grant: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("access.deny", { grant: grantIdOf(grant) }, 10_000);
  });
  ipcMain.handle("connect:access:revoke", async (event, grant: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("access.revoke", { grant: grantIdOf(grant) }, 10_000);
  });
  ipcMain.handle("connect:settings:get", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("settings.get");
  });
  ipcMain.handle("connect:settings:require-approval", async (event, on: unknown) => {
    trustedIpc(event);
    if (typeof on !== "boolean") throw new Error("Invalid setting.");
    return bootGate.request(() => daemonCli().run(
      ["--yes", "settings", "--require-approval", on ? "on" : "off"], 180_000
    ));
  });
}

function collectionIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{32,36}$/iu.test(value)) throw new Error("Invalid collection ID.");
  return value;
}

function grantIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{32,36}$/iu.test(value)) throw new Error("Invalid grant ID.");
  return value;
}

function collectionName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || [...name].length > 100) throw new Error("Collection name must be between 1 and 100 characters.");
  return name;
}

/** A portable folder name from a collection name. */
function folderName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ").trim().replace(/[. ]+$/u, "");
  return cleaned || "Collection";
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}



function registerDeepLinks(): void {
  if (!shouldRegisterDeepLinks()) return;
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("mdbase-connect", process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("mdbase-connect");
  }
}

function handleDeepLink(value: string | undefined): void {
  const route = routeForDeepLink(value);
  if (route) showRoute(route);
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1e24" : "#fcfcfd",
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
  mainWindow.loadFile(RENDERER_FILE);
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
  refreshTrayMenu();
  tray.on("double-click", () => mainWindow?.show());
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show mdbase connect", click: () => mainWindow?.show() },
      { type: "separator" },
      { label: localHealthLabel, enabled: false },
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
}

app.whenReady().then(async () => {
  app.on("web-contents-created", (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  });
  registerDeepLinks();
  try {
    await initializeDaemon();
  } catch (error) {
    dialog.showErrorBox(
      "mdbase connect could not initialize",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
    return;
  }
  bootGate = new BootGate({
    initialize: async () => {},
    start: async () => {
      // The daemon is an OS service (or an isolated development daemon); the app
      // attaches to it and never starts the old connector.
      await daemonSession().start();
    },
    blockedReason: () => null
  });
  registerIpc();
  createWindow();
  createTray();
  handleDeepLink(process.argv.find((value) => value.startsWith("mdbase-connect://")));
  try {
    await bootGate.ready();
  } catch (error) {
    localHealthLabel = "mdbase needs attention";
    refreshTrayMenu();
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
  // Detach only: the daemon keeps serving collections after the window closes.
  session?.stop();
});

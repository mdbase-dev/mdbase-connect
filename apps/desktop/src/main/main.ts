import { createNativeLocale } from "./i18n";
import { isLocale, type I18nRuntime } from "@mdbase-dev/i18n";
import { t, msg } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
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
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { checkApprovalUrl } from "./approval-url";
import { BootGate } from "./boot-gate";
import { DaemonCli, previousRuntimeBinary, type DaemonProfile } from "./daemon-cli";
import { DaemonControlError } from "./daemon-client";
import { resolveDaemonRuntime, type DaemonRuntime } from "./daemon-runtime";
import { DaemonSession, healthLabel } from "./daemon-session";
import { routeForDeepLink, shouldRegisterDeepLinks } from "./deep-link";
import { buildEditorUrl } from "./editor-url";
import { guardDesktopProcessOutput } from "./process-output";
import { isTrustedSender } from "./ipc-trust";
import { createTrayImage } from "./tray-image";
import { ElectronUpdateBackend } from "./electron-update-backend";
import { ensureNextDaemon, nextDaemonRunner } from "./next-daemon";
import { UpdateCoordinator } from "./update-coordinator";
import { removeOldRuntimeCopies, UpdateStateStore } from "./update-state";

guardDesktopProcessOutput();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let nativeLocale: I18nRuntime;
let bootGate: BootGate;
let startupFailed = false;
let runtime: DaemonRuntime | null = null;
let profile: DaemonProfile | null = null;
let session: DaemonSession | null = null;
let cli: DaemonCli | null = null;
let migrationRun: Promise<unknown> | null = null;
let quitting = false;
let updateStore: UpdateStateStore;
let updater: UpdateCoordinator;

const userDataOverride = process.env.MDBASE_CONNECT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", resolve(userDataOverride));

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

autoUpdater.on("before-quit-for-update", () => {
  quitting = true;
});

async function openLocalPath(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) throw new Error(t(i18n)`The folder or file could not be opened. ${error}`);
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
  computer_name?: string;
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
  if (!current.signed_in || !current.server) throw new Error(t(i18n)({ message: "Sign in to mdbase on this computer first.", context: "Desktop application" }));
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
  session = new DaemonSession({
    profile,
    bundled: runtime,
    cli,
    ensureInstalled: () => ensureBundledDaemon(runtime!, profile!)
  });
  let oldRuntimeCopiesRemoved = false;
  session.subscribe((state) => {
    if (state.phase === "ready" && !oldRuntimeCopiesRemoved) {
      oldRuntimeCopiesRemoved = true;
      removeOldRuntimeCopies(app.getPath("userData"))
        .catch((error) => console.warn("Could not remove the old connector's runtime copies:", error));
    }
    refreshTrayMenu();
    mainWindow?.webContents.send("connect:daemon-state", state);
  });
}

/**
 * The installed service runs the daemon this app bundles (the app update delivers
 * it). A bundled version that does not become ready is rolled back to the previous
 * copy and held back until a later app update brings another version.
 */
async function ensureBundledDaemon(bundled: DaemonRuntime, current: DaemonProfile): Promise<void> {
  const held = (await updateStore.load()).daemon_held_back;
  const previous = previousRuntimeBinary(current.stateDir);
  const result = await ensureNextDaemon(nextDaemonRunner(bundled.binary), bundled.version, {
    heldBack: held?.version,
    rollback: existsSync(previous) ? nextDaemonRunner(previous) : null
  });
  if (result.outcome === "rolled_back") {
    await updateStore.update((state) => {
      state.daemon_held_back = { version: result.failed, reason: result.reason };
    });
  } else if (held && result.version === bundled.version) {
    await updateStore.update((state) => {
      delete state.daemon_held_back;
    });
  }
  const holding = result.outcome === "rolled_back" ||
    (held?.version === bundled.version && result.version !== bundled.version);
  updater.setDaemonNotice(holding
    ? msg`mdbase ${bundled.version} did not start on this computer, so mdbase ${result.version} keeps running. The next app update tries again.`
    : null);
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

async function chooseFolder(title = t(i18n)({ message: "Choose a collection folder", context: "Desktop application" })): Promise<string | null> {
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
  ipcMain.handle("connect:locale:get", (event) => {
    trustedIpc(event);
    return i18n.locale;
  });
  ipcMain.handle("connect:locale:set", async (event, locale: unknown) => {
    trustedIpc(event);
    if (!isLocale(locale)) throw new Error("Unsupported locale.");
    await nativeLocale.selectLocale(locale);
    refreshTrayMenu();
    mainWindow?.webContents.send("connect:update-status", updater.status());
  });
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
    return updater.status();
  });
  ipcMain.handle("connect:updates:check", async (event) => {
    trustedIpc(event);
    return bootGate.check(() => updater.check(true));
  });
  ipcMain.handle("connect:updates:install", async (event) => {
    trustedIpc(event);
    return bootGate.install(() => updater.install());
  });
  ipcMain.handle("connect:collections:list", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("collection.list");
  });
  ipcMain.handle("connect:collections:add", async (event) => {
    trustedIpc(event);
    const path = await chooseFolder(t(i18n)({ message: "Choose a folder to add", context: "Desktop application" }));
    if (!path) return null;
    return requestReadyAgent("collection.add", { path }, 60_000);
  });
  ipcMain.handle("connect:collections:choose-create", async (event) => {
    trustedIpc(event);
    return chooseFolder(t(i18n)({ message: "Choose where to create the collection folder", context: "Desktop application" }));
  });
  // A new collection is a new, empty folder registered as a local collection.
  ipcMain.handle("connect:collections:create", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection input.");
    const name = collectionName(value.name);
    if (typeof value.parent !== "string" || !value.parent) throw new Error(t(i18n)({ message: "Choose where to create the folder.", context: "Desktop application" }));
    const folder = join(resolve(value.parent), folderName(name));
    try {
      await mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(t(i18n)`A folder named "${folderName(name)}" already exists there. Choose another name or use Add existing.`);
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
  ipcMain.handle("connect:collections:update", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection input.");
    const params: Record<string, string> = { collection: collectionIdOf(value.collectionId) };
    for (const key of ["name", "description"] as const) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== "string") throw new Error("Invalid collection input.");
      params[key] = value[key] as string;
    }
    return requestReadyAgent("collection.update", params);
  });
  // Privileged (it moves the log to mdbase): through the CLI.
  ipcMain.handle("connect:collections:sync-enable", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid sync input.");
    const mode = value.mode;
    if (mode !== "private" && mode !== "cloud-copy") throw new Error(t(i18n)({ message: "Choose how to sync.", context: "Desktop application" }));
    if (typeof value.acceptTakeoverHolds !== "boolean") throw new Error("Invalid sync input.");
    // A folder with files (for example a taken-over one) is adopted as the first
    // version. Files held at takeover are accepted only after the user has seen them.
    return bootGate.request(() => daemonCli().run([
      "sync", "enable", collectionIdOf(value.collectionId), "--mode", mode,
      ...(value.acceptTakeoverHolds ? ["--accept-takeover-holds"] : [])
    ], 600_000));
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
      lastError: current.last_error ?? null,
      computerName: current.computer_name ?? null
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
  ipcMain.handle("connect:account:rename", async (event, name: unknown) => {
    trustedIpc(event);
    if (typeof name !== "string") throw new Error(t(i18n)({ message: "Enter a name for this computer.", context: "Desktop application" }));
    return requestReadyAgent("account.rename", { name }, 30_000);
  });
  ipcMain.handle("connect:activity:list", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("activity.list", { limit: 100 });
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
  // New computers asking to open a Private collection. Listing reveals their
  // six-digit codes and approving hands over the collection key, so both are
  // privileged and go through the CLI; declining only narrows access.
  ipcMain.handle("connect:devices:pending", async (event) => {
    trustedIpc(event);
    return pendingDevices();
  });
  ipcMain.handle("connect:devices:approve", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid approval.");
    const code = typeof value.code === "string" ? value.code.replace(/\s/gu, "") : "";
    if (!/^\d{6}$/u.test(code)) throw new Error(t(i18n)({ message: "The code is six digits.", context: "Desktop application" }));
    pendingDeviceCache = null;
    return bootGate.request(() => daemonCli().run([
      "device", "approve", collectionIdOf(value.collectionId), deviceIdOf(value.device), "--code", code
    ], 120_000));
  });
  ipcMain.handle("connect:devices:reject", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid request.");
    pendingDeviceCache = null;
    return requestReadyAgent("device.reject", {
      collection: collectionIdOf(value.collectionId),
      device: deviceIdOf(value.device)
    }, 30_000);
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

function deviceIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z_-]{1,128}$/u.test(value)) throw new Error("Invalid device ID.");
  return value;
}

interface PendingDeviceEntry { collection: string; device: string; account: string; kind: string; code: string }

/** Each `device pending` call spawns the CLI, so the renderer's poll is served from a short cache. */
const PENDING_DEVICE_TTL_MS = 20_000;
let pendingDeviceCache: { at: number; value: Promise<PendingDeviceEntry[]> } | null = null;

function pendingDevices(): Promise<PendingDeviceEntry[]> {
  if (pendingDeviceCache && Date.now() - pendingDeviceCache.at < PENDING_DEVICE_TTL_MS) return pendingDeviceCache.value;
  const value = (async () => {
    const collections = await requestReadyAgent<Array<{ id: string; mode: string; state: string }>>("collection.list");
    const lists = await Promise.all(collections
      .filter((collection) => collection.mode === "synced_e2e" && collection.state === "ready")
      .map(async (collection) => {
        try {
          const devices = await bootGate.request(() => daemonCli().run<Array<Omit<PendingDeviceEntry, "collection">>>(
            ["device", "pending", collection.id], 15_000
          ));
          return devices.map((device) => ({ ...device, collection: collection.id }));
        } catch (error) {
          // A daemon without device approval yet has nothing to show.
          if (error instanceof DaemonControlError && error.reason === "not_implemented") return [];
          throw error;
        }
      }));
    return lists.flat();
  })();
  pendingDeviceCache = { at: Date.now(), value };
  value.catch(() => { if (pendingDeviceCache?.value === value) pendingDeviceCache = null; });
  return value;
}

function grantIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{32,36}$/iu.test(value)) throw new Error("Invalid grant ID.");
  return value;
}

function collectionName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || [...name].length > 100) throw new Error(t(i18n)({ message: "Collection name must be between 1 and 100 characters.", context: "Desktop application" }));
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
  // Also refresh when this app attaches to an already-running daemon.
  mainWindow.on("focus", () => {
    void requestReadyAgent("migrate.status", { refresh_rollout: true }).catch(() => {});
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
  const update = updater?.status();
  const updateReady = update?.can_install === true;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t(i18n)({ message: "Show mdbase connect", context: "Desktop application" }), click: () => mainWindow?.show() },
      { type: "separator" },
      { label: startupFailed ? t(i18n)`mdbase needs attention` : healthLabel(session?.current ?? { phase: "starting" }), enabled: false },
      {
        label: updateReady
          ? update?.phase === "ready"
            ? t(i18n)`Install ${update.target_version}`
            : update?.target_version ? t(i18n)`Open ${update.target_version}` : t(i18n)`Open update`
          : t(i18n)({ message: "Check for updates", context: "Desktop application" }),
        enabled: update?.can_check === true || updateReady,
        click: () => {
          if (updateReady) {
            void bootGate.install(() => updater.install()).catch((error) => {
              dialog.showErrorBox(
                t(i18n)({ message: "mdbase connect could not install the update", context: "Desktop application" }),
                error instanceof Error ? error.message : String(error)
              );
            });
          } else {
            void bootGate.check(() => updater.check(true))
              .catch((error) => dialog.showErrorBox(t(i18n)({ message: "Could not check for updates", context: "Desktop application" }), String(error)));
          }
        }
      },
      { type: "separator" },
      {
        label: t(i18n)({ message: "Quit mdbase connect", context: "Desktop application" }),
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

app.whenReady().then(async () => {
  nativeLocale = createNativeLocale(app.getPath("userData"), app.getPreferredSystemLanguages());
  try { await nativeLocale.initialize(); }
  catch (error) { dialog.showErrorBox(t(i18n)`The language could not be loaded. Choose it again in Settings.`, String(error)); }
  app.on("web-contents-created", (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  });
  registerDeepLinks();
  // The updater works even when the daemon does not: an app update is how a broken
  // daemon gets fixed.
  updateStore = new UpdateStateStore(join(app.getPath("userData"), "updates", "state.json"));
  updater = new UpdateCoordinator(updateStore, new ElectronUpdateBackend({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    userDataDirectory: app.getPath("userData")
  }));
  updater.subscribe((status) => {
    mainWindow?.webContents.send("connect:update-status", status);
    refreshTrayMenu();
  });
  try {
    await initializeDaemon();
  } catch (error) {
    dialog.showErrorBox(
      t(i18n)({ message: "mdbase connect could not initialize", context: "Desktop application" }),
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
    return;
  }
  bootGate = new BootGate({
    initialize: async () => { await updater.initialize(); },
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
    void requestReadyAgent("migrate.status", { refresh_rollout: true }).catch(() => {});
  } catch (error) {
    startupFailed = true;
    refreshTrayMenu();
    dialog.showErrorBox(
      t(i18n)({ message: "mdbase connect could not start", context: "Desktop application" }),
      error instanceof Error ? error.message : String(error)
    );
  }
  const initialUpdateCheck = setTimeout(() => void bootGate.check(() => updater.check(false)).catch(() => undefined), 30_000);
  initialUpdateCheck.unref();
  const updateChecks = setInterval(() => void bootGate.check(() => updater.check(false)).catch(() => undefined), 6 * 60 * 60 * 1000);
  updateChecks.unref();
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

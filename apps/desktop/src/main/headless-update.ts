import { app } from "electron";
import { join } from "node:path";
import { claimBackgroundUpdate, registerUpdateTimer, releaseBackgroundUpdate } from "./background-update";
import { DaemonCli } from "./daemon-cli";
import { resolveDaemonRuntime } from "./daemon-runtime";
import { appUpdateBackend } from "./electron-update-backend";
import { createNativeLocale } from "./i18n";
import { ensureBundledDaemon } from "./next-daemon";
import { UpdateCoordinator, type DesktopUpdateStatus } from "./update-coordinator";
import { reportUpdates } from "./update-report";
import { UpdateStateStore } from "./update-state";

/**
 * `mdbase-connect --mdbase-update`: the app's update, without a window. The
 * systemd timer (`background-update.ts`) and the Linux install script run it.
 *
 * 1. If the app is running it owns its folder: the app is asked to check (its
 *    `second-instance` handler) and this run ends.
 * 2. Otherwise the signed channel is checked exactly as the app checks it (staged
 *    rollout applies), and a verified release is staged and, for an app in a
 *    folder the user owns, swapped in. A launch meanwhile waits for this run and
 *    then starts the new app (`background-update.ts`).
 * 3. The daemon this app now bundles is installed, as a launch installs it.
 * 4. The timer is written again for this app, and `mdbase doctor` is told what
 *    the check found (`update-report.ts`).
 *
 * Exits 1 when the check, the install or the daemon failed, so the failure shows
 * in `systemctl --user status mdbase-connect-update`.
 */

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

export async function runBackgroundUpdate(): Promise<number> {
  const userData = app.getPath("userData");
  // Claimed before the lock is taken, so a launch in between waits rather than
  // losing the race for the lock.
  await claimBackgroundUpdate(userData);
  try {
    if (!app.requestSingleInstanceLock()) {
      log("mdbase connect is running and checks for updates itself.");
      return 0;
    }
    return await update(userData);
  } finally {
    await releaseBackgroundUpdate(userData);
  }
}

async function update(userData: string): Promise<number> {
  await app.whenReady();
  if (!app.isPackaged) {
    log("Updates are available in installed builds.");
    return 0;
  }
  await createNativeLocale(userData, app.getPreferredSystemLanguages()).initialize()
    .catch((error) => log(`The language could not be loaded: ${String(error)}`));
  const store = new UpdateStateStore(join(userData, "updates", "state.json"));
  const backend = appUpdateBackend("return");
  const updater = new UpdateCoordinator(store, backend);
  await updater.initialize();
  let status: DesktopUpdateStatus = await updater.check(false);
  log(status.message);
  let failed = status.phase === "failed";
  if (status.phase === "ready" && backend.linuxAppDirectory) {
    try {
      await updater.install();
      log(`Installed mdbase connect ${status.target_version}.`);
      // This process still runs the replaced app; the folder now holds the new one.
      status = { ...status, phase: "idle", current_version: status.target_version! };
    } catch (error) {
      log(updater.status().message);
      failed = true;
    }
  }

  // The bundled daemon of the app now in the folder (the new one after an update).
  let stateDir: string | null = null;
  try {
    const runtime = await resolveDaemonRuntime({
      packaged: true,
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      env: process.env
    });
    stateDir = (await DaemonCli.discover(runtime.binary, null)).stateDir;
    const { result, holding } = await ensureBundledDaemon(store, runtime, stateDir);
    log(holding
      ? `mdbase ${runtime.version} did not start on this computer, so mdbase ${result.version} keeps running.`
      : `mdbase ${result.version} is installed.`);
  } catch (error) {
    log(`The mdbase daemon was not updated: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }

  let background = false;
  if (backend.linuxAppDirectory) {
    try {
      await registerUpdateTimer(process.execPath, app.getPath("appData"));
      background = true;
    } catch (error) {
      log(`Background updates could not be registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (stateDir && ["idle", "deferred", "ready", "external"].includes(status.phase)) {
    await reportUpdates(stateDir, status, background)
      .catch((error) => log(`Could not record the update check for mdbase doctor: ${String(error)}`));
  }
  return failed ? 1 : 0;
}

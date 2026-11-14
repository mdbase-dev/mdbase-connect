import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UPDATE_SWITCH } from "./display-platform";

/**
 * Background updates (`headless-update.ts` runs them) for a Linux app the user unpacked into a folder they own
 * (`linux-update.ts`). A systemd user timer runs `mdbase-connect --mdbase-update`
 * (`headless-update.ts`) every six hours, so the app and its daemon stay current
 * whether or not anyone opens the app, and on desktops that never start it at
 * login. The app writes the units at each launch and each background run, so
 * they always name the current app; a folder that is gone skips the run.
 *
 * `KillMode=mixed`: stopping Electron by signalling every process in the unit at
 * once crashes it (SIGTRAP), so systemd signals only the main process first.
 */

export const UPDATE_UNIT = "mdbase-connect-update";

export interface UpdateUnits {
  service: string;
  timer: string;
}

/** `"…"` with systemd's escapes for `\`, `"`, `$` and `%` (as `service/templates.rs`). */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/gu, "\\$&").replaceAll("$", "$$$$").replaceAll("%", "%%")}"`;
}

export function updateUnits(executable: string): UpdateUnits {
  if (/[\n\r]/u.test(executable)) throw new Error("The app's path cannot be written to a systemd unit.");
  const header = "# Written by mdbase connect. Changes are overwritten when the app starts.\n";
  return {
    service: `${header}[Unit]
Description=Update mdbase connect and its mdbase daemon
Documentation=https://mdbase.dev
ConditionPathExists=${executable.replaceAll("%", "%%")}

[Service]
Type=oneshot
ExecStart=${quote(executable)} ${UPDATE_SWITCH}
KillMode=mixed
TimeoutStartSec=30min
Nice=10
`,
    timer: `${header}[Unit]
Description=Check for mdbase connect updates

[Timer]
OnCalendar=*-*-* 00/6:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`
  };
}

export type Systemctl = (args: string[]) => Promise<void>;

const systemctl: Systemctl = (args) => new Promise((resolve, reject) => {
  execFile("systemctl", ["--user", ...args], { timeout: 30_000 }, (error, _stdout, stderr) => {
    if (!error) resolve();
    else reject(new Error(`systemctl --user ${args.join(" ")} failed: ${String(stderr).trim() || error.message}`));
  });
});

/**
 * Writes the units into `<configHome>/systemd/user` when they differ, and makes
 * sure the timer is enabled and running.
 */
export async function registerUpdateTimer(
  executable: string,
  configHome: string,
  run: Systemctl = systemctl
): Promise<void> {
  const directory = join(configHome, "systemd", "user");
  const units = updateUnits(executable);
  let changed = false;
  await mkdir(directory, { recursive: true });
  for (const [suffix, content] of [["service", units.service], ["timer", units.timer]] as const) {
    const path = join(directory, `${UPDATE_UNIT}.${suffix}`);
    if (await readFile(path, "utf8").catch(() => null) === content) continue;
    await writeFile(path, content, { mode: 0o644 });
    changed = true;
  }
  if (changed) await run(["daemon-reload"]);
  await run(["enable", "--now", `${UPDATE_UNIT}.timer`]);
}

/**
 * While a background update runs it holds the app's single-instance lock and may
 * replace the app's folder, so a launch then waits for it and starts the app that
 * is there afterwards (`entry.ts`). The run's PID in `<userData>/updates` tells
 * a launch that one runs; a launch reads it before taking the lock.
 */
function markerPath(userData: string): string {
  return join(userData, "updates", "background-update.pid");
}

export async function claimBackgroundUpdate(userData: string, pid = process.pid): Promise<void> {
  const path = markerPath(userData);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${pid}\n`, { mode: 0o600 });
}

/** Removes the marker unless a later run has replaced it. */
export async function releaseBackgroundUpdate(userData: string, pid = process.pid): Promise<void> {
  const path = markerPath(userData);
  if ((await readFile(path, "utf8").catch(() => "")).trim() === String(pid)) await rm(path, { force: true });
}

/** The running background update's PID, if one runs (Linux: it reads `/proc`). */
export function runningBackgroundUpdate(userData: string, proc = "/proc"): number | null {
  try {
    const pid = Number(readFileSync(markerPath(userData), "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    // A stale marker whose PID now belongs to another process is not a run.
    return readFileSync(join(proc, String(pid), "cmdline"), "utf8").split("\0").includes(UPDATE_SWITCH) ? pid : null;
  } catch {
    return null;
  }
}

/** Resolves when the process has exited, or after `limitMs`. */
export function waitForExit(pid: number, limitMs = 30 * 60_000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + limitMs;
  return new Promise((resolve) => {
    const poll = () => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve();
        return;
      }
      if (Date.now() >= deadline) resolve();
      else setTimeout(poll, intervalMs);
    };
    poll();
  });
}

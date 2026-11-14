import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopUpdateStatus } from "./update-coordinator";

/**
 * What the app last learned about updates, for `mdbase doctor`.
 *
 * The app update delivers the daemon, so the daemon cannot know by itself whether
 * a newer release exists. After each successful check the app writes this report
 * to `<daemon state>/updates/desktop.json`, a directory the daemon leaves to
 * packaging (`runtime/crates/daemon/src/service/mod.rs`), and the daemon's `update`
 * check reads it (`runtime/crates/daemon/src/update/desktop.rs`). Schema 1; the
 * daemon ignores fields it does not know.
 */
export interface DesktopUpdateReport {
  schema_version: 1;
  app_version: string;
  checked_at: string;
  /** A systemd timer installs updates while the app is closed (`background-update.ts`). */
  background: boolean;
  /** A newer release this installation can install now. */
  available?: {
    version: string;
    /** `restart`: in the app (and in the background, when `background`); otherwise outside it. */
    install: "restart" | "package" | "store";
    release_url?: string;
    required?: true;
  };
}

export function updateReport(
  status: DesktopUpdateStatus,
  options: { background: boolean; store: boolean }
): DesktopUpdateReport | null {
  if (!status.checked_at) return null;
  const report: DesktopUpdateReport = {
    schema_version: 1,
    app_version: status.current_version,
    checked_at: status.checked_at,
    background: options.background
  };
  if ((status.phase === "ready" || status.phase === "external") && status.target_version) {
    report.available = {
      version: status.target_version,
      install: status.phase === "ready" ? "restart" : options.store ? "store" : "package",
      ...(status.release_url ? { release_url: status.release_url } : {}),
      ...(status.required ? { required: true as const } : {})
    };
  }
  return report;
}

export function updateReportPath(daemonStateDir: string): string {
  return join(daemonStateDir, "updates", "desktop.json");
}

export async function writeUpdateReport(daemonStateDir: string, report: DesktopUpdateReport): Promise<void> {
  const path = updateReportPath(daemonStateDir);
  await mkdir(join(daemonStateDir, "updates"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Records what a finished check found (the caller passes only finished checks). */
export async function reportUpdates(daemonStateDir: string, status: DesktopUpdateStatus, background: boolean): Promise<void> {
  const report = updateReport(status, { background, store: process.windowsStore === true });
  if (report) await writeUpdateReport(daemonStateDir, report);
}

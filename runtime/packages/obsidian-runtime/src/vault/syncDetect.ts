/**
 * Foreign sync-tool detection. Only what the host can see; marker files
 * inside the collection are also detected portably by the store.
 *
 * Signals never block. The store lengthens its quiet-period gate and holds
 * closed-file publishes to paths another tool changed recently.
 */

import type { ObsApp } from "./obsidianApi.js";
import type { ForeignSyncSignal, PlatformEnvironment } from "./types.js";

/** Community plugins that sync the vault. */
export const SYNC_PLUGINS: Readonly<Record<string, string>> = {
  "obsidian-livesync": "Self-hosted LiveSync",
  "remotely-save": "Remotely Save",
  "obsidian-git": "Obsidian Git",
  "remotely-sync": "Remotely Sync",
  "obsidian-dropbox-sync": "Dropbox sync plugin",
  "syncthing-integration": "Syncthing integration",
  fit: "FIT (GitHub sync)",
};

const PATH_PATTERNS: readonly [RegExp, string][] = [
  [/[\\/]Dropbox([\\/]|$)/i, "Dropbox"],
  [/[\\/]OneDrive( - [^\\/]+)?([\\/]|$)/i, "OneDrive"],
  [/[\\/](Google Drive|GoogleDrive|My Drive)([\\/]|$)/i, "Google Drive"],
  [/[\\/](Mobile Documents|iCloud Drive|iCloud~md~obsidian)([\\/]|$)/i, "iCloud Drive"],
  [/[\\/]pCloud ?Drive([\\/]|$)/i, "pCloud"],
  [/[\\/]Nextcloud([\\/]|$)/i, "Nextcloud"],
  [/[\\/]Sync\.com([\\/]|$)/, "Sync.com"],
];

const ROOT_MARKERS: readonly [RegExp, string][] = [
  [/^\.stfolder$|^\.stignore$|^\.stversions$/, "Syncthing"],
  [/\.sync-conflict-\d{8}-\d{6}/, "Syncthing"],
  [/^\.dropbox$|\(conflicted copy\)|\(Case Conflict\)/, "Dropbox"],
  [/^\.git$/, "Git"],
];

/** Gather signals. `rootNames` are the entry names at the vault root (and collection root). */
export function detectForeignSync(app: ObsApp, basePath: string | null, rootNames: readonly string[]): PlatformEnvironment {
  const signals: ForeignSyncSignal[] = [];
  const seen = new Set<string>();
  const add = (s: ForeignSyncSignal) => {
    const k = `${s.tool}|${s.strength}`;
    if (!seen.has(k)) {
      seen.add(k);
      signals.push(s);
    }
  };
  // Obsidian Sync: `enabled` alone is true by default in fresh vaults;
  // only a configured remote vault counts.
  try {
    const sync = app.internalPlugins?.getPluginById?.("sync");
    if (sync?.enabled && sync.instance?.vaultId) add({ tool: "Obsidian Sync", strength: "Strong", evidence: "core Sync plugin enabled with a remote vault" });
  } catch {
    /* private API changed: no signal */
  }
  try {
    for (const id of app.plugins?.enabledPlugins ?? []) {
      const name = SYNC_PLUGINS[id];
      if (name) add({ tool: name, strength: "Strong", evidence: `community plugin ${id} enabled` });
    }
  } catch {
    /* ignore */
  }
  if (basePath) {
    for (const [re, tool] of PATH_PATTERNS) if (re.test(basePath)) add({ tool, strength: "Medium", evidence: `vault path ${basePath}` });
  }
  for (const name of rootNames) {
    for (const [re, tool] of ROOT_MARKERS) {
      if (re.test(name)) add({ tool, strength: name.startsWith(".") ? "Strong" : "Medium", evidence: `found ${name}` });
    }
  }
  return { rootDisplay: basePath, signals };
}

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bridge-release handoff to the mdbase-next daemon.
 *
 * The new daemon takes over each local collection (mdbase-next
 * `takeover::take_over`, steps T0-T6): it stops and disables this app's
 * daemon, holds its `daemon.lock`, and finally writes a version 2 claim to the
 * folder's `.mdbase/connect-role.json`. Once any folder is claimed, the old
 * daemon must stay stopped: restarting it would postpone every remaining
 * takeover (T1 needs `daemon.lock`) and put two daemons over the same machine.
 */

/** A folder role marker, read the way every released connector reads it. */
export type RoleMarker =
  | { kind: "absent" }
  | { kind: "mirror" }
  | { kind: "claimed"; runtime: string | null }
  | { kind: "unreadable" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Classify marker bytes exactly as mdbase-next does (`mdbn_legacy::marker::parse`,
 * the reader `takeover::write_v2_marker` checks its own output against): a claim is
 * `version` 2, `role` "replica", UUID `collection` and `replica_id`, and no
 * `collection_id`.
 */
export function classifyRoleMarker(bytes: Buffer | string): RoleMarker {
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
  } catch {
    return { kind: "unreadable" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unreadable" };
  const marker = value as Record<string, unknown>;
  const uuid = (key: string) => typeof marker[key] === "string" && UUID.test(marker[key] as string);
  if (marker.version === 1 && marker.role === "mirror" && uuid("collection_id")) {
    return { kind: "mirror" };
  }
  if (
    marker.version === 2 && marker.role === "replica" && !("collection_id" in marker) &&
    uuid("collection") && uuid("replica_id")
  ) {
    return { kind: "claimed", runtime: typeof marker.runtime === "string" ? marker.runtime : null };
  }
  return { kind: "unreadable" };
}

export async function readRoleMarker(folder: string): Promise<RoleMarker> {
  const path = join(folder, ".mdbase", "connect-role.json");
  try {
    // Never follow a link: a claim is an ordinary file in an ordinary folder.
    const details = await lstat(path);
    if (!details.isFile()) return { kind: "unreadable" };
    return classifyRoleMarker(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable" };
  }
}

/**
 * How far the new daemon's takeover has gone, as this app must act on it:
 * - `none`: no takeover (or rolled back); behave as before;
 * - `postponed`: keep today's behaviour, but never start an old daemon that is
 *   stopped (the takeover stopped it and will retry);
 * - `started` / `complete`: never install, restart or re-enable the old daemon.
 */
export type TakeoverPhase = "none" | "postponed" | "started" | "complete";

export interface TakeoverState {
  state: TakeoverPhase;
  /** Registered folders that carry the new daemon's claim. */
  claimedFolders: string[];
}

export interface TakeoverSources {
  /** The new daemon's `takeover.json`, already checked; null when absent. */
  takeoverRecord(): Promise<TakeoverRecord | null>;
  /** Folders the old daemon registered, read without starting it. */
  registeredFolders(): Promise<string[]>;
  readMarker?(folder: string): Promise<RoleMarker>;
}

/**
 * Combine the machine-level record with the folder claims. A claimed folder
 * means the takeover has at least started, whatever the record says.
 */
export async function detectTakeover(sources: TakeoverSources): Promise<TakeoverState> {
  const readMarker = sources.readMarker ?? readRoleMarker;
  const record = await sources.takeoverRecord();
  const claimedFolders: string[] = [];
  for (const folder of await sources.registeredFolders()) {
    if ((await readMarker(folder)).kind === "claimed") claimedFolders.push(folder);
  }
  const recorded: TakeoverPhase =
    record?.state === "started" || record?.state === "complete" || record?.state === "postponed"
      ? record.state
      : "none";
  if (claimedFolders.length > 0 && (recorded === "none" || recorded === "postponed")) {
    return { state: "started", claimedFolders };
  }
  return { state: recorded, claimedFolders };
}

/** Whether the old daemon must never be installed, restarted or re-enabled. */
export function takeoverOwnsDaemon(state: TakeoverPhase | "unknown"): boolean {
  return state === "started" || state === "complete";
}

export interface TakeoverRecord {
  state: "started" | "complete" | "postponed" | "rolled_back";
  updated_at?: string;
}

/** The new daemon's installed-profile state directory (packaging interface §3). */
export function newDaemonStateDirectory(
  platform: NodeJS.Platform,
  home: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "mdbase");
  if (platform === "win32") {
    const local = environment.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA is not set.");
    return join(local, "mdbase", "state");
  }
  return join(home, ".local", "state", "mdbase");
}

/**
 * Read `<new state>/takeover.json` with the daemon.json checks: an ordinary
 * file (never a link), owned by this user, writable by no one else. A file
 * that fails a check is an error, not "no takeover": the caller then refuses
 * to start the old daemon rather than guess.
 */
export async function readTakeoverRecord(
  stateDirectory: string,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.()
): Promise<TakeoverRecord | null> {
  const path = join(stateDirectory, "takeover.json");
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile()) throw new Error("The mdbase takeover record is not an ordinary file.");
  if (platform !== "win32") {
    if (uid !== undefined && details.uid !== uid) {
      throw new Error("The mdbase takeover record is owned by another user.");
    }
    if ((details.mode & 0o022) !== 0) {
      throw new Error("The mdbase takeover record is writable by other users.");
    }
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The mdbase takeover record is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) {
    // A newer schema still means the new daemon owns the machine's takeover.
    return { state: "started" };
  }
  if (!["started", "complete", "postponed", "rolled_back"].includes(record.state as string)) {
    throw new Error("The mdbase takeover record has an unknown state.");
  }
  return {
    state: record.state as TakeoverRecord["state"],
    ...(typeof record.updated_at === "string" ? { updated_at: record.updated_at } : {})
  };
}

/** Folders registered in the old connector's registry, read-only. */
export async function registeredFoldersFromRegistry(stateDirectory: string): Promise<string[]> {
  const path = join(stateDirectory, "connector.sqlite");
  try {
    await lstat(path);
  } catch {
    return [];
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("SELECT path FROM collections").all() as Array<{ path?: unknown }>;
    return rows.flatMap((row) => (typeof row.path === "string" ? [row.path] : []));
  } finally {
    database.close();
  }
}

export const TAKEOVER_STARTED_MESSAGE =
  "mdbase is taking over your collections. This app no longer starts the old connector.";
export const TAKEOVER_COMPLETE_MESSAGE =
  "mdbase now runs your collections. Open the new mdbase app to manage them; this app no longer starts the old connector or opens at login.";

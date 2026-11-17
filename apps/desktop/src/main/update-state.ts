import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareVersions, TAG_PATTERN } from "./update-policy";

/**
 * What the app updater remembers between launches (`<userData>/updates/state.json`).
 *
 * Files written by apps that still managed the old connector can also hold
 * `transaction` and `last_known_good_runtime`. Those described the old connector's
 * runtime handoff, which the mdbase daemon's takeover now owns, so they are dropped on
 * read and the installation ID and trusted version are kept.
 */
export interface PersistedUpdateState {
  schema_version: 1;
  installation_id: string;
  highest_trusted_version?: string;
  last_checked_at?: string;
  /** A bundled daemon version that did not become ready and was rolled back. */
  daemon_held_back?: {
    version: string;
    reason: string;
  };
  /** The user opted in to early access: take each release at its first stage. */
  early_access?: boolean;
  /** The app version this installation runs, and since when (update spacing). */
  current_version?: {
    version: string;
    since: string;
  };
  /**
   * The newest rollout document time seen per release tag. A document older than
   * one already seen is refused, so a replayed one cannot narrow or reopen a stage.
   */
  rollout_seen?: Record<string, string>;
}

/** Rollout times are kept for this many of the newest release tags. */
export const ROLLOUT_SEEN_LIMIT = 16;

/**
 * Apps that managed the old connector kept rollback copies of its binary in
 * `<userData>/updates/runtimes`. Nothing runs from there once the mdbase daemon has
 * taken over and is ready, so the copies are removed then.
 */
export async function removeOldRuntimeCopies(userDataDirectory: string): Promise<void> {
  await rm(join(userDataDirectory, "updates", "runtimes"), { recursive: true, force: true });
}

export class UpdateStateStore {
  readonly path: string;
  private state: PersistedUpdateState | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<PersistedUpdateState> {
    if (this.state) return structuredClone(this.state);
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      this.state = parsePersistedState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const quarantine = `${this.path}.invalid-${Date.now()}`;
        await rename(this.path, quarantine).catch(() => undefined);
      }
      this.state = freshState();
      await this.write();
    }
    return structuredClone(this.state);
  }

  async update(
    change: (current: PersistedUpdateState) => PersistedUpdateState | void
  ): Promise<PersistedUpdateState> {
    const current = await this.load();
    const next = change(current) ?? current;
    const validated = parsePersistedState(next);
    await this.write(validated);
    this.state = validated;
    return structuredClone(validated);
  }

  private async write(state = this.state): Promise<void> {
    if (!state) throw new Error("Update state has not been initialized.");
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700).catch(() => undefined);
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    try {
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function parsePersistedState(value: unknown): PersistedUpdateState {
  const state = record(value, "Update state");
  if (state.schema_version !== 1 || typeof state.installation_id !== "string" || !state.installation_id) {
    throw new Error("Update state is invalid.");
  }
  const parsed: PersistedUpdateState = {
    schema_version: 1,
    installation_id: state.installation_id
  };
  if (state.highest_trusted_version !== undefined) {
    if (typeof state.highest_trusted_version !== "string") throw new Error("Trusted version is invalid.");
    compareVersions(state.highest_trusted_version, state.highest_trusted_version);
    parsed.highest_trusted_version = state.highest_trusted_version;
  }
  if (state.last_checked_at !== undefined) {
    if (typeof state.last_checked_at !== "string" || !Number.isFinite(Date.parse(state.last_checked_at))) {
      throw new Error("Last update check time is invalid.");
    }
    parsed.last_checked_at = new Date(state.last_checked_at).toISOString();
  }
  if (state.daemon_held_back !== undefined) {
    const held = record(state.daemon_held_back, "Held-back daemon");
    if (typeof held.version !== "string" || typeof held.reason !== "string") {
      throw new Error("Held-back daemon is invalid.");
    }
    compareVersions(held.version, held.version);
    parsed.daemon_held_back = { version: held.version, reason: held.reason };
  }
  if (state.early_access !== undefined) {
    if (typeof state.early_access !== "boolean") throw new Error("Early access setting is invalid.");
    parsed.early_access = state.early_access;
  }
  if (state.current_version !== undefined) {
    const current = record(state.current_version, "Current version");
    if (
      typeof current.version !== "string" ||
      typeof current.since !== "string" ||
      !Number.isFinite(Date.parse(current.since))
    ) {
      throw new Error("Current version is invalid.");
    }
    compareVersions(current.version, current.version);
    parsed.current_version = { version: current.version, since: new Date(current.since).toISOString() };
  }
  if (state.rollout_seen !== undefined) {
    const seen = record(state.rollout_seen, "Rollout times");
    const entries = Object.entries(seen).map(([tag, issuedAt]) => {
      if (!TAG_PATTERN.test(tag) || typeof issuedAt !== "string" || !Number.isFinite(Date.parse(issuedAt))) {
        throw new Error("Rollout times are invalid.");
      }
      return [tag, new Date(issuedAt).toISOString()] as const;
    });
    entries.sort(([left], [right]) => compareVersions(right.slice(1), left.slice(1)));
    parsed.rollout_seen = Object.fromEntries(entries.slice(0, ROLLOUT_SEEN_LIMIT));
  }
  return parsed;
}

function freshState(): PersistedUpdateState {
  return {
    schema_version: 1,
    installation_id: randomUUID()
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

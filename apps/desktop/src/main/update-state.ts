import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareVersions } from "./update-policy";

export interface UpdateTransaction {
  id: string;
  phase: "prepared" | "installing" | "recovering";
  target_version: string;
  previous_version: string;
  service_installed: boolean;
  previous_runtime: string | null;
  started_at: string;
  error?: string;
}

export interface PersistedUpdateState {
  schema_version: 1;
  installation_id: string;
  highest_trusted_version?: string;
  last_checked_at?: string;
  last_known_good_runtime?: {
    version: string;
    path: string;
  };
  transaction?: UpdateTransaction;
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
    this.state = parsePersistedState(next);
    await this.write();
    return structuredClone(this.state);
  }

  async remove(): Promise<void> {
    this.state = null;
    await rm(this.path, { force: true });
  }

  private async write(): Promise<void> {
    if (!this.state) throw new Error("Update state has not been initialized.");
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700).catch(() => undefined);
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Update state must be an object.");
  }
  const state = value as Record<string, unknown>;
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
  if (state.last_known_good_runtime !== undefined) {
    const runtime = record(state.last_known_good_runtime, "Last-known-good runtime");
    if (typeof runtime.version !== "string" || typeof runtime.path !== "string" || !runtime.path) {
      throw new Error("Last-known-good runtime is invalid.");
    }
    compareVersions(runtime.version, runtime.version);
    parsed.last_known_good_runtime = { version: runtime.version, path: runtime.path };
  }
  if (state.transaction !== undefined) parsed.transaction = parseTransaction(state.transaction);
  return parsed;
}

function parseTransaction(value: unknown): UpdateTransaction {
  const transaction = record(value, "Update transaction");
  const phase = transaction.phase;
  if (!["prepared", "installing", "recovering"].includes(String(phase))) {
    throw new Error("Update transaction phase is invalid.");
  }
  for (const field of ["id", "target_version", "previous_version", "started_at"] as const) {
    if (typeof transaction[field] !== "string" || !transaction[field]) {
      throw new Error(`Update transaction ${field} is invalid.`);
    }
  }
  compareVersions(transaction.target_version as string, transaction.target_version as string);
  compareVersions(transaction.previous_version as string, transaction.previous_version as string);
  if (!Number.isFinite(Date.parse(transaction.started_at as string))) {
    throw new Error("Update transaction start time is invalid.");
  }
  if (typeof transaction.service_installed !== "boolean") {
    throw new Error("Update transaction service state is invalid.");
  }
  if (transaction.previous_runtime !== null && typeof transaction.previous_runtime !== "string") {
    throw new Error("Update transaction runtime path is invalid.");
  }
  if (transaction.error !== undefined && typeof transaction.error !== "string") {
    throw new Error("Update transaction error is invalid.");
  }
  return {
    id: transaction.id as string,
    phase: phase as UpdateTransaction["phase"],
    target_version: transaction.target_version as string,
    previous_version: transaction.previous_version as string,
    service_installed: transaction.service_installed,
    previous_runtime: transaction.previous_runtime as string | null,
    started_at: new Date(transaction.started_at as string).toISOString(),
    ...(transaction.error ? { error: transaction.error as string } : {})
  };
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

import type { JsonObject } from "@mdbase-dev/connect";

const PREFIX = "mdbase-editor:draft:v1:";
export const DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface RecoveryDraft {
  body: string;
  baseBody: string;
  patch: JsonObject;
  baseFrontmatter: JsonObject;
  savedAt: number;
}

/** Device-local unsent edits, separate from the SDK's exact pending-write recovery. */
export class DraftRecovery {
  constructor(private readonly storage: Storage, private readonly server: string) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith(PREFIX)) this.readKey(key);
    }
  }

  private key(collection: string, path: string) {
    return PREFIX + JSON.stringify([this.server, collection, path]);
  }

  read(collection: string, path: string): RecoveryDraft | undefined {
    return this.readKey(this.key(collection, path));
  }

  private readKey(key: string): RecoveryDraft | undefined {
    const raw = this.storage.getItem(key);
    if (!raw) return;
    let value: RecoveryDraft;
    try { value = JSON.parse(raw); }
    catch { this.storage.removeItem(key); return; }
    if (!value || typeof value.body !== "string" || typeof value.baseBody !== "string"
      || !object(value.patch) || !object(value.baseFrontmatter)
      || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > DRAFT_RETENTION_MS) {
      this.storage.removeItem(key);
      return;
    }
    return value;
  }

  write(collection: string, path: string, draft: Omit<RecoveryDraft, "savedAt">): void {
    this.storage.setItem(this.key(collection, path), JSON.stringify({ ...draft, savedAt: Date.now() }));
  }

  remove(collection: string, path: string): void {
    this.storage.removeItem(this.key(collection, path));
  }
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function frontmatterPatch(base: JsonObject, current: JsonObject): JsonObject {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(current)])]
    .filter((key) => JSON.stringify(base[key]) !== JSON.stringify(current[key]))
    .map((key) => [key, current[key] ?? null]));
}

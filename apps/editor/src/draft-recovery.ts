import type { JsonObject } from "./connect-types";
import { useEffect, useState } from "react";

const PREFIX = "mdbase-editor:draft:v1:";
export const DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** A checkpoint waits for this pause in writing, so a large note is not
 * serialised on every keystroke; a crash loses at most this much typing. */
export const DRAFT_CHECKPOINT_IDLE_MS = 300;

export interface RecoveryDraft {
  body: string;
  baseBody: string;
  patch: JsonObject;
  baseFrontmatter: JsonObject;
  savedAt: number;
}

interface SavedDraftRecord { body?: string; frontmatter: JsonObject }

/** A checkpoint is unnecessary only when its body AND every edited property are saved. */
export function recoveryDraftMatchesRecord(draft: RecoveryDraft, record: SavedDraftRecord): boolean {
  return draft.body === (record.body ?? "") && Object.entries(draft.patch)
    .every(([key, value]) => JSON.stringify(record.frontmatter[key] ?? null) === JSON.stringify(value));
}

interface PendingCheckpoint {
  draft: Omit<RecoveryDraft, "savedAt">;
  stored: (ok: boolean) => void;
}

/** Device-local unsent edits, separate from the SDK's exact pending-write recovery. */
export class DraftRecovery {
  /** At most one checkpoint per note waits for a pause; a newer one replaces it. */
  private readonly pending = new Map<string, PendingCheckpoint>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly storage: Storage, private readonly server: string) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith(PREFIX)) this.readKey(key);
    }
  }

  private key(collection: string, path: string) {
    return PREFIX + JSON.stringify([this.server, collection, path]);
  }

  read(collection: string, path: string, saved?: SavedDraftRecord): RecoveryDraft | undefined {
    const draft = this.readKey(this.key(collection, path));
    if (draft && saved && recoveryDraftMatchesRecord(draft, saved)) {
      this.remove(collection, path, saved);
      return;
    }
    return draft;
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

  /**
   * Checkpoint a note's unsent edits once writing pauses. `stored` learns,
   * when the checkpoint is written, whether this browser could keep it.
   */
  write(collection: string, path: string, draft: Omit<RecoveryDraft, "savedAt">, stored: (ok: boolean) => void): void {
    this.pending.set(this.key(collection, path), { draft, stored });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DRAFT_CHECKPOINT_IDLE_MS);
  }

  /** Write every waiting checkpoint now, e.g. before the page or note goes away. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = [...this.pending];
    this.pending.clear();
    for (const [key, { draft, stored }] of pending) {
      let ok = true;
      try { this.storage.setItem(key, JSON.stringify({ ...draft, savedAt: Date.now() })); }
      catch { ok = false; }
      stored(ok);
    }
  }

  /** Drop every checkpoint for one collection, e.g. a Private collection whose
   * text must not stay in plain browser storage. */
  forgetCollection(collection: string): void {
    for (const key of this.pending.keys()) {
      if (this.belongsTo(key, collection)) this.pending.delete(key);
    }
    for (const key of Object.keys(this.storage)) {
      if (!key.startsWith(PREFIX)) continue;
      try { if (this.belongsTo(key, collection)) this.storage.removeItem(key); }
      catch { this.storage.removeItem(key); }
    }
  }

  private belongsTo(key: string, collection: string): boolean {
    const [server, owner] = JSON.parse(key.slice(PREFIX.length)) as unknown[];
    return server === this.server && owner === collection;
  }

  /** Immediate: a checkpoint still waiting for a pause is dropped with the stored one. */
  remove(collection: string, path: string, saved?: SavedDraftRecord): void {
    const key = this.key(collection, path);
    // A checkpoint waiting in this tab supersedes the stored copy, so only a
    // stored copy alone can be another tab's.
    const waiting = this.pending.delete(key);
    const draft = !waiting && saved && this.readKey(key);
    // An acknowledgement from this tab must not erase another tab's newer unsent edits.
    if (draft && saved && !recoveryDraftMatchesRecord(draft, saved)) return;
    this.storage.removeItem(key);
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

/**
 * This device's draft store, or none for a Private collection: its text is
 * end-to-end encrypted, so it never goes to plain localStorage (the unload
 * guard still protects unsaved edits). Earlier builds did checkpoint Private
 * text, so opening one erases what they left. Waiting checkpoints are written
 * when the page is hidden or left, and when the editor unmounts.
 */
export function useDraftRecovery(server: () => string, privateCollectionId: string | undefined): DraftRecovery | undefined {
  const [store] = useState(() => {
    try { return new DraftRecovery(localStorage, server()); }
    catch { return undefined; }
  });
  useEffect(() => {
    if (!store) return;
    const flush = () => store.flush();
    const hidden = () => { if (document.visibilityState === "hidden") store.flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      store.flush();
    };
  }, [store]);
  useEffect(() => {
    if (!privateCollectionId) return;
    try { store?.forgetCollection(privateCollectionId); } catch { /* storage unavailable */ }
  }, [store, privateCollectionId]);
  return privateCollectionId ? undefined : store;
}

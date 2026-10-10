/**
 * Vault events → `FileEvent` hints for the store (event-driven ingest).
 *
 * - **Hints only.** The store waits for its per-path quiet window, then reads and
 *   hashes. Obsidian's events miss same-size, same-mtime replaces and report torn
 *   intermediate states.
 * - **Quiet-period gate input.** {@link VaultEvents.lastChange} returns when the
 *   path last changed for a reason other than our own write, so the store can defer
 *   a closed-file publish while another writer is active (quiet-period gate).
 * - **Own writes.** {@link VaultEvents.expectOwnWrite} marks a path and content the
 *   platform is about to write. The matching `modify` is reported as a change but
 *   doesn't count as an outside change. The modify event for a plugin's own write
 *   fires synchronously inside the write (vault event ordering), so the mark is set before the
 *   write starts and cleared after it resolves.
 * - **Outside moves** arrive as `create(new)` and then `delete(old)` about 100 ms
 *   later, never as `rename` (move pairing). When a delete follows a create of a file
 *   with the same size and extension within {@link PAIR_WINDOW_MS}, both are
 *   re-emitted as a `RenamedFrom`/`RenamedTo` pair with a shared cookie. That
 *   is a hint: the store confirms the move by content hash (core
 *   `moves::detect_moves`).
 * - **Obsidian renames** (`vault.rename`, file explorer) are paired directly.
 * - **Startup:** the create flood after launch (startup reconciliation) is suppressed. Call
 *   {@link VaultEvents.start} from `onLayoutReady`, which emits one `Rescan` of
 *   the root, because the store must reconcile against a listing anyway.
 */

import type { ObsApp, ObsFile } from "./obsidianApi.js";
import type { FileEvent, FileEventKind } from "./types.js";

/** create→delete pairing window. Allow a conservative window across vault adapters. */
export const PAIR_WINDOW_MS = 1500;

interface RecentCreate {
  readonly path: string;
  readonly size: number | null;
  readonly ext: string;
  readonly at: number;
  paired: boolean;
}

/** Converts vault events for one collection root into `FileEvent`s. */
export class VaultEvents {
  private readonly refs: unknown[] = [];
  private readonly last = new Map<string, number>();
  private readonly own = new Map<string, number>();
  private recent: RecentCreate[] = [];
  private cookie = 1n;
  private started = false;

  /**
   * @param toRel  maps a vault path to a collection-relative path, or `null` if outside
   * @param emit   receives events in order
   * @param now    clock (ms); injected for tests
   */
  constructor(
    private readonly app: ObsApp,
    private readonly toRel: (vaultPath: string) => string | null,
    private readonly emit: (e: FileEvent) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Subscribe. Call from `onLayoutReady` (after the startup create flood). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const v = this.app.vault;
    this.refs.push(
      v.on("create", (f) => this.onCreate(f)),
      v.on("modify", (f) => this.onModify(f)),
      v.on("delete", (f) => this.onDelete(f)),
      v.on("rename", (f, old) => this.onRename(f, old)),
    );
    this.send("Rescan", "", null);
  }

  stop(): void {
    for (const r of this.refs.splice(0)) this.app.vault.offref(r);
    this.started = false;
  }

  /** When `path` (collection-relative) last changed by anyone but us, or `null`. */
  lastChange(path: string): number | null {
    return this.last.get(path) ?? null;
  }

  /** True if nobody else changed `path` within `quietMs`. */
  isQuiet(path: string, quietMs: number): boolean {
    const t = this.last.get(path);
    return t === undefined || this.now() - t >= quietMs;
  }

  /**
   * Mark an own write of `path` in progress. Returns the function to call when the
   * write resolved. Nested marks are counted.
   */
  expectOwnWrite(path: string): () => void {
    this.own.set(path, (this.own.get(path) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.own.get(path) ?? 1) - 1;
      if (n <= 0) this.own.delete(path);
      else this.own.set(path, n);
    };
  }

  private send(kind: FileEventKind, path: string, cookie: bigint | null): void {
    this.emit({ kind, path, id: null, cookie });
  }

  private touch(rel: string): void {
    if (!this.own.has(rel)) this.last.set(rel, this.now());
  }

  private onCreate(f: ObsFile): void {
    const rel = this.toRel(f.path);
    if (rel === null) return;
    this.touch(rel);
    this.prune();
    this.recent.push({ path: rel, size: f.stat?.size ?? null, ext: ext(rel), at: this.now(), paired: false });
    this.send("Created", rel, null);
  }

  private onModify(f: ObsFile): void {
    const rel = this.toRel(f.path);
    if (rel === null) return;
    this.touch(rel);
    this.send("Changed", rel, null);
  }

  /** A recent create is no longer a move candidate once its path is gone. */
  private forget(rel: string): void {
    this.recent = this.recent.filter((c) => c.path !== rel);
  }

  private onDelete(f: ObsFile): void {
    const rel = this.toRel(f.path);
    if (rel === null) return;
    this.touch(rel);
    this.send("Removed", rel, null);
    this.forget(rel);
    this.prune();
    const size = f.stat?.size ?? null;
    if (size === null) return;
    const e = ext(rel);
    // The most recent unpaired create of the same size and extension.
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const c = this.recent[i]!;
      if (!c.paired && c.size === size && c.ext === e && c.path !== rel) {
        c.paired = true;
        const cookie = this.cookie++;
        this.send("RenamedFrom", rel, cookie);
        this.send("RenamedTo", c.path, cookie);
        return;
      }
    }
  }

  private onRename(f: ObsFile, oldPath: string): void {
    const from = this.toRel(oldPath);
    const to = this.toRel(f.path);
    if (from !== null) {
      this.touch(from);
      this.forget(from);
    }
    if (to !== null) this.touch(to);
    if (from !== null && to !== null) {
      const cookie = this.cookie++;
      this.send("RenamedFrom", from, cookie);
      this.send("RenamedTo", to, cookie);
    } else if (from !== null) {
      this.send("Removed", from, null); // moved out of the collection
    } else if (to !== null) {
      this.send("Created", to, null); // moved in
    }
  }

  private prune(): void {
    const cutoff = this.now() - PAIR_WINDOW_MS;
    this.recent = this.recent.filter((c) => c.at >= cutoff);
  }
}

function ext(p: string): string {
  const b = p.slice(p.lastIndexOf("/") + 1);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

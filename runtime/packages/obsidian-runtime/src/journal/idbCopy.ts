/**
 * The IndexedDB copy of the journal: one object per key, written in one
 * `readwrite` transaction with `durability: "strict"` per batch. This requests
 * stronger persistence from the browser, not a physical power-loss guarantee.
 * Browser "Clear storage" can remove this copy.
 */

import { isQuotaError, openDb, req, tx } from "../util/idb.js";
import { entryId, JournalError, type CopyLoad, type JournalCopy, type JournalEntry } from "./types.js";

const ENTRIES = "e";
const META = "m";

interface Meta {
  readonly created: number;
  readonly floor: number;
}

/** The IndexedDB journal copy for one namespace (`<collection>/<replica>`). */
export class IdbJournalCopy implements JournalCopy {
  readonly name = "indexeddb";
  private constructor(private readonly db: IDBDatabase) {}

  static async open(namespace: string, idb?: IDBFactory): Promise<IdbJournalCopy> {
    return new IdbJournalCopy(await openDb(`mdbase-journal:${namespace}`, 1, [ENTRIES, META], idb));
  }

  async load(): Promise<CopyLoad> {
    try {
      const [meta, all] = await tx(this.db, [ENTRIES, META], "readonly", (t) =>
        Promise.all([req<Meta | undefined>(t.objectStore(META).get("meta")), req<JournalEntry[]>(t.objectStore(ENTRIES).getAll())]),
      );
      if (!meta) return { state: all.length ? "corrupt" : "missing", entries: all, floor: 0, damaged: 0 };
      let damaged = 0;
      const entries = all.filter((e) => {
        const ok = e && typeof e.space === "number" && e.key instanceof Uint8Array && Number.isSafeInteger(e.version) && (e.value === null || e.value instanceof Uint8Array);
        if (!ok) damaged++;
        return ok;
      });
      return { state: "ok", entries, floor: meta.floor, damaged };
    } catch (e) {
      return { state: "corrupt", entries: [], floor: 0, damaged: 0 };
    }
  }

  async append(batch: readonly JournalEntry[]): Promise<void> {
    await this.write((t) => {
      const s = t.objectStore(ENTRIES);
      for (const e of batch) s.put(e, entryId(e.space, e.key));
      return undefined;
    }, false);
  }

  async compact(live: readonly JournalEntry[], floor: number): Promise<void> {
    await this.write((t) => {
      const s = t.objectStore(ENTRIES);
      s.clear();
      for (const e of live) s.put(e, entryId(e.space, e.key));
      return undefined;
    }, true, floor);
  }

  private async write(fn: (t: IDBTransaction) => undefined, reset: boolean, floor?: number): Promise<void> {
    try {
      await tx(this.db, [ENTRIES, META], "readwrite", (t) => {
        const m = t.objectStore(META);
        if (reset) {
          m.put({ created: Date.now(), floor: floor ?? 0 } satisfies Meta, "meta");
        } else {
          // First append on a fresh database: record that the copy exists.
          const r = m.get("meta");
          r.onsuccess = () => {
            if (!r.result) m.put({ created: Date.now(), floor: 0 } satisfies Meta, "meta");
          };
        }
        fn(t);
      });
    } catch (e) {
      if (isQuotaError(e)) throw new JournalError("full", `IndexedDB journal: ${String(e)}`);
      throw new JournalError("other", `IndexedDB journal: ${String(e)}`);
    }
  }

  close(): void {
    this.db.close();
  }
}

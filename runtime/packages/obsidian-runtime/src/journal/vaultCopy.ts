/**
 * The vault-file copy of the journal: CRC-framed text lines appended with
 * `adapter.append`, compacted into alternating A/B files.
 *
 * It is the copy that survives browser "Clear storage" and app reinstall,
 * but not necessarily the recent tail after power loss: the adapter never fsyncs.
 * Append/compaction rules:
 * - never overwrite or rename the live file; compaction writes the *other* file;
 * - no remove+rename, ever.
 *
 * Format (ASCII lines, `\n`-terminated):
 *
 *     H:<base64 JSON {v, gen, floor, ns}>:<crc32 hex>
 *     B:<base64 batch>:<crc32 hex>          ← the snapshot (zero or more lines)
 *     C:<base64 JSON {n}>:<crc32 hex>         ← snapshot complete, n = B lines above
 *     B:<base64 batch>:<crc32 hex>          ← appends
 *
 * A file counts only if its `H` and `C` lines are intact (a torn compaction leaves
 * the other file in charge). The live file is the valid one with the highest
 * `gen`. A torn last line is dropped (atomic batches). Damaged lines after `C`
 * are skipped and counted.
 *
 * The files live per device under the collection's private directory, e.g.
 * `.mdbase/devices/<device>/journal-{a,b}.log` (device-local ownership). The header's `ns` rejects
 * a file copied in from another device or collection by a sync tool.
 */

import { decodeBase64, encodeBase64 } from "../embed/base64.js";
import { crc32Ascii } from "../util/crc32.js";
import { decodeBatch, encodeBatch, entryId, JournalError, type CopyLoad, type JournalCopy, type JournalEntry } from "./types.js";

/** The vault operations used (Obsidian `DataAdapter`). */
export interface VaultFileIO {
  /** File content, or `null` if absent. */
  read(path: string): Promise<string | null>;
  /** Create or overwrite (in place, as Obsidian does). */
  write(path: string, data: string): Promise<void>;
  /** Append to an existing file. */
  append(path: string, data: string): Promise<void>;
  /** Create the directory and its parents. */
  mkdirs(path: string): Promise<void>;
}

/** Adapt an Obsidian `DataAdapter`. */
export function adapterFileIO(adapter: {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, d: string): Promise<void>;
  append(p: string, d: string): Promise<void>;
  mkdir(p: string): Promise<void>;
}): VaultFileIO {
  return {
    read: async (p) => ((await adapter.exists(p)) ? adapter.read(p) : null),
    write: (p, d) => adapter.write(p, d),
    append: (p, d) => adapter.append(p, d),
    mkdirs: async (p) => {
      let cur = "";
      for (const seg of p.split("/")) {
        cur = cur ? `${cur}/${seg}` : seg;
        if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
      }
    },
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function line(kind: "H" | "B" | "C", payload: Uint8Array): string {
  const body = `${kind}:${encodeBase64(payload)}`;
  return `${body}:${crc32Ascii(body).toString(16).padStart(8, "0")}\n`;
}

function json(o: unknown): Uint8Array {
  return enc.encode(JSON.stringify(o));
}

type Parsed = { kind: "H" | "B" | "C"; payload: Uint8Array } | null;

function parseLine(l: string): Parsed {
  const m = /^([HBC]):([A-Za-z0-9+/=]*):([0-9a-f]{8})$/.exec(l);
  if (!m) return null;
  const body = `${m[1]}:${m[2]}`;
  if (crc32Ascii(body) !== parseInt(m[3]!, 16)) return null;
  try {
    return { kind: m[1] as "H" | "B" | "C", payload: decodeBase64(m[2]!) };
  } catch {
    return null;
  }
}

interface FileState {
  readonly path: string;
  readonly valid: boolean;
  readonly gen: number;
  readonly floor: number;
  readonly entries: Map<string, JournalEntry>;
  readonly damaged: number;
  /** Something of ours is there (foreign files count as absent). */
  readonly present: boolean;
  /**
   * The very first snapshot (gen 1) was torn before its `C` line. No append can
   * have been acknowledged into it: appends start only after a complete
   * snapshot. So it means "never written", not "lost".
   */
  readonly tornInitial: boolean;
}

/** The A/B vault journal for one device of one collection. */
export class VaultJournalCopy implements JournalCopy {
  readonly name = "vault-file";
  private active: { path: string; gen: number } | null = null;

  /**
   * @param dir   vault path of the per-device directory
   * @param ns    namespace written into headers (`<collection>/<device>`)
   */
  constructor(
    private readonly io: VaultFileIO,
    private readonly dir: string,
    private readonly ns: string,
  ) {}

  private paths(): [string, string] {
    return [`${this.dir}/journal-a.log`, `${this.dir}/journal-b.log`];
  }

  private async readFile(path: string): Promise<FileState> {
    const empty = (present: boolean, tornInitial = false): FileState => ({ path, valid: false, gen: 0, floor: 0, entries: new Map(), damaged: 0, present, tornInitial });
    let text: string | null;
    try {
      text = await this.io.read(path);
    } catch {
      return empty(true);
    }
    if (text === null) return empty(false);
    const lines = text.split("\n");
    lines.pop(); // the part after the last newline: "" or a torn tail
    const h = lines.length > 0 ? parseLine(lines[0]!) : null;
    if (!h || h.kind !== "H") return empty(true);
    let head: { v: number; gen: number; floor: number; ns: string };
    try {
      head = JSON.parse(dec.decode(h.payload));
    } catch {
      return empty(true);
    }
    if (head.v !== 1 || !Number.isSafeInteger(head.gen)) return empty(true);
    // Another device's or collection's journal (copied in by a sync tool): not ours.
    if (head.ns !== this.ns) return empty(false);
    const entries = new Map<string, JournalEntry>();
    const apply = (payload: Uint8Array): boolean => {
      let batch: JournalEntry[];
      try {
        batch = decodeBatch(payload);
      } catch {
        return false;
      }
      for (const e of batch) {
        const id = entryId(e.space, e.key);
        const cur = entries.get(id);
        if (!cur || cur.version < e.version) entries.set(id, e);
      }
      return true;
    };
    let i = 1;
    let snapshotLines = 0;
    let sealed = false;
    for (; i < lines.length; i++) {
      const p = parseLine(lines[i]!);
      if (!p) break;
      if (p.kind === "B") {
        if (!apply(p.payload)) break;
        snapshotLines++;
        continue;
      }
      if (p.kind === "C") {
        try {
          sealed = JSON.parse(dec.decode(p.payload)).n === snapshotLines;
        } catch {
          sealed = false;
        }
      }
      break;
    }
    if (!sealed) return empty(true, head.gen === 1);
    let damaged = 0;
    for (i++; i < lines.length; i++) {
      const p = parseLine(lines[i]!);
      if (!p || p.kind !== "B" || !apply(p.payload)) damaged++;
    }
    return { path, valid: true, gen: head.gen, floor: head.floor, entries, damaged, present: true, tornInitial: false };
  }

  async load(): Promise<CopyLoad> {
    const [a, b] = await Promise.all(this.paths().map((p) => this.readFile(p)));
    const valid = [a!, b!].filter((f) => f.valid).sort((x, y) => y.gen - x.gen);
    const best = valid[0];
    if (!best) {
      this.active = null;
      const ours = [a!, b!].filter((f) => f.present);
      const corrupt = ours.some((f) => !f.tornInitial);
      return { state: corrupt ? "corrupt" : "missing", entries: [], floor: 0, damaged: 0 };
    }
    this.active = { path: best.path, gen: best.gen };
    return { state: "ok", entries: [...best.entries.values()], floor: best.floor, damaged: best.damaged };
  }

  async append(batch: readonly JournalEntry[]): Promise<void> {
    if (!this.active) await this.compact([], 0);
    try {
      await this.io.append(this.active!.path, line("B", encodeBatch(batch)));
    } catch (e) {
      throw new JournalError("other", `vault journal append: ${String(e)}`);
    }
  }

  async compact(live: readonly JournalEntry[], floor: number): Promise<void> {
    const [a, b] = this.paths();
    const target = this.active?.path === a ? b : a;
    const gen = (this.active?.gen ?? 0) + 1;
    let text = line("H", json({ v: 1, gen, floor, ns: this.ns }));
    // One batch line per ~1000 entries keeps lines a sane size.
    let n = 0;
    for (let i = 0; i < live.length; i += 1000) {
      text += line("B", encodeBatch(live.slice(i, i + 1000)));
      n++;
    }
    text += line("C", json({ n }));
    try {
      await this.io.mkdirs(this.dir);
      await this.io.write(target, text);
    } catch (e) {
      throw new JournalError("other", `vault journal compact: ${String(e)}`);
    }
    this.active = { path: target, gen };
  }
}

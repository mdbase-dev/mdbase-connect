/** Explicit whole-file adapter provider; not positional IO or an inode handle. */
import type { ObsAdapter, ObsStat } from "./obsidianApi.js";
import { checkRelPath, FsError, type FileMeta } from "./types.js";
import { ATTACHMENT_RANGE_BYTES } from "../attachments/range.js";

export interface WholeFileRange {
  /** Owned original snapshot bytes; excludes transient adapter/IPC copies. */
  readonly retainedBytes: number;
  readonly openedMeta: FileMeta;
  readAt(offset: number, length: number): Promise<Uint8Array>;
  currentMeta(): Promise<FileMeta>;
  close(): Promise<void>;
}

function meta(stat: ObsStat | null): FileMeta {
  if (!stat) throw new FsError("NotFound", "range source missing");
  if (stat.type !== "file") throw new FsError("WrongKind", "range source must be a file");
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtime) || !Number.isFinite(stat.ctime))
    throw new FsError("Unsupported", "invalid range metadata");
  return { kind: "File", size: stat.size, mtimeNs: BigInt(Math.round(stat.mtime)) * 1_000_000n,
    ctimeNs: BigInt(Math.round(stat.ctime)) * 1_000_000n, id: null };
}
function same(a: FileMeta, b: FileMeta): boolean {
  return a.kind === b.kind && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The adapter owns path confinement. This provider captures an actual bounded
 * byte snapshot and re-reads/compares the named source before every result.
 * It does NOT claim fstat, inode identity, atomic outside-writer exclusion or
 * single-chunk allocation. readBinary allocates the WHOLE file; a racing growth
 * may allocate beyond the prechecked bound before the adapter returns. Accepted
 * and retained bytes are bounded; this is not a peak-heap/durability guarantee.
 * Use explicitly, never as a silent fallback for the stable-handle RangeBackend.
 */
export async function openWholeFileRange(
  adapter: Pick<ObsAdapter, "stat" | "readBinary">,
  path: string,
  maxBytes: number,
): Promise<WholeFileRange> {
  checkRelPath(path);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > ATTACHMENT_RANGE_BYTES)
    throw new FsError("Unsupported", "invalid whole-file range bound");
  const openedMeta = Object.freeze(meta(await adapter.stat(path)));
  if (openedMeta.size > maxBytes) throw new FsError("NoSpace", "whole-file range bound");
  const original = new Uint8Array(await adapter.readBinary(path));
  try {
    const after = meta(await adapter.stat(path));
    if (original.length > maxBytes) throw new FsError("NoSpace", "whole-file range bound");
    if (original.length !== openedMeta.size || !same(openedMeta, after))
      throw new FsError("Busy", "source_changed");
  } catch (e) { original.fill(0); throw e; }
  let closed = false;
  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();
  const live = () => { if (closed) throw new FsError("BadHandle", "range source closed"); };
  async function checked(): Promise<FileMeta> {
    live();
    const before = meta(await adapter.stat(path));
    live();
    if (!same(openedMeta, before)) throw new FsError("Busy", "source_changed");
    if (before.size > maxBytes) throw new FsError("NoSpace", "whole-file range bound");
    const current = new Uint8Array(await adapter.readBinary(path));
    try {
      live();
      const after = meta(await adapter.stat(path));
      live();
      if (current.length > maxBytes) throw new FsError("NoSpace", "whole-file range bound");
      if (!same(openedMeta, after) || !equal(original, current)) throw new FsError("Busy", "source_changed");
      return after;
    } finally { current.fill(0); }
  }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    live();
    if (busy) throw new FsError("Busy", "range IO pending");
    busy = true;
    let finish!: () => void;
    inFlight = new Promise<void>(resolve => { finish = resolve; });
    try {
      const value = await work();
      if (closed && value instanceof Uint8Array) value.fill(0);
      live();
      return value;
    }
    catch (e) { closed = true; throw e; }
    finally { busy = false; if (closed) original.fill(0); finish(); }
  }
  return {
    retainedBytes: original.length,
    openedMeta,
    readAt(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > openedMeta.size ||
          !Number.isSafeInteger(length) || length < 0 || length > ATTACHMENT_RANGE_BYTES ||
          offset > Number.MAX_SAFE_INTEGER - length)
        return Promise.reject(new FsError("Unsupported", "invalid bounded range"));
      return run(async () => {
        await checked();
        live();
        return original.slice(offset, Math.min(original.length, offset + length));
      });
    },
    currentMeta: () => run(checked),
    close() {
      closed = true;
      return inFlight.then(() => { original.fill(0); });
    },
  };
}

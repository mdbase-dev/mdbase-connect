/**
 * The Obsidian vault as a `FilePlatform` (`ReplaceStrategy::GuardedInPlace`,
 * guarded publication). It serves `FileOp` requests from the store's host queue.
 *
 * What the vault API gives, and so what this platform declares (vault API constraints):
 * - writes are in place: no temp+rename and no fsync (`durability: None`);
 * - `process()` is atomic only against other vault calls, not against outside
 *   writers;
 * - `create` is check-then-write (`exclusiveCreate: false`);
 * - events are hints keyed on (mtime, size) (`events: Hint`);
 * - Android shared storage is case-insensitive although the adapter says
 *   otherwise, and its rename is delete-then-rename.
 *
 * The store (portable Rust, simulator-tested) runs the protocol over these
 * primitives:
 * - the journal first;
 * - the editor route when the file is open;
 * - the quiet-period gate, using {@link VaultEvents.lastChange};
 * - `guarded_replace`;
 * - verification by re-reading after the modify event;
 * - recovery from the journal (durable intent recovery).
 *
 * This file supplies the primitives:
 * - **`GuardedReplace`**: `vault.process` (or `adapter.process` for files outside
 *   the vault index, such as dot-folders) with an exact comparison against the
 *   expected content *inside* the callback, so nothing is written on mismatch and
 *   the current content comes back.
 * - **`GuardedCreate`**: refuse if anything exists at the path, compared without
 *   regard to case where the volume is case-insensitive; then `vault.create`.
 * - **`GuardedTrash`**: a no-op `process` to read and compare under the vault
 *   queue, then `fileManager.trashFile` (the user's trash setting).
 * - **`RenameNoreplace`**: never onto an occupied or case-equal path. A case-only
 *   rename on a case-insensitive volume goes through a temporary name (case-preserving rename:
 *   on Android the bridge deletes the file otherwise).
 *
 * Text only for guarded operations. `process` hands the callback a decoded
 * string. Content that isn't valid UTF-8 can't be compared exactly, so the
 * guarded operations return `Unsupported` for it, and the store holds instead of
 * writing.
 */

import { detectForeignSync } from "./syncDetect.js";
import { ATTACHMENT_RANGE_BYTES, AttachmentRangeError, AttachmentRangeOpenError, type BoundedRangeSource, type RangeLease } from "../attachments/range.js";
import type { ObsApp, ObsFile, ObsPlatform } from "./obsidianApi.js";
import {
  checkRelPath,
  FsError,
  type Capabilities,
  type DirEntry,
  type FileMeta,
  type FileOp,
  type FileOpOutput,
  type FileOpResult,
  type Guarded,
} from "./types.js";

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();

function utf8(b: Uint8Array): string | null {
  try {
    return strict.decode(b);
  } catch {
    return null;
  }
}

function ab(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Options for {@link VaultPlatform}. */
export interface VaultPlatformOptions {
  /** The collection's folder in the vault (`""` for the vault root). */
  readonly root: string;
  /** `Platform` from `obsidian`. */
  readonly platform: ObsPlatform;
  /** The store's private directory, relative to the collection root. */
  readonly privateDir?: string;
  /** Marks own writes so they don't count as outside changes (quiet-period gate). */
  readonly events?: { expectOwnWrite(path: string): () => void };
  /**
   * Explicit qualified provider: safely opens a root-confined stable handle for
   * this vault path. No native/mobile provider or durability is inferred here.
   * Without it ReadRange is Unsupported, never whole readBinary+slice.
   */
  readonly openRangeSource?: (vaultPath: string) => Promise<BoundedRangeSource>;
}

/** The vault `FilePlatform`. */
export class VaultPlatform {
  readonly capabilities: Capabilities;
  private readonly root: string;
  private readonly events: VaultPlatformOptions["events"];
  private readonly openRangeSource: VaultPlatformOptions["openRangeSource"];
  private readonly rangeSources = new Set<BoundedRangeSource>();
  private readonly rangeOpenCleanup = new Set<AttachmentRangeOpenError>();
  private rangeBusy = false;
  private rangesClosed = false;
  private rangeDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: ObsApp,
    opts: VaultPlatformOptions,
  ) {
    if (opts.root) checkRelPath(opts.root);
    this.root = opts.root;
    this.events = opts.events;
    this.openRangeSource = opts.openRangeSource;
    const adapter = app.vault.adapter;
    // Android shared storage is case-insensitive although the adapter
    // reports `insensitive = false`. iOS (APFS default) is insensitive too.
    const insensitive = opts.platform.isAndroidApp || opts.platform.isIosApp || adapter.insensitive === true;
    this.capabilities = {
      replace: "GuardedInPlace",
      exclusiveCreate: false,
      durability: "None",
      case: insensitive ? "Insensitive" : "Sensitive",
      fileIds: false,
      mtimeResolutionNs: 1_000_000n,
      events: "Hint",
      transientMissing: opts.platform.isAndroidApp, // delete-then-rename in the bridge
      privateDir: opts.privateDir ?? ".mdbase",
    };
  }

  /** Vault path of a collection-relative path. */
  vaultPath(rel: string): string {
    checkRelPath(rel);
    if (!this.root) return rel;
    return rel ? `${this.root}/${rel}` : this.root;
  }

  /** Collection-relative path of a vault path, or `null` if outside the collection. */
  relPath(vaultPath: string): string | null {
    if (!this.root) return vaultPath;
    if (vaultPath === this.root) return "";
    return vaultPath.startsWith(`${this.root}/`) ? vaultPath.slice(this.root.length + 1) : null;
  }

  private async own<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    const done = this.events ? paths.map((p) => this.events!.expectOwnWrite(p)) : [];
    try {
      return await fn();
    } finally {
      for (const d of done) d();
    }
  }

  /** Perform one queued operation. Never throws: errors become `FsError` results. */
  async perform(op: FileOp): Promise<FileOpResult> {
    try {
      const value = await this.dispatch(op);
      // The public host boundary has its own final await: shutdown must win
      // before delivery even if the private range helper already completed.
      if (op.op === "ReadRange" && this.rangesClosed) {
        if (value.kind === "Bytes") value.value.fill(0);
        throw new FsError("BadHandle", "range provider closed");
      }
      return { ok: true, value };
    } catch (e) {
      if (e instanceof FsError) return { ok: false, error: e };
      return { ok: false, error: classify(e) };
    }
  }

  private async dispatch(op: FileOp): Promise<FileOpOutput> {
    const a = this.app.vault.adapter;
    switch (op.op) {
      case "Environment": {
        let names: string[] = [];
        try {
          const l = await a.list(this.root || "/");
          names = [...l.files, ...l.folders].map(base);
        } catch {
          /* unlistable root */
        }
        let basePath: string | null = null;
        try {
          basePath = a.getBasePath ? a.getBasePath() : null;
        } catch {
          basePath = null;
        }
        if (basePath && this.root) basePath = `${basePath}/${this.root}`;
        return { kind: "Environment", value: detectForeignSync(this.app, basePath, names) };
      }
      case "Stat":
        return { kind: "Meta", value: await this.stat(op.path) };
      case "Read": {
        const bytes = await this.readBytes(op.path);
        // No handle-based fstat in the vault API: stat right after reading. The
        // store treats metadata as a hint and hashes content (hint-based ingest).
        return { kind: "Read", value: { bytes, meta: await this.stat(op.path) } };
      }
      case "ReadRange":
        return { kind: "Bytes", value: await this.readRange(op.path, op.offset, op.len) };
      case "List": {
        const dir = this.vaultPath(op.dir);
        const st = await a.stat(dir || "/");
        if (!st && dir) throw new FsError("NotFound", op.dir);
        if (st && st.type !== "folder") throw new FsError("WrongKind", op.dir);
        const l = await a.list(dir || "/");
        const entries: DirEntry[] = [...l.files.map((p) => ({ name: base(p), kind: "File" as const })), ...l.folders.map((p) => ({ name: base(p), kind: "Dir" as const }))];
        return { kind: "Entries", value: entries };
      }
      case "CreateDirAll":
        await this.mkdirs(this.vaultPath(op.dir));
        return { kind: "Unit" };
      case "WriteNew": {
        const p = this.vaultPath(op.path);
        if (await this.occupied(p)) throw new FsError("AlreadyExists", op.path);
        await this.own([op.path], () => a.writeBinary(p, ab(op.bytes)));
        return { kind: "Meta", value: await this.stat(op.path) };
      }
      case "Append": {
        const p = this.vaultPath(op.path);
        if (!(await a.exists(p))) throw new FsError("NotFound", op.path);
        if (a.appendBinary) await a.appendBinary(p, ab(op.bytes));
        else throw new FsError("Unsupported", "appendBinary (Obsidian < 1.12)");
        return { kind: "Unit" };
      }
      case "RenameNoreplace":
        await this.own([op.from, op.to], () => this.renameNoreplace(op.from, op.to));
        return { kind: "Unit" };
      case "RemoveFile": {
        const p = this.vaultPath(op.path);
        const st = await a.stat(p);
        if (!st) throw new FsError("NotFound", op.path);
        if (st.type !== "file") throw new FsError("WrongKind", op.path);
        await a.remove(p);
        return { kind: "Unit" };
      }
      case "Flush":
        // durability: None. Nothing to flush through this API (vault durability limits).
        return { kind: "Unit" };
      case "GuardedReplace":
        return { kind: "Guarded", value: await this.own([op.path], () => this.guardedReplace(op.path, op.expect, op.new)) };
      case "GuardedCreate":
        return { kind: "Guarded", value: await this.own([op.path], () => this.guardedCreate(op.path, op.bytes)) };
      case "GuardedTrash":
        return { kind: "Guarded", value: await this.own([op.path], () => this.guardedTrash(op.path, op.expect)) };
      case "OtherHolders":
        // The vault API can't tell who else has a file open.
        return { kind: "Holders", value: "Unknown" };
      default:
        throw new FsError("Unsupported", op.op);
    }
  }

  /** Permanently stop range IO and retry any failed handle cleanup. */
  async closeRangeReads(): Promise<void> {
    this.rangesClosed = true;
    // Invalidate issued sources before waiting, so late IO cannot yield bytes.
    for (const source of this.rangeSources) void source.close().catch(() => {});
    await this.rangeDone;
    const failures = await Promise.all([...this.rangeSources].map(async source => {
      try { await source.close(); this.rangeSources.delete(source); return false; }
      catch { return true; }
    }));
    for (const error of this.rangeOpenCleanup) {
      try { await error.retryCleanup(); this.rangeOpenCleanup.delete(error); }
      catch { failures.push(true); }
    }
    if (failures.some(Boolean)) throw new FsError("Other", "range cleanup pending");
  }

  private async readRange(rel: string, offset: number, length: number): Promise<Uint8Array> {
    const path = this.vaultPath(rel); // validate BEFORE calling the provider
    if (this.rangesClosed) throw new FsError("BadHandle", "range provider closed");
    if (!this.openRangeSource) throw new FsError("Unsupported", "bounded range provider required");
    if (this.rangeBusy || this.rangeSources.size || this.rangeOpenCleanup.size) throw new FsError("Busy", "range read or cleanup pending");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset > Number.MAX_SAFE_INTEGER - length)
      throw new FsError("Unsupported", "invalid range");
    if (length > ATTACHMENT_RANGE_BYTES) throw new FsError("NoSpace", "range working limit");
    this.rangeBusy = true;
    let finish!: () => void;
    this.rangeDone = new Promise<void>(resolve => { finish = resolve; });
    let source: BoundedRangeSource | null = null;
    let lease: RangeLease | null = null;
    let output: Uint8Array | null = null;
    try {
      source = await this.openRangeSource(path);
      this.rangeSources.add(source);
      if (this.rangesClosed) throw new FsError("BadHandle", "range provider closed");
      lease = await source.readAt(offset, length);
      if (this.rangesClosed) throw new FsError("BadHandle", "range provider closed");
      // Output belongs to the host/ABI caller. Lease release wipes the source
      // allocation; this bounded copy must be counted in downstream budgets.
      output = lease.bytes.slice();
    } catch (e) {
      if (e instanceof AttachmentRangeOpenError) this.rangeOpenCleanup.add(e);
      if (e instanceof AttachmentRangeError) {
        const kind = e.code === "full" ? "NoSpace" : e.code === "busy" || e.code === "source_changed" ? "Busy"
          : e.code === "closed" ? "BadHandle" : e.code === "unsupported" || e.code === "invalid_range" ? "Unsupported" : "Other";
        throw new FsError(kind, e.code);
      }
      throw new FsError(e instanceof FsError ? e.kind : "Other", "range provider IO");
    } finally {
      lease?.release();
      try {
        if (source) {
          try { await source.close(); this.rangeSources.delete(source); }
          catch { output?.fill(0); throw new FsError("Other", "range cleanup pending"); }
        }
      } finally { this.rangeBusy = false; finish(); }
    }
    // No await follows this check. A return scheduled before cleanup would
    // escape shutdown that began while the final source.close was pending.
    if (this.rangesClosed) {
      output?.fill(0);
      throw new FsError("BadHandle", "range provider closed");
    }
    if (!output) throw new FsError("Other", "range output unavailable");
    return output;
  }

  private async stat(rel: string): Promise<FileMeta> {
    const st = await this.app.vault.adapter.stat(this.vaultPath(rel));
    if (!st) throw new FsError("NotFound", rel);
    return {
      kind: st.type === "file" ? "File" : "Dir",
      size: st.size,
      mtimeNs: BigInt(Math.round(st.mtime)) * 1_000_000n,
      ctimeNs: BigInt(Math.round(st.ctime)) * 1_000_000n,
      id: null,
    };
  }

  private async readBytes(rel: string): Promise<Uint8Array> {
    const p = this.vaultPath(rel);
    const st = await this.app.vault.adapter.stat(p);
    if (!st) throw new FsError("NotFound", rel);
    if (st.type !== "file") throw new FsError("WrongKind", rel);
    return new Uint8Array(await this.app.vault.adapter.readBinary(p));
  }

  private async mkdirs(p: string): Promise<void> {
    if (!p) return;
    const a = this.app.vault.adapter;
    let cur = "";
    for (const seg of p.split("/")) {
      cur = cur ? `${cur}/${seg}` : seg;
      const st = await a.stat(cur);
      if (!st) await a.mkdir(cur);
      else if (st.type !== "folder") throw new FsError("WrongKind", cur);
    }
  }

  /** Something exists at `p`, compared case-insensitively on insensitive volumes. */
  private async occupied(p: string): Promise<boolean> {
    const a = this.app.vault.adapter;
    if (await a.exists(p, true)) return true;
    if (this.capabilities.case === "Sensitive") return false;
    if (await a.exists(p, false)) return true;
    // Fall back to listing the parent: some adapters ignore `sensitive`.
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    try {
      const l = await a.list(parent || "/");
      const want = base(p).toLowerCase();
      return [...l.files, ...l.folders].some((q) => base(q).toLowerCase() === want);
    } catch {
      return false;
    }
  }

  private async renameNoreplace(fromRel: string, toRel: string): Promise<void> {
    const a = this.app.vault.adapter;
    const from = this.vaultPath(fromRel);
    const to = this.vaultPath(toRel);
    if (!(await a.exists(from, true))) throw new FsError("NotFound", fromRel);
    const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase();
    if (caseOnly && this.capabilities.case === "Insensitive") {
      // A case-only rename through the Android bridge deletes the file,
      // and vault.rename refuses it. Go through a temporary name in the same folder.
      const tmp = `${from}.mdbase-case-${Math.random().toString(36).slice(2, 10)}`;
      if (await this.occupied(tmp)) throw new FsError("AlreadyExists", tmp);
      await this.renameOne(from, tmp);
      try {
        await this.renameOne(tmp, to);
      } catch (e) {
        await this.renameOne(tmp, from).catch(() => {});
        throw e;
      }
      return;
    }
    if (from === to) return;
    if (await this.occupied(to)) throw new FsError("AlreadyExists", toRel);
    const parent = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
    await this.mkdirs(parent);
    await this.renameOne(from, to);
  }

  private async renameOne(from: string, to: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(from);
    // vault.rename keeps Obsidian's file tree and open editors in step; files
    // outside the index (dot-folders) go through the adapter.
    if (f) await this.app.vault.rename(f, to);
    else await this.app.vault.adapter.rename(from, to);
  }

  private file(p: string): ObsFile | null {
    const v = this.app.vault;
    return (v.getFileByPath ? v.getFileByPath(p) : v.getAbstractFileByPath(p)) ?? null;
  }

  /** `process` under the vault queue, on the TFile when indexed, else the adapter. */
  private process(p: string, fn: (cur: string) => string): Promise<string> {
    const f = this.file(p);
    return f ? this.app.vault.process(f, fn) : this.app.vault.adapter.process(p, fn);
  }

  private async guardedReplace(rel: string, expect: Uint8Array, next: Uint8Array): Promise<Guarded> {
    const p = this.vaultPath(rel);
    const expectText = utf8(expect);
    const nextText = utf8(next);
    if (expectText === null || nextText === null) throw new FsError("Unsupported", "guarded replace of non-UTF-8 content");
    if (!(await this.app.vault.adapter.exists(p, true))) return { kind: "Missing" };
    let seen: string | null = null;
    try {
      await this.process(p, (cur) => {
        seen = cur;
        return cur === expectText ? nextText : cur;
      });
    } catch (e) {
      if (!(await this.app.vault.adapter.exists(p, true))) return { kind: "Missing" };
      throw e;
    }
    if (seen === null) return { kind: "Missing" };
    if (seen !== expectText) return { kind: "Mismatch", current: enc.encode(seen) };
    return { kind: "Done" };
  }

  private async guardedCreate(rel: string, bytes: Uint8Array): Promise<Guarded> {
    const p = this.vaultPath(rel);
    if (await this.occupied(p)) return { kind: "Exists" };
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    await this.mkdirs(parent);
    const text = utf8(bytes);
    try {
      if (text !== null && /\.(md|base|canvas|txt|json|ya?ml)$/i.test(p)) await this.app.vault.create(p, text);
      else await this.app.vault.createBinary(p, ab(bytes));
    } catch (e) {
      // "File already exists." from the vault's own check: someone won the race.
      if (await this.occupied(p)) return { kind: "Exists" };
      throw e;
    }
    return { kind: "Done" };
  }

  private async guardedTrash(rel: string, expect: Uint8Array): Promise<Guarded> {
    const p = this.vaultPath(rel);
    const expectText = utf8(expect);
    if (expectText === null) throw new FsError("Unsupported", "guarded trash of non-UTF-8 content");
    if (!(await this.app.vault.adapter.exists(p, true))) return { kind: "Missing" };
    let seen: string | null = null;
    await this.process(p, (cur) => {
      seen = cur;
      return cur;
    });
    if (seen !== expectText) return seen === null ? { kind: "Missing" } : { kind: "Mismatch", current: enc.encode(seen) };
    const f = this.file(p);
    if (f) await this.app.fileManager.trashFile(f);
    else await this.app.vault.adapter.remove(p);
    return { kind: "Done" };
  }
}

function base(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function classify(e: unknown): FsError {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;
  if (code === "ENOENT" || /no such file|not exist|ENOENT/i.test(msg)) return new FsError("NotFound", msg);
  if (code === "EEXIST" || /already exists/i.test(msg)) return new FsError("AlreadyExists", msg);
  if (code === "EACCES" || code === "EPERM" || /permission/i.test(msg)) return new FsError("PermissionDenied", msg);
  if (code === "ENOSPC" || /quota|no space/i.test(msg)) return new FsError("NoSpace", msg);
  if (code === "EBUSY") return new FsError("Busy", msg);
  return new FsError("Other", msg);
}

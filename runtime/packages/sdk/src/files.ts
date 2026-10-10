/**
 * Files: handles, streams, progress and materialization (`replica-client-api.md` §10).
 *
 * Apps see file handles and byte streams. Blob parts, sealing and the carrying
 * transport stay inside the replica.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { CborValue } from "./cbor.js";
import { hash as hashCodec, hashFromBytes, list, uint, uuid as uuidCodec } from "./codec.js";
import type { MdbaseClient, Write, WriteOptions } from "./client.js";
import { isMdbaseError, mdbaseError } from "./errors.js";
import type { Session } from "./session.js";
import { uuidv7 } from "./values.js";
import {
  FileChunk,
  fileChunk,
  FileView,
  fileView,
  listFilesResult,
  ListFilesResult,
  Materialization,
  materialization,
  MediaClass,
  mediaClass,
  openUploadParams,
  OpenUploadParams,
  openUploadResult,
  receipt as receiptCodec,
  transferProgress,
  TransferProgress,
  uploadChunkParams,
  Uuid,
} from "./wire.js";

/** Convenience reads that return whole bytes are capped, as today (§10.2). */
export const MAX_CONVENIENCE_BYTES = 64 * 1024 * 1024;
/** Bytes held per stream for chunks that overtake their `read_file` response. */
const EARLY_CHUNK_BYTES = 8 * 1024 * 1024;

export type FileRef = Uuid | { path: string } | FileView;

function fileRef(f: FileRef): CborValue {
  if (typeof f === "string") return uuidCodec.enc(f);
  if ("id" in f) return uuidCodec.enc(f.id);
  return f.path;
}

function fileId(f: FileRef): Uuid {
  if (typeof f === "string") return f;
  if ("id" in f) return f.id;
  throw mdbaseError("invalid_request", "this operation needs a file ID; get() the file first");
}

function m(entries: [number, CborValue | undefined][]): Map<number, CborValue> {
  const out = new Map<number, CborValue>();
  for (const [k, v] of entries) if (v !== undefined) out.set(k, v);
  return out;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (p: TransferProgress) => void;
  /** Reuse to resume an interrupted upload (retry-safe). Default: a new UUIDv7. */
  transferId?: Uuid;
  /** Replace this file (absent = a new file). */
  fileId?: Uuid;
  /** CAS on replace: the digest the caller last saw. */
  ifRevision?: string;
  mutationId?: Uuid;
}

/** Anything the SDK can upload from. */
export type UploadSource = Uint8Array | Blob | ArrayBuffer;

async function sliceBytes(src: UploadSource, start: number, end: number): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return src.subarray(start, end);
  if (src instanceof ArrayBuffer) return new Uint8Array(src, start, end - start);
  return new Uint8Array(await src.slice(start, end).arrayBuffer());
}

function sizeOf(src: UploadSource): number {
  if (src instanceof Uint8Array || src instanceof ArrayBuffer) return src.byteLength;
  return src.size;
}

export class FilesApi {
  private progress = new Map<Uuid | number, (p: TransferProgress) => void>();
  private streams = new Map<number, { onChunk(c: FileChunk): void; onEnd(e?: Error): void }>();
  private wired = new WeakSet<Session>();
  private opening = 0;
  private early = new Map<number, FileChunk[]>();

  constructor(private client: MdbaseClient) {
    client.onSession((s) => this.wire(s));
  }

  private wire(s: Session): void {
    if (this.wired.has(s)) return;
    this.wired.add(s);
    s.onPush("transfer_progress", (p) => {
      try {
        const t = transferProgress.dec(p);
        this.progress.get(t.id)?.(t);
      } catch {
        // ignore
      }
    });
    s.onPush("file_chunk", (p) => {
      try {
        const c = fileChunk.dec(p);
        const st = this.streams.get(c.stream);
        if (st) st.onChunk(c);
        else if (this.opening > 0) {
          // Chunks can overtake the `read_file` response. The replica sends at most
          // 8 MiB unacknowledged per stream (§10.2); hold no more than that.
          const q = this.early.get(c.stream) ?? [];
          const held = q.reduce((n, x) => n + x.bytes.length, 0);
          if (held + c.bytes.length <= EARLY_CHUNK_BYTES && this.early.size < 16) {
            q.push(c);
            this.early.set(c.stream, q);
          }
        }
      } catch {
        // ignore
      }
    });
    s.onClose((e) => {
      for (const st of this.streams.values()) st.onEnd(e ?? mdbaseError("unavailable", "connection closed"));
      this.streams.clear();
    });
  }

  private async session(signal?: AbortSignal, read = false): Promise<Session> {
    const s = await (read ? this.client.readyForRead(signal) : this.client.ready(signal));
    this.wire(s);
    return s;
  }

  /** One page of the files in a folder. */
  listPage(
    o: { folder?: string; media?: MediaClass[]; cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ListFilesResult> {
    return this.client.call(
      "list_files",
      m([
        [0, o.folder],
        [1, o.media?.map((x) => mediaClass.enc(x))],
        [2, o.cursor],
        [3, o.limit],
      ]),
      { codec: listFilesResult, retry: true, ...(o.signal ? { signal: o.signal } : {}) },
    );
  }

  /** Every file in a folder (all pages). */
  async *list(
    o: { folder?: string; media?: MediaClass[]; pageSize?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<FileView> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listPage({
        ...o,
        ...(cursor ? { cursor } : {}),
        ...(o.pageSize ? { limit: o.pageSize } : {}),
      });
      yield* page.files;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  get(f: FileRef, signal?: AbortSignal): Promise<FileView> {
    return this.client.call("get_file", m([[0, fileRef(f)]]), {
      codec: fileView,
      retry: true,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Upload a file. Resumable: on a dropped link it reconnects and sends only the chunks
   * the replica lacks. Returns the `file_put` write: `confirmed` means the bytes are
   * durable in the collection.
   */
  async upload(path: string, source: UploadSource, o: UploadOptions = {}): Promise<Write> {
    const size = sizeOf(source);
    // The client's digest commitment, checked by the replica at commit.
    const h = sha256.create();
    const step = 4 * 1024 * 1024;
    for (let off = 0; off < size; off += step) h.update(await sliceBytes(source, off, Math.min(size, off + step)));
    const digest = hashFromBytes(h.digest());
    const transfer = o.transferId ?? uuidv7();
    const open: OpenUploadParams = { transfer, path, size, digest, mutationId: o.mutationId ?? uuidv7() };
    if (o.fileId) open.fileId = o.fileId;
    if (o.ifRevision) open.ifRevision = o.ifRevision;
    if (o.onProgress) this.progress.set(transfer, o.onProgress);
    for (;;) {
      try {
        return await this.uploadOnce(source, size, open, o);
      } catch (e) {
        // Retry after a dropped link; the transfer survives on the replica.
        if (!(isMdbaseError(e, "unavailable") && this.client.link === "reconnecting")) {
          this.progress.delete(transfer);
          throw e;
        }
      }
    }
  }

  private async uploadOnce(source: UploadSource, size: number, open: OpenUploadParams, o: UploadOptions): Promise<Write> {
    const s = await this.session(o.signal);
    const sig = o.signal ? { signal: o.signal } : {};
    const opened = await s.request("open_upload", openUploadParams.enc(open), { codec: openUploadResult, ...sig });
    const have = new Set(opened.received);
    const chunks = Math.max(1, Math.ceil(size / opened.chunkSize));
    let done = have.size * opened.chunkSize;
    // A few chunks in flight keeps the link busy without unbounded buffering.
    const inflight = new Set<Promise<void>>();
    for (let i = 0; i < chunks; i++) {
      if (have.has(i)) continue;
      const start = i * opened.chunkSize;
      const bytes = await sliceBytes(source, start, Math.min(size, start + opened.chunkSize));
      const p = s
        .request("upload_chunk", uploadChunkParams.enc({ transfer: open.transfer, index: i, bytes }), sig)
        .then(() => {
          done += bytes.length;
          o.onProgress?.({ id: open.transfer, phase: "receiving", done: Math.min(done, size), total: size });
        });
      inflight.add(p);
      void p.finally(() => inflight.delete(p)).catch(() => {});
      if (inflight.size >= 4) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    const r = await s.request("commit_upload", m([[0, uuidCodec.enc(open.transfer)]]), {
      codec: receiptCodec,
      ...sig,
    });
    const w = this.client._track(r);
    if (o.onProgress) {
      void w.confirmed.finally(() => this.progress.delete(open.transfer)).catch(() => {});
    } else {
      this.progress.delete(open.transfer);
    }
    return w;
  }

  /** Abort an upload; the replica discards its chunks. */
  abortUpload(transferId: Uuid): Promise<void> {
    return this.client.call("abort_upload", m([[0, uuidCodec.enc(transferId)]])).then(() => {});
  }

  /**
   * Stream a file's bytes, pinned to one revision. Chunks arrive in order; the stream
   * closes only after the replica verified the whole-file digest.
   */
  downloadStream(
    f: FileRef,
    o: {
      signal?: AbortSignal;
      onProgress?: (p: TransferProgress) => void;
      range?: [offset: number, length: number];
      revision?: string;
    } = {},
  ): ReadableStream<Uint8Array> & { file: Promise<FileView> } {
    let streamId: number | null = null;
    let session: Session | null = null;
    let fileResolve!: (f: FileView) => void;
    let fileReject!: (e: unknown) => void;
    const file = new Promise<FileView>((res, rej) => ((fileResolve = res), (fileReject = rej)));
    file.catch(() => {});
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        try {
          session = await self.session(o.signal, true);
          const p = m([[0, fileRef(f)]]);
          if (o.range) p.set(1, [o.range[0], o.range[1]]);
          if (o.revision) p.set(2, hashCodec.enc(o.revision));
          // Register before requesting: chunks may arrive right after the response.
          let total = 0;
          let received = 0;
          self.opening++;
          let r: Map<number, CborValue>;
          try {
            r = (await session.request("read_file", p, o.signal ? { signal: o.signal } : {})) as Map<number, CborValue>;
          } finally {
            self.opening--;
          }
          streamId = uint.dec(r.get(0) ?? null);
          const early = self.early.get(streamId) ?? [];
          self.early.delete(streamId);
          if (self.opening === 0) self.early.clear();
          const view = fileView.dec(r.get(1) ?? null);
          fileResolve(view);
          total = o.range ? o.range[1] : view.size;
          const deliver = (c: FileChunk) => {
            ctrl.enqueue(c.bytes);
            received += c.bytes.length;
            o.onProgress?.({ id: streamId!, phase: "streaming", done: received, total });
            void session!.request("ack_chunks", m([[0, streamId!], [1, c.offset + c.bytes.length]])).catch(() => {});
            if (c.last) {
              self.streams.delete(streamId!);
              ctrl.close();
            }
          };
          self.streams.set(streamId, {
            onChunk: deliver,
            onEnd: (e) => ctrl.error(e ?? mdbaseError("unavailable", "stream ended")),
          });
          for (const c of early) deliver(c);
        } catch (e) {
          fileReject(e);
          ctrl.error(e);
        }
      },
      cancel() {
        if (streamId !== null) {
          self.streams.delete(streamId);
          // Cancelling read_file's stream: tell the replica to stop.
          void session?.request("cancel_stream", m([[0, streamId]])).catch(() => {});
        }
      },
    });
    return Object.assign(stream, { file });
  }

  /** The whole file as bytes (at most 64 MiB; larger files use `downloadStream`). */
  async download(f: FileRef, o: { signal?: AbortSignal; onProgress?: (p: TransferProgress) => void } = {}): Promise<Uint8Array> {
    const view = typeof f === "object" && "size" in f ? f : await this.get(f, o.signal);
    if (view.size > MAX_CONVENIENCE_BYTES) {
      throw mdbaseError("too_large", `file is ${view.size} bytes; use downloadStream`, {
        details: new Map([["limit", MAX_CONVENIENCE_BYTES]]),
      });
    }
    const out = new Uint8Array(view.size);
    let off = 0;
    const reader = this.downloadStream(view, o).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, off);
      off += value.length;
    }
    return out.subarray(0, off);
  }

  /** Materialize a remote file on this device. */
  fetch(f: FileRef, signal?: AbortSignal): Promise<void> {
    return this.client
      .call("fetch_file", m([[0, uuidCodec.enc(fileId(f))]]), { retry: true, ...(signal ? { signal } : {}) })
      .then(() => {});
  }

  /** Drop the local copy of a confirmed, unheld file (hosting app only). */
  evict(f: FileRef): Promise<void> {
    return this.client.call("evict_file", m([[0, uuidCodec.enc(fileId(f))]])).then(() => {});
  }

  getMaterialization(): Promise<Materialization> {
    return this.client.call("get_materialization", null, { codec: materialization, retry: true });
  }

  setMaterialization(v: Materialization): Promise<void> {
    return this.client.call("set_materialization", materialization.enc(v)).then(() => {});
  }

  /** Move a file; `updateRefs` rewrites links to it. */
  async move(
    f: FileView,
    to: string,
    o: WriteOptions & { updateRefs?: boolean; ifRevision?: string } = {},
  ): Promise<Write> {
    const op = { kind: "file_move" as const, id: f.id, from: f.path, to, updateRefs: o.updateRefs ?? true };
    const [w] = await this.client.submit([o.ifRevision ? { ...op, ifRevision: o.ifRevision } : op], o);
    return w!;
  }

  /** Delete a file. With a FileView, a concurrent replacement supersedes the delete. */
  async delete(f: FileRef, o: WriteOptions & { ifRevision?: string } = {}): Promise<Write> {
    const op: import("./wire.js").Op = { kind: "file_delete", id: fileId(f) };
    if (typeof f === "object" && "digest" in f) op.base = f.digest;
    if (o.ifRevision) op.ifRevision = o.ifRevision;
    const [w] = await this.client.submit([op], o);
    return w!;
  }
}

export { list };

import type {
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  DeleteFileReceipt,
  FileCapability,
  FileTransferSession,
  ListFilesPage,
  MoveFileReceipt,
  PreparedFilePart,
  UploadedFilePart
} from "@mdbase/connect-protocol";
import { FILE_PROTOCOL_VERSION } from "@mdbase/connect-protocol";
import { MdbaseConnectError, connectError } from "./errors.js";
import { IncrementalSha256 } from "./file-sha256.js";

const HASH_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_OBJECT_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type MdbaseFileSource = Blob | ArrayBuffer | ArrayBufferView;

export interface MdbaseFileProgress {
  phase: "hashing" | "uploading" | "downloading";
  transferredBytes: number;
  totalBytes: number;
}

export interface MdbaseFileListOptions {
  folder?: string;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface MdbaseFileUploadOptions {
  mediaType?: string;
  ifRevision?: string;
  concurrency?: number;
  /** Stable retry key. Reuse it after an ambiguous failure to resume or replay commit. */
  transferId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: MdbaseFileProgress) => void;
}

export interface MdbaseFileDownloadOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: MdbaseFileProgress) => void;
}

export interface MdbaseFileMoveOptions {
  ifRevision?: string;
  /** Reuse after an ambiguous network failure to receive the original receipt. */
  mutationId?: string;
  signal?: AbortSignal;
}

export interface MdbaseFileDeleteOptions {
  ifRevision?: string;
  /** Reuse after an ambiguous network failure to receive the original receipt. */
  mutationId?: string;
  signal?: AbortSignal;
}

/** Internal transport seam used by direct and relayed encrypted chunk delivery. */
export interface MdbaseFramedFileTransport {
  uploadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void>;
  downloadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    signal?: AbortSignal
  ): Promise<Uint8Array>;
}

type ControlRequest = <Result>(
  method: "GET" | "POST" | "DELETE",
  path?: string,
  input?: unknown,
  signal?: AbortSignal
) => Promise<Result>;

/** Ergonomic facade over resumable, authority-specific file delivery. */
export class MdbaseFileClient {
  constructor(
    private readonly capability: () => FileCapability | null,
    private readonly request: ControlRequest,
    private readonly framed?: MdbaseFramedFileTransport
  ) {}

  async *list(options: MdbaseFileListOptions = {}): AsyncGenerator<CollectionFileDescriptor> {
    this.requireAction("list");
    let after: string | undefined;
    do {
      throwIfAborted(options.signal);
      const query = new URLSearchParams({
        protocol_version: String(FILE_PROTOCOL_VERSION),
        ...(options.folder ? { folder: options.folder } : {}),
        ...(after ? { after } : {}),
        ...(options.pageSize ? { limit: String(validPageSize(options.pageSize)) } : {})
      });
      const page = await this.request<ListFilesPage>(
        "GET",
        `?${query.toString()}`,
        undefined,
        options.signal
      );
      if (page.protocol_version !== 1 || page.type !== "files_page" || !Array.isArray(page.files)) {
        throw connectError("invalid_operation_response", "The authority returned an invalid file page.");
      }
      for (const file of page.files) {
        throwIfAborted(options.signal);
        yield file;
      }
      after = page.next;
    } while (after);
  }

  async upload(
    path: string,
    source: MdbaseFileSource,
    options: MdbaseFileUploadOptions = {}
  ): Promise<CollectionFileDescriptor> {
    this.requireAction(options.ifRevision ? "replace" : "add");
    const blob = sourceBlob(source, options.mediaType);
    const concurrency = validConcurrency(options.concurrency);
    const digest = await hashBlob(blob, options.signal, (transferredBytes) => {
      options.onProgress?.({
        phase: "hashing",
        transferredBytes,
        totalBytes: blob.size
      });
    });
    const transferId = options.transferId ?? crypto.randomUUID();
    if (!UUID.test(transferId)) {
      throw connectError("invalid_request", "File transfer ID must be a UUID.");
    }
    let committed = false;
    try {
      const session = await this.request<FileTransferSession>(
        "POST",
        "uploads",
        {
          protocol_version: FILE_PROTOCOL_VERSION,
          type: "open_file_upload",
          transfer_id: transferId,
          path,
          size: blob.size,
          content_digest: `sha256:${digest}`,
          ...(options.mediaType || blob.type
            ? { media_type: options.mediaType ?? blob.type }
            : {}),
          ...(options.ifRevision ? { if_revision: options.ifRevision } : {})
        },
        options.signal
      );
      requireTransferSession(session, transferId, "upload");
      if (session.total_size !== blob.size || session.strategy.kind === "object_ranges") {
        throw connectError("invalid_operation_response", "The authority returned an incompatible upload strategy.");
      }
      const framed = session.strategy.kind === "framed_chunks";
      if (framed && !this.framed) {
        throw connectError("invalid_operation_response", "Encrypted file chunk delivery is unavailable.");
      }
      const partSize = session.strategy.kind === "object_put"
        ? Math.max(1, blob.size)
        : session.strategy.kind === "framed_chunks"
          ? session.strategy.chunk_size
          : session.strategy.part_size;
      const partCount = session.strategy.kind === "object_put"
        ? 1
        : Math.ceil(blob.size / partSize);
      if (!framed && session.received.length === partCount) {
        const replay = await this.tryReplayUploadCommit(
          transferId,
          session.strategy.kind === "object_multipart" ? session.uploaded_parts : undefined,
          options.signal
        );
        if (replay) {
          committed = true;
          return replay.file;
        }
      }
      const received = new Set(session.received);
      const uploadedParts = new Map(
        (session.uploaded_parts ?? []).map((part) => [part.part_number - 1, part])
      );
      let transferredBytes = [...received].reduce(
        (total, index) => total + chunkLength(blob.size, partSize, index),
        0
      );
      const parts = await mapConcurrent(partCount, concurrency, async (partIndex) => {
        const offset = partIndex * partSize;
        const length = Math.min(partSize, Math.max(0, blob.size - offset));
        if (received.has(partIndex)) return uploadedParts.get(partIndex) ?? null;
        const part = blob.slice(offset, offset + length);
        const uploaded = framed
          ? await retryChunk(
            async () => this.framed!.uploadChunk(
              session,
              partIndex,
              new Uint8Array(await part.arrayBuffer()),
              options.signal
            ),
            options.signal
          ).then(() => null)
          : await this.uploadPart(
            transferId,
            partIndex,
            offset,
            part,
            length,
            session.strategy.kind === "object_multipart",
            options.signal
          );
        transferredBytes += length;
        options.onProgress?.({
          phase: "uploading",
          transferredBytes,
          totalBytes: blob.size
        });
        return uploaded;
      });
      const receipt = await this.commitUpload(
        transferId,
        session.strategy.kind === "object_multipart"
          ? parts.filter((part): part is UploadedFilePart => part !== null)
          : undefined,
        options.signal
      );
      if (
        receipt.protocol_version !== 1
        || receipt.type !== "file_upload_committed"
        || receipt.transfer_id !== transferId
      ) {
        throw connectError("invalid_operation_response", "The authority returned an invalid file receipt.");
      }
      committed = true;
      return receipt.file;
    } catch (error) {
      throw normalizeFileError(error);
    } finally {
      if (!committed && options.transferId === undefined) await this.abort(transferId);
    }
  }

  async download(
    file: CollectionFileDescriptor,
    options: MdbaseFileDownloadOptions = {}
  ): Promise<Blob> {
    this.requireAction("read");
    const concurrency = validConcurrency(options.concurrency);
    const transferId = crypto.randomUUID();
    try {
      const session = await this.request<FileTransferSession>(
        "POST",
        "downloads",
        {
          protocol_version: FILE_PROTOCOL_VERSION,
          type: "open_file_download",
          transfer_id: transferId,
          file_id: file.file_id,
          revision: file.revision
        },
        options.signal
      );
      requireTransferSession(session, transferId, "download");
      if (
        session.total_size !== file.size
        || (session.strategy.kind !== "object_ranges"
          && session.strategy.kind !== "framed_chunks")
      ) {
        throw connectError("invalid_operation_response", "The authority returned an incompatible download session.");
      }
      const framed = session.strategy.kind === "framed_chunks";
      if (framed && !this.framed) {
        throw connectError("invalid_operation_response", "Encrypted file chunk delivery is unavailable.");
      }
      const partSize = session.strategy.kind === "framed_chunks"
        ? session.strategy.chunk_size
        : session.strategy.part_size;
      const partCount = Math.ceil(file.size / partSize);
      let transferredBytes = 0;
      const chunks = await mapConcurrent(partCount, concurrency, async (partIndex) => {
        const offset = partIndex * partSize;
        const length = Math.min(partSize, file.size - offset);
        const chunk = framed
          ? await retryChunk(
            () => this.framed!.downloadChunk(session, partIndex, options.signal),
            options.signal
          )
          : await this.downloadPart(
            transferId,
            partIndex,
            offset,
            length,
            options.signal
          );
        if (chunk.byteLength !== length) {
          throw connectError("invalid_operation_response", "A file chunk had the wrong byte length.");
        }
        transferredBytes += chunk.byteLength;
        options.onProgress?.({
          phase: "downloading",
          transferredBytes,
          totalBytes: file.size
        });
        return chunk;
      });
      const hash = new IncrementalSha256();
      let receivedBytes = 0;
      for (const chunk of chunks) {
        hash.update(chunk);
        receivedBytes += chunk.byteLength;
      }
      if (receivedBytes !== file.size || `sha256:${hash.digestHex()}` !== file.content_digest) {
        throw connectError("invalid_operation_response", "Downloaded file bytes failed integrity verification.");
      }
      return new Blob(
        chunks.map((chunk) => {
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          return copy.buffer;
        }),
        { type: file.media_type ?? "" }
      );
    } catch (error) {
      throw normalizeFileError(error);
    } finally {
      await this.abort(transferId);
    }
  }

  async downloadBytes(
    file: CollectionFileDescriptor,
    options: MdbaseFileDownloadOptions = {}
  ): Promise<Uint8Array> {
    return new Uint8Array(await (await this.download(file, options)).arrayBuffer());
  }

  async move(
    file: CollectionFileDescriptor,
    path: string,
    options: MdbaseFileMoveOptions = {}
  ): Promise<CollectionFileDescriptor> {
    this.requireAction("move");
    const mutationId = options.mutationId ?? crypto.randomUUID();
    let receipt: MoveFileReceipt;
    try {
      receipt = await this.request<MoveFileReceipt>(
        "POST",
        `${encodeURIComponent(file.file_id)}/move`,
        {
          protocol_version: FILE_PROTOCOL_VERSION,
          type: "move_file",
          mutation_id: mutationId,
          file_id: file.file_id,
          if_revision: options.ifRevision ?? file.revision,
          from_path: file.path,
          path,
          // Reserved for a future protocol that can update record links
          // atomically with a file move. Protocol v1 must remain false.
          update_references: false
        },
        options.signal
      );
    } catch (error) {
      throw normalizeFileError(error);
    }
    if (
      receipt.protocol_version !== 1
      || receipt.type !== "file_moved"
      || receipt.mutation_id !== mutationId
      || receipt.file.file_id !== file.file_id
      || receipt.file.path !== path
    ) {
      throw connectError("invalid_operation_response", "The authority returned an invalid file move receipt.");
    }
    return receipt.file;
  }

  async delete(
    file: CollectionFileDescriptor,
    options: MdbaseFileDeleteOptions = {}
  ): Promise<DeleteFileReceipt> {
    this.requireAction("delete");
    const mutationId = options.mutationId ?? crypto.randomUUID();
    let receipt: DeleteFileReceipt;
    try {
      receipt = await this.request<DeleteFileReceipt>(
        "POST",
        `${encodeURIComponent(file.file_id)}/delete`,
        {
          protocol_version: FILE_PROTOCOL_VERSION,
          type: "delete_file",
          mutation_id: mutationId,
          file_id: file.file_id,
          if_revision: options.ifRevision ?? file.revision,
          path: file.path
        },
        options.signal
      );
    } catch (error) {
      throw normalizeFileError(error);
    }
    if (
      receipt.protocol_version !== 1
      || receipt.type !== "file_deleted"
      || receipt.mutation_id !== mutationId
      || receipt.file_id !== file.file_id
      || receipt.previous_path !== file.path
    ) {
      throw connectError("invalid_operation_response", "The authority returned an invalid file delete receipt.");
    }
    return receipt;
  }

  private async uploadPart(
    transferId: string,
    partIndex: number,
    offset: number,
    body: Blob,
    contentLength: number,
    requireEtag: boolean,
    signal?: AbortSignal
  ): Promise<UploadedFilePart> {
    for (let attempt = 1; attempt <= MAX_OBJECT_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        const prepared = await this.request<PreparedFilePart>(
          "POST",
          `uploads/${encodeURIComponent(transferId)}/parts`,
          {
            protocol_version: FILE_PROTOCOL_VERSION,
            type: "prepare_file_upload_part",
            transfer_id: transferId,
            part_number: partIndex + 1,
            content_length: contentLength
          },
          signal
        );
        requirePreparedPart(prepared, transferId, partIndex, offset, contentLength, "PUT");
        const response = await fetch(prepared.url, {
          method: prepared.method,
          headers: browserObjectHeaders(prepared.headers),
          body,
          redirect: "error",
          signal
        });
        if (!response.ok) throw new Error(`Object upload failed with HTTP ${response.status}.`);
        const etag = response.headers.get("etag");
        if (requireEtag && !etag) {
          throw new Error("Multipart object upload did not return an ETag.");
        }
        return { part_number: partIndex + 1, etag: etag ?? "" };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt === MAX_OBJECT_ATTEMPTS) throw error;
      }
    }
    throw new Error("Unreachable upload retry state.");
  }

  private async tryReplayUploadCommit(
    transferId: string,
    parts: UploadedFilePart[] | undefined,
    signal?: AbortSignal
  ): Promise<CommitFileUploadReceipt | null> {
    try {
      return await this.commitUpload(transferId, parts, signal);
    } catch (error) {
      if (error instanceof MdbaseConnectError && error.code === "file_upload_incomplete") {
        return null;
      }
      throw error;
    }
  }

  private async commitUpload(
    transferId: string,
    parts: UploadedFilePart[] | undefined,
    signal?: AbortSignal
  ): Promise<CommitFileUploadReceipt> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_OBJECT_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await this.request<CommitFileUploadReceipt>(
          "POST",
          `uploads/${encodeURIComponent(transferId)}/commit`,
          {
            protocol_version: FILE_PROTOCOL_VERSION,
            type: "commit_file_upload",
            transfer_id: transferId,
            ...(parts === undefined ? {} : { parts })
          },
          signal
        );
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error instanceof MdbaseConnectError || attempt === MAX_OBJECT_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async downloadPart(
    transferId: string,
    partIndex: number,
    offset: number,
    contentLength: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    for (let attempt = 1; attempt <= MAX_OBJECT_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        const prepared = await this.request<PreparedFilePart>(
          "POST",
          `downloads/${encodeURIComponent(transferId)}/parts`,
          {
            protocol_version: FILE_PROTOCOL_VERSION,
            type: "prepare_file_download_part",
            transfer_id: transferId,
            part_index: partIndex
          },
          signal
        );
        requirePreparedPart(prepared, transferId, partIndex, offset, contentLength, "GET");
        const response = await fetch(prepared.url, {
          method: prepared.method,
          headers: browserObjectHeaders(prepared.headers),
          redirect: "error",
          signal
        });
        if (!response.ok) throw new Error(`Object download failed with HTTP ${response.status}.`);
        const chunk = new Uint8Array(await response.arrayBuffer());
        if (chunk.byteLength !== prepared.content_length) {
          throw new Error("Object download returned the wrong byte length.");
        }
        return chunk;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt === MAX_OBJECT_ATTEMPTS) throw error;
      }
    }
    throw new Error("Unreachable download retry state.");
  }

  private requireAction(action: FileCapability["actions"][number]): void {
    if (!this.capability()?.actions.includes(action)) {
      throw connectError("not_authorized", `This connection is not authorized to ${action} files.`);
    }
  }

  private async abort(transferId: string): Promise<void> {
    await this.request(
      "DELETE",
      `transfers/${encodeURIComponent(transferId)}`
    ).catch(() => undefined);
  }
}

async function hashBlob(
  blob: Blob,
  signal: AbortSignal | undefined,
  progress: (transferredBytes: number) => void
): Promise<string> {
  const hash = new IncrementalSha256();
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    throwIfAborted(signal);
    const chunk = new Uint8Array(
      await blob.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer()
    );
    hash.update(chunk);
    progress(Math.min(blob.size, offset + chunk.byteLength));
  }
  if (blob.size === 0) progress(0);
  return hash.digestHex();
}

function sourceBlob(source: MdbaseFileSource, mediaType?: string): Blob {
  if (source instanceof Blob) {
    return mediaType && mediaType !== source.type
      ? source.slice(0, source.size, mediaType)
      : source;
  }
  if (source instanceof ArrayBuffer) return new Blob([source], { type: mediaType });
  const copy = new Uint8Array(source.byteLength);
  copy.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  return new Blob([copy.buffer], { type: mediaType });
}

function validConcurrency(value = DEFAULT_CONCURRENCY): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw connectError("invalid_request", `File concurrency must be between 1 and ${MAX_CONCURRENCY}.`);
  }
  return value;
}

function validPageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw connectError("invalid_request", "File page size must be between 1 and 1000.");
  }
  return value;
}

function requireTransferSession(
  session: FileTransferSession,
  transferId: string,
  direction: "upload" | "download"
): void {
  if (
    session.protocol_version !== 1
    || session.type !== "file_transfer"
    || session.transfer_id !== transferId
    || session.direction !== direction
    || !Number.isSafeInteger(session.total_size)
    || session.total_size < 0
    || !Array.isArray(session.received)
    || !validTransferStrategy(session)
  ) {
    throw connectError("invalid_operation_response", "The authority returned an invalid file transfer session.");
  }
  const partSize = session.strategy.kind === "framed_chunks"
    ? session.strategy.chunk_size
    : session.strategy.kind === "object_put"
      ? Math.max(1, session.total_size)
      : session.strategy.part_size;
  const partCount = session.strategy.kind === "object_put"
    ? 1
    : Math.ceil(session.total_size / partSize);
  if (new Set(session.received).size !== session.received.length
      || session.received.some((index) =>
        !Number.isSafeInteger(index) || index < 0 || index >= partCount)) {
    throw connectError("invalid_operation_response", "The authority returned invalid transfer progress.");
  }
  const uploadedParts = session.uploaded_parts ?? [];
  if (
    !Array.isArray(uploadedParts)
    || uploadedParts.some((part, index) =>
      !Number.isSafeInteger(part?.part_number)
      || part.part_number < 1
      || part.part_number > partCount
      || typeof part.etag !== "string"
      || part.etag.length === 0
      || part.etag.length > 255
      || (index > 0 && uploadedParts[index - 1]!.part_number >= part.part_number))
    || (session.strategy.kind === "object_multipart"
      ? uploadedParts.length !== session.received.length
        || uploadedParts.some((part, index) => part.part_number - 1 !== session.received[index])
      : uploadedParts.length !== 0)
  ) {
    throw connectError("invalid_operation_response", "The authority returned invalid uploaded part receipts.");
  }
}

function validTransferStrategy(session: FileTransferSession): boolean {
  if (session.strategy.kind === "framed_chunks") {
    return session.protection === "grant_aead_v1"
      && Number.isSafeInteger(session.strategy.chunk_size)
      && session.strategy.chunk_size > 0;
  }
  if (session.protection !== "transport_tls") return false;
  if (session.strategy.kind === "object_put") return true;
  return Number.isSafeInteger(session.strategy.part_size) && session.strategy.part_size > 0;
}

function chunkLength(totalSize: number, partSize: number, index: number): number {
  return Math.min(partSize, Math.max(0, totalSize - index * partSize));
}

async function retryChunk<Result>(
  work: () => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> {
  for (let attempt = 1; attempt <= MAX_OBJECT_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await work();
    } catch (error) {
      if (signal?.aborted || attempt === MAX_OBJECT_ATTEMPTS) throw error;
    }
  }
  throw new Error("Unreachable file chunk retry state.");
}

function requirePreparedPart(
  part: PreparedFilePart,
  transferId: string,
  partIndex: number,
  offset: number,
  contentLength: number,
  method: "GET" | "PUT"
): void {
  let url: URL;
  try {
    url = new URL(part.url);
  } catch {
    throw connectError("invalid_operation_response", "The authority returned an invalid object URL.");
  }
  if (
    part.protocol_version !== 1
    || part.type !== "file_part"
    || part.transfer_id !== transferId
    || part.part_index !== partIndex
    || part.offset !== offset
    || part.content_length !== contentLength
    || part.method.toUpperCase() !== method
    || url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
    || url.username
    || url.password
  ) {
    throw connectError("invalid_operation_response", "The authority returned an invalid prepared file part.");
  }
}

function browserObjectHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (["host", "content-length"].includes(name.toLowerCase())) continue;
    result.set(name, value);
  }
  return result;
}

async function mapConcurrent<Result>(
  count: number,
  concurrency: number,
  work: (index: number) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      results[index] = await work(index);
    }
  }));
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw connectError("operation_cancelled", "The file transfer was cancelled.", {
      operationOutcome: "not_sent",
      cause: signal.reason
    });
  }
}

function normalizeFileError(error: unknown): MdbaseConnectError {
  if (error instanceof MdbaseConnectError) return error;
  if (typeof DOMException !== "undefined"
      && error instanceof DOMException
      && error.name === "AbortError") {
    return connectError("operation_cancelled", "The file transfer was cancelled.", {
      operationOutcome: "not_sent",
      cause: error
    });
  }
  return connectError("temporarily_unavailable", "The file transfer could not be completed.", {
    cause: error
  });
}

import type {
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  FileCapability,
  FileTransferSession,
  ListFilesPage,
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
  signal?: AbortSignal;
  onProgress?: (progress: MdbaseFileProgress) => void;
}

export interface MdbaseFileDownloadOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: MdbaseFileProgress) => void;
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
    private readonly request: ControlRequest
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
    const transferId = crypto.randomUUID();
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
      requireHostedSession(session, transferId, "upload");
      if (
        session.strategy.kind !== "object_put"
        && session.strategy.kind !== "object_multipart"
      ) {
        throw connectError("invalid_operation_response", "The authority returned an incompatible upload strategy.");
      }
      const partSize = session.strategy.kind === "object_put"
        ? Math.max(1, blob.size)
        : session.strategy.part_size;
      const partCount = session.strategy.kind === "object_put"
        ? 1
        : Math.ceil(blob.size / partSize);
      let transferredBytes = 0;
      const parts = await mapConcurrent(partCount, concurrency, async (partIndex) => {
        const offset = partIndex * partSize;
        const length = Math.min(partSize, Math.max(0, blob.size - offset));
        const uploaded = await this.uploadPart(
          transferId,
          partIndex,
          offset,
          blob.slice(offset, offset + length),
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
      const receipt = await this.request<CommitFileUploadReceipt>(
        "POST",
        `uploads/${encodeURIComponent(transferId)}/commit`,
        {
          protocol_version: FILE_PROTOCOL_VERSION,
          type: "commit_file_upload",
          transfer_id: transferId,
          ...(session.strategy.kind === "object_multipart" ? { parts } : {})
        },
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
      if (!committed) await this.abort(transferId);
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
      requireHostedSession(session, transferId, "download");
      if (session.total_size !== file.size || session.strategy.kind !== "object_ranges") {
        throw connectError("invalid_operation_response", "The authority returned an incompatible download session.");
      }
      const partSize = session.strategy.part_size;
      const partCount = Math.ceil(file.size / partSize);
      let transferredBytes = 0;
      const chunks = await mapConcurrent(partCount, concurrency, async (partIndex) => {
        const offset = partIndex * partSize;
        const length = Math.min(partSize, file.size - offset);
        const chunk = await this.downloadPart(
          transferId,
          partIndex,
          offset,
          length,
          options.signal
        );
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

function requireHostedSession(
  session: FileTransferSession,
  transferId: string,
  direction: "upload" | "download"
): void {
  if (
    session.protocol_version !== 1
    || session.type !== "file_transfer"
    || session.transfer_id !== transferId
    || session.direction !== direction
    || session.protection !== "transport_tls"
    || !["object_put", "object_multipart", "object_ranges"].includes(session.strategy.kind)
  ) {
    throw connectError("invalid_operation_response", "The authority returned an invalid file transfer session.");
  }
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

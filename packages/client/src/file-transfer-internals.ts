import type {
  FileTransferSession,
  FileTransferStatus,
  PreparedFilePart
} from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectError } from "./errors.js";
import { IncrementalSha256 } from "./file-sha256.js";

const HASH_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
export const MAX_OBJECT_ATTEMPTS = 3;
export const MAX_BUFFERED_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type FileSource = Blob | ArrayBuffer | ArrayBufferView;
export type UploadPartBody = Blob | Uint8Array<ArrayBuffer>;

export async function hashBlob(
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

export function sourceBlob(source: FileSource, mediaType?: string): Blob {
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

export function uploadBodyLength(body: UploadPartBody): number {
  return body instanceof Blob ? body.size : body.byteLength;
}

export async function uploadBodyBytes(
  body: UploadPartBody
): Promise<Uint8Array<ArrayBuffer>> {
  return body instanceof Blob
    ? new Uint8Array(await body.arrayBuffer())
    : body;
}

export function validConcurrency(value = DEFAULT_CONCURRENCY): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw connectError("invalid_request", `File concurrency must be between 1 and ${MAX_CONCURRENCY}.`);
  }
  return value;
}

export function validPageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw connectError("invalid_request", "File page size must be between 1 and 1000.");
  }
  return value;
}

export function requireTransferSession(
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

export function requireTransferStatus(
  status: FileTransferStatus,
  session: FileTransferSession
): void {
  const partSize = session.strategy.kind === "framed_chunks"
    ? session.strategy.chunk_size
    : session.strategy.kind === "object_put"
      ? Math.max(1, session.total_size)
      : session.strategy.part_size;
  const partCount = session.strategy.kind === "object_put"
    ? 1
    : Math.ceil(session.total_size / partSize);
  if (
    status?.protocol_version !== 1
    || status.type !== "file_transfer_status"
    || status.transfer_id !== session.transfer_id
    || !["open", "committed", "aborted", "expired"].includes(status.state)
    || !Array.isArray(status.received)
    || new Set(status.received).size !== status.received.length
    || status.received.some((index) =>
      !Number.isSafeInteger(index) || index < 0 || index >= partCount)
    || !Number.isSafeInteger(status.received_bytes)
    || status.received_bytes < 0
    || status.received_bytes > session.total_size
    || status.received.reduce(
      (total, index) => total + chunkLength(session.total_size, partSize, index),
      0
    ) !== status.received_bytes
  ) {
    throw connectError("invalid_operation_response", "The authority returned invalid transfer status.");
  }
  const uploadedParts = status.uploaded_parts;
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
      ? uploadedParts.length !== status.received.length
        || uploadedParts.some((part, index) => part.part_number - 1 !== status.received[index])
      : uploadedParts.length !== 0)
  ) {
    throw connectError("invalid_operation_response", "The authority returned invalid uploaded part status.");
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

export function chunkLength(totalSize: number, partSize: number, index: number): number {
  return Math.min(partSize, Math.max(0, totalSize - index * partSize));
}

export async function retryChunk<Result>(
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

export function requirePreparedPart(
  part: PreparedFilePart,
  transferId: string,
  partIndex: number,
  offset: number,
  contentLength: number,
  method: "PUT"
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

export function browserObjectHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (["host", "content-length"].includes(name.toLowerCase())) continue;
    result.set(name, value);
  }
  return result;
}

export async function mapConcurrent<Result>(
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

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw connectError("operation_cancelled", "The file transfer was cancelled.", {
      operationOutcome: "not_sent",
      cause: signal.reason
    });
  }
}

export function normalizeFileError(error: unknown): MdbaseConnectError {
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

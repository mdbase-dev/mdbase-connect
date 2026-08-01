import type {
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  FileTransferSession,
  PreparedFilePart,
  UploadedFilePart
} from "@mdbase-dev/connect-protocol";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { AuthorityAdoptionError } from "./adoption-errors.js";

const MAX_FILE_PARTS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const utf8 = new TextEncoder();

interface ImportCapability {
  import_id: string;
  files_url: string;
  access_token: string;
}

type FileSource = Blob | ArrayBuffer | ArrayBufferView;

interface UploadOptions {
  signal?: AbortSignal;
  onFileProgress?: (progress: {
    file: CollectionFileDescriptor;
    transferredBytes: number;
    totalBytes: number;
  }) => void;
}

interface ImportRequest {
  url: string;
  method: "POST" | "PUT";
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: boolean;
  signal?: AbortSignal;
}

interface ImportResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Requester = (request: ImportRequest) => Promise<ImportResponse>;

/** Upload one fenced portable-snapshot file directly to object storage. */
export async function uploadAuthorityImportFile(
  request: Requester,
  capability: ImportCapability,
  file: CollectionFileDescriptor,
  source: FileSource,
  options: UploadOptions
): Promise<void> {
  const blob = fileBlob(source, file.media_type);
  if (blob.size !== file.size || await blobDigest(blob, options.signal) !== file.content_digest) {
    throw new AuthorityAdoptionError(
      "authority_adoption_file_changed",
      `File bytes no longer match the fenced snapshot for ${file.path}.`
    );
  }
  const transferId = importTransferId(capability.import_id, file);
  const session = await importJson<FileTransferSession>(
    request,
    `${capability.files_url}/uploads`,
    capability.access_token,
    {
      protocol_version: 1,
      type: "open_authority_import_file_upload",
      transfer_id: transferId,
      file_id: file.file_id
    },
    options.signal
  );
  validateSession(session, transferId, file.size);
  if (session.strategy.kind !== "object_put" && session.strategy.kind !== "object_multipart") {
    throw invalidResponse("Connect returned an incompatible authority import file strategy.");
  }
  const partSize = session.strategy.kind === "object_put"
    ? Math.max(1, file.size)
    : session.strategy.part_size;
  const partCount = session.strategy.kind === "object_put"
    ? 1
    : Math.ceil(file.size / partSize);
  if (partCount > MAX_FILE_PARTS) {
    throw invalidResponse("Authority import returned too many file parts.");
  }
  const received = new Set(session.received);
  const uploadedParts = new Map(
    (session.uploaded_parts ?? []).map((part) => [part.part_number - 1, part])
  );
  if (session.received.length === partCount) {
    const committed = await tryCommit(
      request,
      capability,
      file,
      transferId,
      [...uploadedParts.values()],
      options.signal
    );
    if (committed) return;
  }
  const parts: Array<UploadedFilePart | undefined> = Array(partCount);
  for (const [partIndex, part] of uploadedParts) parts[partIndex] = part;
  let transferredBytes = [...received].reduce(
    (total, index) => total + Math.min(partSize, Math.max(0, file.size - index * partSize)),
    0
  );
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    throwIfAborted(options.signal);
    const offset = partIndex * partSize;
    const contentLength = Math.min(partSize, Math.max(0, file.size - offset));
    if (received.has(partIndex)) continue;
    const prepared = await importJson<PreparedFilePart>(
      request,
      `${capability.files_url}/uploads/${encodeURIComponent(transferId)}/parts`,
      capability.access_token,
      {
        protocol_version: 1,
        type: "prepare_file_upload_part",
        transfer_id: transferId,
        part_number: partIndex + 1,
        content_length: contentLength
      },
      options.signal
    );
    validatePreparedPart(prepared, transferId, partIndex, offset, contentLength);
    const response = await objectRequest(
      request,
      prepared,
      blob.slice(offset, offset + contentLength),
      options.signal
    );
    if (session.strategy.kind === "object_multipart") {
      const etag = response.headers?.etag;
      if (!etag) throw invalidResponse("Object storage omitted a multipart ETag.");
      parts[partIndex] = { part_number: partIndex + 1, etag };
    }
    transferredBytes += contentLength;
    options.onFileProgress?.({ file, transferredBytes, totalBytes: file.size });
  }
  const completionParts = parts.filter((part): part is UploadedFilePart => part !== undefined);
  if (!await tryCommit(request, capability, file, transferId, completionParts, options.signal)) {
    throw new AuthorityAdoptionError(
      "authority_adoption_file_upload_incomplete",
      `Connect could not commit ${file.path}.`
    );
  }
}

async function tryCommit(
  request: Requester,
  capability: ImportCapability,
  file: CollectionFileDescriptor,
  transferId: string,
  parts: UploadedFilePart[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const receipt = await importJson<CommitFileUploadReceipt>(
      request,
      `${capability.files_url}/uploads/${encodeURIComponent(transferId)}/commit`,
      capability.access_token,
      {
        protocol_version: 1,
        type: "commit_file_upload",
        transfer_id: transferId,
        ...(parts.length > 0 ? { parts } : {})
      },
      signal
    );
    if (
      receipt.protocol_version !== 1
      || receipt.type !== "file_upload_committed"
      || receipt.transfer_id !== transferId
      || !sameDescriptor(receipt.file, file)
    ) {
      throw invalidResponse("Connect returned an invalid authority import file receipt.");
    }
    return true;
  } catch (error) {
    if (
      parts.length === 0
      && error instanceof AuthorityAdoptionError
      && error.code === "file_upload_incomplete"
    ) return false;
    throw error;
  }
}

async function importJson<Result>(
  request: Requester,
  url: string,
  accessToken: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Result> {
  let response: ImportResponse;
  try {
    response = await request({
      url,
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body,
      ...(signal ? { signal } : {})
    });
  } catch {
    throwIfAborted(signal);
    throw new AuthorityAdoptionError(
      "authority_adoption_unreachable",
      "Connect could not be reached for collection adoption."
    );
  }
  if (response.status < 200 || response.status >= 300) throw responseError(response);
  return response.body as Result;
}

async function objectRequest(
  request: Requester,
  prepared: PreparedFilePart,
  body: Blob,
  signal?: AbortSignal
): Promise<ImportResponse> {
  validateObjectUrl(prepared.url);
  let response: ImportResponse;
  try {
    response = await request({
      url: prepared.url,
      method: "PUT",
      headers: safeHeaders(prepared.headers),
      body,
      rawBody: true,
      ...(signal ? { signal } : {})
    });
  } catch {
    throwIfAborted(signal);
    throw new AuthorityAdoptionError(
      "authority_adoption_unreachable",
      "Connect could not be reached for collection adoption."
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AuthorityAdoptionError(
      "authority_adoption_object_upload_failed",
      "Object storage rejected an authority import file part.",
      response.status
    );
  }
  return response;
}

function fileBlob(source: FileSource, mediaType?: string): Blob {
  if (source instanceof Blob) return source;
  if (source instanceof ArrayBuffer) return new Blob([source], { type: mediaType });
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  return new Blob([bytes], { type: mediaType });
}

async function blobDigest(blob: Blob, signal?: AbortSignal): Promise<`sha256:${string}`> {
  const digest = sha256.create();
  const reader = blob.stream().getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      digest.update(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return `sha256:${bytesToHex(digest.digest())}`;
}

function importTransferId(importId: string, file: CollectionFileDescriptor): string {
  const namespace = uuidBytes(importId);
  const name = utf8.encode(
    `mdbase-authority-import-file-v1\0${file.file_id}\0${file.revision}\0${file.content_digest}`
  );
  const digest = sha1(new Uint8Array([...namespace, ...name])).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(digest);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidBytes(value: string): Uint8Array {
  if (!UUID.test(value)) throw invalidResponse("Authority import ID is invalid.");
  return Uint8Array.from(
    value.replaceAll("-", "").match(/../g)!.map((byte) => Number.parseInt(byte, 16))
  );
}

function validateSession(session: FileTransferSession, transferId: string, size: number): void {
  const strategy = session?.strategy;
  if (
    session?.protocol_version !== 1
    || session.type !== "file_transfer"
    || session.transfer_id !== transferId
    || session.direction !== "upload"
    || session.protection !== "transport_tls"
    || session.total_size !== size
    || !Array.isArray(session.received)
    || !strategy
    || !["object_put", "object_multipart"].includes(strategy.kind)
    || (strategy.kind === "object_multipart"
      && (!Number.isSafeInteger(strategy.part_size) || strategy.part_size <= 0))
  ) throw invalidResponse("Connect returned an invalid authority import file session.");
  if (strategy.kind !== "object_put" && strategy.kind !== "object_multipart") {
    throw invalidResponse("Connect returned an invalid authority import file strategy.");
  }
  const partSize = strategy.kind === "object_put" ? Math.max(1, size) : strategy.part_size;
  const partCount = strategy.kind === "object_put" ? 1 : Math.ceil(size / partSize);
  if (
    new Set(session.received).size !== session.received.length
    || session.received.some((part) => !Number.isSafeInteger(part) || part < 0 || part >= partCount)
  ) throw invalidResponse("Connect returned invalid authority import file progress.");
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
    || (strategy.kind === "object_multipart"
      ? uploadedParts.length !== session.received.length
        || uploadedParts.some((part, index) => part.part_number - 1 !== session.received[index])
      : uploadedParts.length !== 0)
  ) throw invalidResponse("Connect returned invalid authority import part receipts.");
}

function validatePreparedPart(
  part: PreparedFilePart,
  transferId: string,
  partIndex: number,
  offset: number,
  contentLength: number
): void {
  if (
    part?.protocol_version !== 1
    || part.type !== "file_part"
    || part.transfer_id !== transferId
    || part.part_index !== partIndex
    || part.offset !== offset
    || part.content_length !== contentLength
    || part.method.toUpperCase() !== "PUT"
    || !Number.isFinite(Date.parse(part.expires_at))
    || !isRecord(part.headers)
  ) throw invalidResponse("Connect returned an invalid prepared authority import file part.");
}

function validateObjectUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse("Connect returned an invalid object storage URL.");
  }
  if (
    (url.protocol !== "https:"
      && !(url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)))
    || url.username
    || url.password
    || url.hash
  ) throw invalidResponse("Connect returned an unsafe object storage URL.");
}

function safeHeaders(input: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (["authorization", "cookie", "host", "proxy-authorization"].includes(name.toLowerCase())) {
      throw invalidResponse("Connect returned unsafe object storage headers.");
    }
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
      throw invalidResponse("Connect returned invalid object storage headers.");
    }
    headers[name] = value;
  }
  return headers;
}

function sameDescriptor(left: CollectionFileDescriptor, right: CollectionFileDescriptor): boolean {
  return left.file_id === right.file_id
    && left.path === right.path
    && left.revision === right.revision
    && left.content_digest === right.content_digest
    && left.size === right.size
    && left.media_type === right.media_type
    && left.media_class === right.media_class
    && left.modified_at === right.modified_at;
}

function responseError(response: ImportResponse): AuthorityAdoptionError {
  const envelope = isRecord(response.body) && isRecord(response.body.error)
    ? response.body.error
    : {};
  return new AuthorityAdoptionError(
    typeof envelope.code === "string" ? envelope.code : "authority_adoption_request_failed",
    typeof envelope.message === "string"
      ? envelope.message
      : `Collection adoption request failed with status ${response.status}.`,
    response.status
  );
}

function invalidResponse(message: string): AuthorityAdoptionError {
  return new AuthorityAdoptionError("invalid_authority_adoption_response", message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AuthorityAdoptionError(
      "authority_adoption_cancelled",
      "Collection adoption was cancelled."
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

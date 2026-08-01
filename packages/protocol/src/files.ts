export const FILE_PROTOCOL_VERSION = 1 as const;
export const FILE_TRANSFER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_FILE_CHUNK_BYTES = 1024 * 1024;
export const MAX_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_FRAME_HEADER_BYTES = 16 * 1024;
export const FILE_FRAME_PREFIX_BYTES = 16;
export const FILE_FRAME_MAGIC = "MDBF" as const;
export const MAX_FILE_FRAME_BYTES = FILE_FRAME_PREFIX_BYTES
  + MAX_FILE_FRAME_HEADER_BYTES
  + MAX_FILE_CHUNK_BYTES
  + 16;
export const RELAY_FILE_PROTOCOL_VERSION = 1 as const;
export const RELAY_FILE_PREFIX_BYTES = 16;
export const MAX_RELAY_FILE_HEADER_BYTES = 1024;
export const MAX_RELAY_FILE_PAYLOAD_BYTES = MAX_FILE_FRAME_BYTES;
export const RELAY_FILE_MAGIC = "MDBR" as const;

const FILE_FRAME_MAGIC_BYTES = new Uint8Array([0x4d, 0x44, 0x42, 0x46]);
const FILE_FRAME_VERSION = 1;
const FILE_FRAME_FLAGS = 0;
const RELAY_FILE_MAGIC_BYTES = new Uint8Array([0x4d, 0x44, 0x42, 0x52]);
const RELAY_FILE_FRAME_VERSION = 1;
const RELAY_FILE_FRAME_FLAGS = 0;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FileMediaClass = "image" | "audio" | "video" | "pdf" | "other";

/** Device-local projection. Folder exclusions apply to Markdown and files. */
export interface SelectiveSyncPolicy {
  file_classes: FileMediaClass[];
  excluded_folders: string[];
}
export type FileAction = "list" | "read" | "add" | "replace" | "move" | "delete";
export type FileTransferDirection = "upload" | "download";
export type FileTransferProtection = "grant_aead_v1" | "transport_tls";
export type FileTransferState = "open" | "committed" | "aborted" | "expired";
export type FileTransferStrategy =
  | { kind: "framed_chunks"; chunk_size: number }
  | { kind: "object_put" }
  | { kind: "object_multipart"; part_size: number }
  | { kind: "object_ranges"; part_size: number };
export type FileFrameKind = "upload_chunk" | "download_chunk";
export type RelayFileKind =
  | "upload_chunk"
  | "upload_acknowledged"
  | "download_request"
  | "download_chunk"
  | "rejected";

export type FileScope =
  | { kind: "selected_folders"; folders: string[] }
  | { kind: "collection" };

/** File intent declared by an application before an authority is selected. */
export interface ApplicationFileRequirement {
  actions: FileAction[];
  scope: FileScope;
}

export interface FileCapability {
  kind: "files";
  protocol_version: 1;
  actions: FileAction[];
  scope: FileScope;
}

export interface CollectionFileDescriptor {
  file_id: string;
  path: string;
  revision: string;
  content_digest: `sha256:${string}`;
  size: number;
  media_type?: string;
  media_class: FileMediaClass;
  modified_at: string;
}

export interface ListFilesRequest {
  protocol_version: 1;
  type: "list_files";
  folder?: string;
  /** Opaque authority-issued continuation cursor. */
  after?: string;
  limit?: number;
}

export interface ListFilesPage {
  protocol_version: 1;
  type: "files_page";
  files: CollectionFileDescriptor[];
  /** Opaque continuation cursor; pass it back unchanged as `after`. */
  next?: string;
}

export interface OpenFileUploadRequest {
  protocol_version: 1;
  type: "open_file_upload";
  transfer_id: string;
  path: string;
  size: number;
  content_digest: `sha256:${string}`;
  media_type?: string;
  if_revision?: string;
}

export interface OpenAuthorityImportFileUploadRequest {
  protocol_version: 1;
  type: "open_authority_import_file_upload";
  transfer_id: string;
  file_id: string;
}

export interface OpenFileDownloadRequest {
  protocol_version: 1;
  type: "open_file_download";
  transfer_id: string;
  file_id: string;
  revision?: string;
}

export interface MoveFileRequest {
  protocol_version: 1;
  type: "move_file";
  mutation_id: string;
  file_id: string;
  if_revision: string;
  from_path: string;
  path: string;
  update_references: boolean;
}

export interface MoveFileReceipt {
  protocol_version: 1;
  type: "file_moved";
  mutation_id: string;
  file: CollectionFileDescriptor;
}

export interface DeleteFileRequest {
  protocol_version: 1;
  type: "delete_file";
  mutation_id: string;
  file_id: string;
  if_revision: string;
  path: string;
}

export interface DeleteFileReceipt {
  protocol_version: 1;
  type: "file_deleted";
  mutation_id: string;
  file_id: string;
  previous_path: string;
  revision: string;
}

export interface FileTransferSession {
  protocol_version: 1;
  type: "file_transfer";
  transfer_id: string;
  direction: FileTransferDirection;
  protection: FileTransferProtection;
  strategy: FileTransferStrategy;
  total_size: number;
  expires_at: string;
  received: number[];
  /** R2/S3 part receipts for bandwidth-efficient multipart resume. */
  uploaded_parts?: UploadedFilePart[];
}

export interface FileTransferStatus {
  protocol_version: 1;
  type: "file_transfer_status";
  transfer_id: string;
  state: FileTransferState;
  received: number[];
  received_bytes: number;
}

export interface PrepareFileUploadPartRequest {
  protocol_version: 1;
  type: "prepare_file_upload_part";
  transfer_id: string;
  part_number: number;
  content_length: number;
}

export interface PreparedFilePart {
  protocol_version: 1;
  type: "file_part";
  transfer_id: string;
  part_index: number;
  offset: number;
  content_length: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface UploadedFilePart {
  part_number: number;
  etag: string;
}

export interface CommitFileUploadRequest {
  protocol_version: 1;
  type: "commit_file_upload";
  transfer_id: string;
  parts?: UploadedFilePart[];
}

export interface CommitFileUploadReceipt {
  protocol_version: 1;
  type: "file_upload_committed";
  transfer_id: string;
  file: CollectionFileDescriptor;
}

export interface AbortFileTransferRequest {
  protocol_version: 1;
  type: "abort_file_transfer";
  transfer_id: string;
}

export interface GetFileTransferStatusRequest {
  protocol_version: 1;
  type: "get_file_transfer_status";
  transfer_id: string;
}

export interface FileFrameHeader {
  protocol_version: 1;
  protection: FileTransferProtection;
  grant_id: string;
  authority_id: string;
  collection_id: string;
  transfer_id: string;
  direction: FileTransferDirection;
  chunk_size: number;
  chunk_index: number;
  offset: number;
  plaintext_length: number;
  total_size: number;
  scope_epoch: number;
  key_id?: string;
}

export interface FileFrame {
  kind: FileFrameKind;
  header: FileFrameHeader;
  payload: Uint8Array;
}

export interface RelayFileHeader {
  protocol_version: 1;
  type: RelayFileKind;
  request_id: string;
  grant_id: string;
  transfer_id: string;
  chunk_index: number;
}

export interface RelayFileFrame {
  kind: RelayFileKind;
  header: RelayFileHeader;
  payload: Uint8Array;
}

export interface FileFrameDecodeLimits {
  maxHeaderBytes?: number;
  maxPayloadBytes?: number;
}

export type FileFrameErrorCode =
  | "invalid_magic"
  | "unsupported_version"
  | "invalid_kind"
  | "unsupported_flags"
  | "invalid_length"
  | "invalid_header"
  | "limit_exceeded";

export class FileFrameError extends Error {
  constructor(
    public readonly code: FileFrameErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FileFrameError";
  }
}

export class RelayFileFrameError extends Error {
  constructor(
    public readonly code: FileFrameErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RelayFileFrameError";
  }
}

function frameKindCode(kind: FileFrameKind): number {
  return kind === "upload_chunk" ? 1 : 2;
}

function frameKindFromCode(code: number): FileFrameKind {
  if (code === 1) return "upload_chunk";
  if (code === 2) return "download_chunk";
  throw new FileFrameError("invalid_kind", `Unknown file frame kind ${code}`);
}

function expectObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FileFrameError("invalid_header", "File frame header must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function expectString(object: Record<string, unknown>, name: string): string {
  const value = object[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new FileFrameError("invalid_header", `File frame header ${name} must be a non-empty string`);
  }
  return value;
}

function expectUuid(object: Record<string, unknown>, name: string): string {
  const value = expectString(object, name);
  if (!UUID_PATTERN.test(value)) {
    throw new FileFrameError("invalid_header", `File frame header ${name} must be a UUID`);
  }
  return value;
}

function expectInteger(object: Record<string, unknown>, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = object[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new FileFrameError("invalid_header", `File frame header ${name} is outside its allowed range`);
  }
  return value as number;
}

function canonicalHeader(header: FileFrameHeader): FileFrameHeader {
  if (header.protocol_version !== FILE_TRANSFER_PROTOCOL_VERSION) {
    throw new FileFrameError("unsupported_version", `Unsupported file transfer protocol ${header.protocol_version}`);
  }
  if (header.protection !== "grant_aead_v1" && header.protection !== "transport_tls") {
    throw new FileFrameError("invalid_header", "Unknown file transfer protection");
  }
  if (header.direction !== "upload" && header.direction !== "download") {
    throw new FileFrameError("invalid_header", "Unknown file transfer direction");
  }
  for (const [name, value] of [
    ["grant_id", header.grant_id],
    ["authority_id", header.authority_id],
    ["collection_id", header.collection_id],
    ["transfer_id", header.transfer_id]
  ] as const) {
    if (!UUID_PATTERN.test(value)) {
      throw new FileFrameError("invalid_header", `File frame header ${name} must be a UUID`);
    }
  }
  for (const [name, value, maximum] of [
    ["chunk_size", header.chunk_size, MAX_FILE_CHUNK_BYTES],
    ["chunk_index", header.chunk_index, Number.MAX_SAFE_INTEGER],
    ["offset", header.offset, Number.MAX_SAFE_INTEGER],
    ["plaintext_length", header.plaintext_length, MAX_FILE_CHUNK_BYTES],
    ["total_size", header.total_size, Number.MAX_SAFE_INTEGER]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new FileFrameError("invalid_header", `File frame header ${name} is outside its allowed range`);
    }
  }
  if (header.chunk_size < 64 * 1024) {
    throw new FileFrameError("invalid_header", "File frame chunk_size is below the protocol minimum");
  }
  if (!Number.isSafeInteger(header.scope_epoch) || header.scope_epoch < 1) {
    throw new FileFrameError("invalid_header", "File frame header scope_epoch must be a positive integer");
  }
  if (header.protection === "grant_aead_v1" && !header.key_id) {
    throw new FileFrameError("invalid_header", "AEAD-protected file frames require key_id");
  }
  return {
    protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
    protection: header.protection,
    grant_id: header.grant_id,
    authority_id: header.authority_id,
    collection_id: header.collection_id,
    transfer_id: header.transfer_id,
    direction: header.direction,
    chunk_size: header.chunk_size,
    chunk_index: header.chunk_index,
    offset: header.offset,
    plaintext_length: header.plaintext_length,
    total_size: header.total_size,
    scope_epoch: header.scope_epoch,
    ...(header.key_id === undefined ? {} : { key_id: header.key_id })
  };
}

function parseHeader(bytes: Uint8Array): FileFrameHeader {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileFrameError("invalid_header", "File frame header is not valid UTF-8");
  }
  let object: Record<string, unknown>;
  try {
    object = expectObject(JSON.parse(source));
  } catch (error) {
    if (error instanceof FileFrameError) throw error;
    throw new FileFrameError("invalid_header", "File frame header is not valid JSON");
  }
  const allowed = new Set([
    "protocol_version", "protection", "grant_id", "authority_id", "collection_id",
    "transfer_id", "direction", "chunk_size", "chunk_index", "offset", "plaintext_length",
    "total_size", "scope_epoch", "key_id"
  ]);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new FileFrameError("invalid_header", "File frame header contains an unknown field");
  }
  const protocolVersion = expectInteger(object, "protocol_version");
  if (protocolVersion !== FILE_TRANSFER_PROTOCOL_VERSION) {
    throw new FileFrameError("unsupported_version", `Unsupported file transfer protocol ${protocolVersion}`);
  }
  const protection = expectString(object, "protection");
  const direction = expectString(object, "direction");
  const keyId = object.key_id === undefined ? undefined : expectString(object, "key_id");
  const header = canonicalHeader({
    protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
    protection: protection as FileTransferProtection,
    grant_id: expectUuid(object, "grant_id"),
    authority_id: expectUuid(object, "authority_id"),
    collection_id: expectUuid(object, "collection_id"),
    transfer_id: expectUuid(object, "transfer_id"),
    direction: direction as FileTransferDirection,
    chunk_size: expectInteger(object, "chunk_size", MAX_FILE_CHUNK_BYTES),
    chunk_index: expectInteger(object, "chunk_index"),
    offset: expectInteger(object, "offset"),
    plaintext_length: expectInteger(object, "plaintext_length", MAX_FILE_CHUNK_BYTES),
    total_size: expectInteger(object, "total_size"),
    scope_epoch: expectInteger(object, "scope_epoch"),
    ...(keyId === undefined ? {} : { key_id: keyId })
  });
  if (JSON.stringify(header) !== source) {
    throw new FileFrameError(
      "invalid_header",
      "File frame header must use the canonical field order without duplicate fields or whitespace"
    );
  }
  return header;
}

function validateFrameSemantics(kind: FileFrameKind, header: FileFrameHeader, payloadLength: number): void {
  const expectedDirection = kind === "upload_chunk" ? "upload" : "download";
  if (header.direction !== expectedDirection) {
    throw new FileFrameError("invalid_header", `Frame kind ${kind} requires direction ${expectedDirection}`);
  }
  const expectedOffset = header.chunk_index * header.chunk_size;
  if (!Number.isSafeInteger(expectedOffset) || header.offset !== expectedOffset) {
    throw new FileFrameError("invalid_header", "Chunk offset does not match its index and protocol chunk size");
  }
  if (header.offset + header.plaintext_length > header.total_size) {
    throw new FileFrameError("invalid_header", "Chunk extends past the declared transfer size");
  }
  const expectedPayloadLength = header.protection === "grant_aead_v1"
    ? header.plaintext_length + 16
    : header.plaintext_length;
  if (payloadLength !== expectedPayloadLength) {
    throw new FileFrameError("invalid_length", "Payload length does not match the protected plaintext length");
  }
}

function expectedFileFramePayloadLength(header: FileFrameHeader): number {
  return header.plaintext_length + (header.protection === "grant_aead_v1" ? 16 : 0);
}

/** Prefix and canonical header authenticated by the file chunk AEAD profile. */
export function fileFrameAuthenticatedData(kind: FileFrameKind, input: FileFrameHeader): Uint8Array {
  const header = canonicalHeader(input);
  const payloadLength = expectedFileFramePayloadLength(header);
  validateFrameSemantics(kind, header, payloadLength);
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_FILE_FRAME_HEADER_BYTES) {
    throw new FileFrameError("limit_exceeded", "File frame header exceeds the protocol limit");
  }
  const output = new Uint8Array(FILE_FRAME_PREFIX_BYTES + headerBytes.byteLength);
  output.set(FILE_FRAME_MAGIC_BYTES, 0);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint8(4, FILE_FRAME_VERSION);
  view.setUint8(5, frameKindCode(kind));
  view.setUint16(6, FILE_FRAME_FLAGS, false);
  view.setUint32(8, headerBytes.byteLength, false);
  view.setUint32(12, payloadLength, false);
  output.set(headerBytes, FILE_FRAME_PREFIX_BYTES);
  return output;
}

export function encodeFileFrame(frame: FileFrame): Uint8Array {
  const header = canonicalHeader(frame.header);
  validateFrameSemantics(frame.kind, header, frame.payload.byteLength);
  if (frame.payload.byteLength > MAX_FILE_CHUNK_BYTES + 16) {
    throw new FileFrameError("limit_exceeded", "File frame payload exceeds the protocol limit");
  }
  const authenticatedData = fileFrameAuthenticatedData(frame.kind, header);
  const output = new Uint8Array(authenticatedData.byteLength + frame.payload.byteLength);
  output.set(authenticatedData, 0);
  output.set(frame.payload, authenticatedData.byteLength);
  return output;
}

export function decodeFileFrame(bytes: Uint8Array, limits: FileFrameDecodeLimits = {}): FileFrame {
  if (bytes.byteLength < FILE_FRAME_PREFIX_BYTES) {
    throw new FileFrameError("invalid_length", "File frame is shorter than its fixed prefix");
  }
  if (!FILE_FRAME_MAGIC_BYTES.every((byte, index) => bytes[index] === byte)) {
    throw new FileFrameError("invalid_magic", "File frame magic is not MDBF");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== FILE_FRAME_VERSION) {
    throw new FileFrameError("unsupported_version", `Unsupported file frame version ${version}`);
  }
  const kind = frameKindFromCode(view.getUint8(5));
  if (view.getUint16(6, false) !== FILE_FRAME_FLAGS) {
    throw new FileFrameError("unsupported_flags", "File frame uses unsupported flags");
  }
  const headerLength = view.getUint32(8, false);
  const payloadLength = view.getUint32(12, false);
  const maxHeaderBytes = limits.maxHeaderBytes ?? MAX_FILE_FRAME_HEADER_BYTES;
  const maxPayloadBytes = limits.maxPayloadBytes ?? MAX_FILE_CHUNK_BYTES + 16;
  if (headerLength === 0) {
    throw new FileFrameError("invalid_length", "File frame header must not be empty");
  }
  if (headerLength > maxHeaderBytes || payloadLength > maxPayloadBytes) {
    throw new FileFrameError("limit_exceeded", "File frame exceeds the configured decode limits");
  }
  const expectedLength = FILE_FRAME_PREFIX_BYTES + headerLength + payloadLength;
  if (!Number.isSafeInteger(expectedLength) || expectedLength !== bytes.byteLength) {
    throw new FileFrameError("invalid_length", "File frame lengths do not match the supplied bytes");
  }
  const headerEnd = FILE_FRAME_PREFIX_BYTES + headerLength;
  const header = parseHeader(bytes.subarray(FILE_FRAME_PREFIX_BYTES, headerEnd));
  validateFrameSemantics(kind, header, payloadLength);
  return { kind, header, payload: bytes.slice(headerEnd) };
}

export function encodeRelayFileFrame(frame: RelayFileFrame): Uint8Array {
  const header = canonicalRelayHeader(frame.header);
  validateRelayFrame(frame.kind, header, frame.payload.byteLength);
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_RELAY_FILE_HEADER_BYTES
      || frame.payload.byteLength > MAX_RELAY_FILE_PAYLOAD_BYTES) {
    throw new RelayFileFrameError("limit_exceeded", "Relay file frame exceeds protocol limits");
  }
  const output = new Uint8Array(
    RELAY_FILE_PREFIX_BYTES + headerBytes.byteLength + frame.payload.byteLength
  );
  output.set(RELAY_FILE_MAGIC_BYTES, 0);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint8(4, RELAY_FILE_FRAME_VERSION);
  view.setUint8(5, relayFileKindCode(frame.kind));
  view.setUint16(6, RELAY_FILE_FRAME_FLAGS, false);
  view.setUint32(8, headerBytes.byteLength, false);
  view.setUint32(12, frame.payload.byteLength, false);
  output.set(headerBytes, RELAY_FILE_PREFIX_BYTES);
  output.set(frame.payload, RELAY_FILE_PREFIX_BYTES + headerBytes.byteLength);
  return output;
}

export function decodeRelayFileFrame(bytes: Uint8Array): RelayFileFrame {
  if (bytes.byteLength < RELAY_FILE_PREFIX_BYTES) {
    throw new RelayFileFrameError("invalid_length", "Relay file frame is shorter than its prefix");
  }
  if (!RELAY_FILE_MAGIC_BYTES.every((byte, index) => bytes[index] === byte)) {
    throw new RelayFileFrameError("invalid_magic", "Relay file frame magic is not MDBR");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== RELAY_FILE_FRAME_VERSION) {
    throw new RelayFileFrameError("unsupported_version", "Unsupported relay file frame version");
  }
  const kind = relayFileKindFromCode(view.getUint8(5));
  if (view.getUint16(6, false) !== RELAY_FILE_FRAME_FLAGS) {
    throw new RelayFileFrameError("unsupported_flags", "Relay file frame uses unsupported flags");
  }
  const headerLength = view.getUint32(8, false);
  const payloadLength = view.getUint32(12, false);
  if (headerLength === 0) {
    throw new RelayFileFrameError("invalid_length", "Relay file frame header must not be empty");
  }
  if (headerLength > MAX_RELAY_FILE_HEADER_BYTES
      || payloadLength > MAX_RELAY_FILE_PAYLOAD_BYTES) {
    throw new RelayFileFrameError("limit_exceeded", "Relay file frame exceeds protocol limits");
  }
  const expectedLength = RELAY_FILE_PREFIX_BYTES + headerLength + payloadLength;
  if (!Number.isSafeInteger(expectedLength) || expectedLength !== bytes.byteLength) {
    throw new RelayFileFrameError("invalid_length", "Relay file frame lengths do not match its bytes");
  }
  const headerEnd = RELAY_FILE_PREFIX_BYTES + headerLength;
  const headerBytes = bytes.subarray(RELAY_FILE_PREFIX_BYTES, headerEnd);
  let source: string;
  let parsed: unknown;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(headerBytes);
    parsed = JSON.parse(source);
  } catch {
    throw new RelayFileFrameError("invalid_header", "Relay file frame header is not valid JSON");
  }
  const header = parseRelayHeader(parsed);
  if (JSON.stringify(header) !== source) {
    throw new RelayFileFrameError("invalid_header", "Relay file frame header is not canonical JSON");
  }
  validateRelayFrame(kind, header, payloadLength);
  return { kind, header, payload: bytes.slice(headerEnd) };
}

function canonicalRelayHeader(header: RelayFileHeader): RelayFileHeader {
  if (header.protocol_version !== RELAY_FILE_PROTOCOL_VERSION) {
    throw new RelayFileFrameError("unsupported_version", "Unsupported relay file protocol");
  }
  if (!relayFileKinds.includes(header.type)) {
    throw new RelayFileFrameError("invalid_kind", "Unknown relay file message type");
  }
  for (const [name, value] of [
    ["request_id", header.request_id],
    ["grant_id", header.grant_id],
    ["transfer_id", header.transfer_id]
  ] as const) {
    if (!UUID_PATTERN.test(value)) {
      throw new RelayFileFrameError("invalid_header", `Relay file header ${name} must be a UUID`);
    }
  }
  if (!Number.isSafeInteger(header.chunk_index) || header.chunk_index < 0) {
    throw new RelayFileFrameError("invalid_header", "Relay file chunk index is invalid");
  }
  return {
    protocol_version: RELAY_FILE_PROTOCOL_VERSION,
    type: header.type,
    request_id: header.request_id,
    grant_id: header.grant_id,
    transfer_id: header.transfer_id,
    chunk_index: header.chunk_index
  };
}

function parseRelayHeader(value: unknown): RelayFileHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayFileFrameError("invalid_header", "Relay file header must be an object");
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([
    "protocol_version", "type", "request_id", "grant_id", "transfer_id", "chunk_index"
  ]);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new RelayFileFrameError("invalid_header", "Relay file header contains an unknown field");
  }
  return canonicalRelayHeader({
    protocol_version: object.protocol_version as 1,
    type: object.type as RelayFileKind,
    request_id: object.request_id as string,
    grant_id: object.grant_id as string,
    transfer_id: object.transfer_id as string,
    chunk_index: object.chunk_index as number
  });
}

const relayFileKinds: RelayFileKind[] = [
  "upload_chunk",
  "upload_acknowledged",
  "download_request",
  "download_chunk",
  "rejected"
];

function relayFileKindCode(kind: RelayFileKind): number {
  const index = relayFileKinds.indexOf(kind);
  if (index < 0) throw new RelayFileFrameError("invalid_kind", "Unknown relay file frame kind");
  return index + 1;
}

function relayFileKindFromCode(code: number): RelayFileKind {
  const kind = relayFileKinds[code - 1];
  if (!kind) throw new RelayFileFrameError("invalid_kind", `Unknown relay file frame kind ${code}`);
  return kind;
}

function validateRelayFrame(
  kind: RelayFileKind,
  header: RelayFileHeader,
  payloadLength: number
): void {
  if (kind !== header.type) {
    throw new RelayFileFrameError("invalid_header", "Relay file kind does not match its header");
  }
  const carriesPayload = kind === "upload_chunk" || kind === "download_chunk";
  if (carriesPayload !== (payloadLength > 0)) {
    throw new RelayFileFrameError("invalid_length", "Relay file payload does not match its kind");
  }
}

import type {
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  DeleteFileReceipt,
  DeleteFileRequest,
  FileTransferSession,
  JsonObject,
  MoveFileReceipt,
  MoveFileRequest,
  OpenFileUploadRequest,
  PreparedFilePart,
  UploadedFilePart,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncFileSnapshotPage,
  SyncSnapshotPage
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import type { SyncTransport } from "./sync-types.js";

export class HttpSyncTransport<Frontmatter extends JsonObject = JsonObject> implements SyncTransport<Frontmatter> {
  private readonly syncUrl: string;
  private readonly filesUrl: string;
  constructor(syncUrl: string, private readonly replicaToken: string) {
    let endpoint: URL;
    try {
      endpoint = new URL(syncUrl);
    } catch {
      throw new SyncError("invalid_sync_url", "Sync URL must be an absolute authority endpoint.");
    }
    if (!secureHttpEndpoint(endpoint)
        || endpoint.username
        || endpoint.password
        || endpoint.search
        || endpoint.hash
        || !/^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/sync\/?$/i.test(endpoint.pathname)) {
      throw new SyncError(
        "invalid_sync_url",
        "Sync URL must identify one HTTPS authority sync endpoint, except on loopback."
      );
    }
    this.syncUrl = endpoint.href.replace(/\/$/, "");
    this.filesUrl = this.syncUrl.replace(/\/sync$/u, "/files");
  }

  openSession(): Promise<SyncSession> {
    return this.request("POST", "sessions");
  }
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>> {
    const query = new URLSearchParams({ snapshot_id: snapshotId });
    if (page) query.set("page", page);
    return this.request("GET", `snapshot?${query}`);
  }
  fileSnapshot(snapshotId: string, page?: string): Promise<SyncFileSnapshotPage> {
    const query = new URLSearchParams({ snapshot_id: snapshotId });
    if (page) query.set("page", page);
    return this.request("GET", `files/snapshot?${query}`);
  }
  async *downloadFile(file: CollectionFileDescriptor): AsyncGenerator<Uint8Array> {
    const transferId = crypto.randomUUID();
    try {
      const session = await this.fileRequest<FileTransferSession>("POST", "downloads", {
        protocol_version: 1,
        type: "open_file_download",
        transfer_id: transferId,
        file_id: file.file_id,
        revision: file.revision
      });
      if (
        session.protocol_version !== 1
        || session.type !== "file_transfer"
        || session.transfer_id !== transferId
        || session.direction !== "download"
        || session.protection !== "transport_tls"
        || session.total_size !== file.size
        || session.strategy.kind !== "object_ranges"
        || !Number.isSafeInteger(session.strategy.part_size)
        || session.strategy.part_size <= 0
      ) {
        throw new SyncError(
          "invalid_sync_response",
          "The authority returned an incompatible file download session."
        );
      }
      const partSize = session.strategy.part_size;
      const partCount = Math.ceil(file.size / partSize);
      for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
        const offset = partIndex * partSize;
        const contentLength = Math.min(partSize, file.size - offset);
        const response = await fetch(
          `${this.filesUrl}/downloads/${encodeURIComponent(transferId)}/parts/${partIndex}`,
          {
            method: "GET",
            headers: { authorization: `Bearer ${this.replicaToken}` },
            redirect: "error"
          }
        );
        if (!response.ok || response.type === "opaqueredirect") {
          const value = await response.json().catch(() => undefined);
          throw new SyncError(
            value?.error?.code ?? "file_download_failed",
            value?.error?.message ?? `Hosted authority returned HTTP ${response.status}.`
          );
        }
        const declaredLength = response.headers.get("content-length");
        if (declaredLength !== null && Number(declaredLength) !== contentLength) {
          throw new SyncError(
            "file_integrity_failed",
            "Hosted authority returned a file part with the wrong length."
          );
        }
        if (!response.body) {
          throw new SyncError("file_download_failed", "Hosted authority returned no response body.");
        }
        let received = 0;
        for await (const chunk of readableStreamBytes(response.body)) {
          received += chunk.byteLength;
          if (!Number.isSafeInteger(received) || received > contentLength) {
            throw new SyncError("file_integrity_failed", "Hosted authority returned an oversized file part.");
          }
          yield chunk;
        }
        if (received !== contentLength) {
          throw new SyncError(
            "file_integrity_failed",
            "Hosted authority returned a file part with the wrong length."
          );
        }
      }
    } finally {
      await this.fileRequest("DELETE", `transfers/${encodeURIComponent(transferId)}`)
        .catch(() => undefined);
    }
  }
  async uploadFile(
    request: OpenFileUploadRequest,
    source: AsyncIterable<Uint8Array>
  ): Promise<CommitFileUploadReceipt> {
    const session = await this.fileRequest<FileTransferSession>("POST", "uploads", request);
    if (
      session.protocol_version !== 1
      || session.type !== "file_transfer"
      || session.transfer_id !== request.transfer_id
      || session.direction !== "upload"
      || session.protection !== "transport_tls"
      || session.total_size !== request.size
      || !["object_put", "object_multipart"].includes(session.strategy.kind)
    ) throw new SyncError("invalid_sync_response", "Authority returned an incompatible file upload session.");
    const partSize = session.strategy.kind === "object_multipart"
      ? session.strategy.part_size
      : Math.max(1, request.size);
    if (!Number.isSafeInteger(partSize) || partSize <= 0) {
      throw new SyncError("invalid_sync_response", "Authority returned an invalid upload part size.");
    }
    const reader = new BinaryPartReader(source);
    const count = Math.max(1, Math.ceil(request.size / partSize));
    if (
      session.received.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= count)
      || new Set(session.received).size !== session.received.length
    ) throw new SyncError("invalid_sync_response", "Authority returned invalid upload progress.");
    const uploadedParts = session.uploaded_parts ?? [];
    if (
      !Array.isArray(uploadedParts)
      || uploadedParts.some((part, index) =>
        !Number.isSafeInteger(part?.part_number)
        || part.part_number < 1
        || part.part_number > count
        || typeof part.etag !== "string"
        || part.etag.length === 0
        || part.etag.length > 255
        || (index > 0 && uploadedParts[index - 1]!.part_number >= part.part_number))
      || (session.strategy.kind === "object_multipart"
        ? uploadedParts.length !== session.received.length
          || uploadedParts.some((part, index) => part.part_number - 1 !== session.received[index])
        : uploadedParts.length !== 0)
    ) throw new SyncError("invalid_sync_response", "Authority returned invalid uploaded part receipts.");
    if (session.received.length === count) {
      return this.commitUpload(request.transfer_id, uploadedParts);
    }
    const received = new Set(session.received);
    const parts: Array<UploadedFilePart | undefined> = Array(count);
    for (const part of uploadedParts) parts[part.part_number - 1] = part;
    for (let index = 0; index < count; index += 1) {
      const offset = index * partSize;
      const length = Math.min(partSize, Math.max(0, request.size - offset));
      const bytes = await reader.read(length);
      if (received.has(index)) continue;
      const prepared = await this.fileRequest<PreparedFilePart>(
        "POST",
        `uploads/${encodeURIComponent(request.transfer_id)}/parts`,
        {
          protocol_version: 1,
          type: "prepare_file_upload_part",
          transfer_id: request.transfer_id,
          part_number: index + 1,
          content_length: length
        }
      );
      validatePreparedUpload(prepared, request.transfer_id, index, offset, length);
      const response = await fetch(prepared.url, {
        method: "PUT",
        headers: safeObjectHeaders(prepared.headers),
        body: new Blob([new Uint8Array(bytes)]),
        redirect: "manual"
      });
      if (!response.ok || response.type === "opaqueredirect") {
        throw new SyncError("file_upload_failed", `Object storage returned HTTP ${response.status}.`);
      }
      if (session.strategy.kind === "object_multipart") {
        const etag = response.headers.get("etag");
        if (!etag) throw new SyncError("invalid_sync_response", "Object storage omitted a multipart ETag.");
        parts[index] = { part_number: index + 1, etag };
      }
    }
    await reader.expectEnd();
    return this.commitUpload(
      request.transfer_id,
      parts.filter((part): part is UploadedFilePart => part !== undefined)
    );
  }
  private async commitUpload(
    transferId: string,
    parts: UploadedFilePart[]
  ): Promise<CommitFileUploadReceipt> {
    const receipt = await this.fileRequest<CommitFileUploadReceipt>("POST", `uploads/${encodeURIComponent(transferId)}/commit`, {
      protocol_version: 1,
      type: "commit_file_upload",
      transfer_id: transferId,
      parts
    });
    if (receipt.protocol_version !== 1 || receipt.type !== "file_upload_committed" || receipt.transfer_id !== transferId) {
      throw new SyncError("invalid_sync_response", "Authority returned an invalid file upload receipt.");
    }
    return receipt;
  }
  async moveFile(request: MoveFileRequest): Promise<MoveFileReceipt> {
    const receipt = await this.fileRequest<MoveFileReceipt>("POST", `${encodeURIComponent(request.file_id)}/move`, request);
    if (receipt.protocol_version !== 1 || receipt.type !== "file_moved" || receipt.mutation_id !== request.mutation_id) {
      throw new SyncError("invalid_sync_response", "Authority returned an invalid file move receipt.");
    }
    return receipt;
  }
  async deleteFile(request: DeleteFileRequest): Promise<DeleteFileReceipt> {
    const receipt = await this.fileRequest<DeleteFileReceipt>("POST", `${encodeURIComponent(request.file_id)}/delete`, request);
    if (
      receipt.protocol_version !== 1
      || receipt.type !== "file_deleted"
      || receipt.mutation_id !== request.mutation_id
      || receipt.file_id !== request.file_id
    ) throw new SyncError("invalid_sync_response", "Authority returned an invalid file delete receipt.");
    return receipt;
  }
  changes(after: number, limit = 200): Promise<SyncChangesPage<Frontmatter>> {
    return this.request("GET", `changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`);
  }
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>> {
    return this.request("POST", "mutations", mutation);
  }

  private async request<Result>(method: string, path: string, body?: unknown): Promise<Result> {
    return this.requestAt(this.syncUrl, method, path, body);
  }

  private async fileRequest<Result>(method: string, path: string, body?: unknown): Promise<Result> {
    return this.requestAt(this.filesUrl, method, path, body);
  }

  private async requestAt<Result>(baseUrl: string, method: string, path: string, body?: unknown): Promise<Result> {
    const response = await fetch(`${baseUrl}/${path}`, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.replicaToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    if (!response.ok) throw new SyncError(value?.error?.code ?? "sync_failed", value?.error?.message ?? "Sync request failed.");
    return value as Result;
  }
}

class BinaryPartReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private remainder = new Uint8Array();

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.remainder.byteLength === 0) {
        const next = await this.iterator.next();
        if (next.done) throw new SyncError("pending_file_snapshot_corrupt", "Pending file bytes ended early.");
        if (!(next.value instanceof Uint8Array)) throw new SyncError("pending_file_snapshot_corrupt", "Pending file bytes are invalid.");
        this.remainder = new Uint8Array(next.value);
        if (this.remainder.byteLength === 0) continue;
      }
      const count = Math.min(length - offset, this.remainder.byteLength);
      output.set(this.remainder.subarray(0, count), offset);
      offset += count;
      this.remainder = this.remainder.slice(count);
    }
    return output;
  }

  async expectEnd(): Promise<void> {
    if (this.remainder.byteLength > 0) throw new SyncError("pending_file_snapshot_corrupt", "Pending file bytes are oversized.");
    while (true) {
      const next = await this.iterator.next();
      if (next.done) return;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > 0) {
        throw new SyncError("pending_file_snapshot_corrupt", "Pending file bytes are oversized.");
      }
    }
  }
}

function validatePreparedUpload(
  part: PreparedFilePart,
  transferId: string,
  partIndex: number,
  offset: number,
  contentLength: number
): void {
  let url: URL;
  try {
    url = new URL(part.url);
  } catch {
    throw new SyncError("invalid_sync_response", "Authority returned an invalid object URL.");
  }
  if (
    part.protocol_version !== 1
    || part.type !== "file_part"
    || part.transfer_id !== transferId
    || part.part_index !== partIndex
    || part.offset !== offset
    || part.content_length !== contentLength
    || part.method.toUpperCase() !== "PUT"
    || !secureHttpEndpoint(url)
    || url.username
    || url.password
    || !url.hostname
  ) throw new SyncError("invalid_sync_response", "Authority returned an invalid prepared upload part.");
}

function safeObjectHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (["authorization", "cookie", "host", "proxy-authorization", "content-length"].includes(name.toLowerCase())) continue;
    result.set(name, value);
  }
  return result;
}

async function* readableStreamBytes(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function secureHttpEndpoint(url: URL): boolean {
  return url.protocol === "https:"
    || (
      url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    );
}

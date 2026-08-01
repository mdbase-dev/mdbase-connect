import type {
  CollectionFileDescriptor,
  FileTransferSession,
  JsonObject,
  PreparedFilePart,
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
        const prepared = await this.fileRequest<PreparedFilePart>(
          "POST",
          `downloads/${encodeURIComponent(transferId)}/parts`,
          {
            protocol_version: 1,
            type: "prepare_file_download_part",
            transfer_id: transferId,
            part_index: partIndex
          }
        );
        validatePreparedDownload(prepared, transferId, partIndex, offset, contentLength);
        const response = await fetch(prepared.url, {
          method: "GET",
          headers: safeObjectHeaders(prepared.headers),
          redirect: "manual"
        });
        if (!response.ok || response.type === "opaqueredirect") {
          throw new SyncError(
            "file_download_failed",
            `Object storage returned HTTP ${response.status}.`
          );
        }
        const declaredLength = response.headers.get("content-length");
        if (declaredLength !== null && Number(declaredLength) !== contentLength) {
          throw new SyncError(
            "file_integrity_failed",
            "Object storage returned a file part with the wrong length."
          );
        }
        if (!response.body) {
          throw new SyncError("file_download_failed", "Object storage returned no response body.");
        }
        let received = 0;
        for await (const chunk of readableStreamBytes(response.body)) {
          received += chunk.byteLength;
          if (!Number.isSafeInteger(received) || received > contentLength) {
            throw new SyncError("file_integrity_failed", "Object storage returned an oversized file part.");
          }
          yield chunk;
        }
        if (received !== contentLength) {
          throw new SyncError(
            "file_integrity_failed",
            "Object storage returned a file part with the wrong length."
          );
        }
      }
    } finally {
      await this.fileRequest("DELETE", `transfers/${encodeURIComponent(transferId)}`)
        .catch(() => undefined);
    }
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

function validatePreparedDownload(
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
    throw new SyncError("invalid_sync_response", "The authority returned an invalid object URL.");
  }
  if (
    part.protocol_version !== 1
    || part.type !== "file_part"
    || part.transfer_id !== transferId
    || part.part_index !== partIndex
    || part.offset !== offset
    || part.content_length !== contentLength
    || part.method.toUpperCase() !== "GET"
    || !secureHttpEndpoint(url)
    || url.username
    || url.password
    || !url.hostname
  ) {
    throw new SyncError(
      "invalid_sync_response",
      "The authority returned an invalid prepared file part."
    );
  }
}

function safeObjectHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (["host", "content-length"].includes(name.toLowerCase())) continue;
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

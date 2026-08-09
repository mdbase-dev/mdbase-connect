import type {
  CollectionFileDescriptor as WireCollectionFileDescriptor,
  CommitFileUploadReceipt,
  DeleteFileReceipt as WireDeleteFileReceipt,
  FileCapability,
  FileTransferSession,
  FileTransferStatus,
  ListFilesPage,
  MoveFileReceipt,
  PreparedFilePart,
  UploadedFilePart
} from "@mdbase-dev/connect-protocol";
import { FILE_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectError } from "./errors.js";
import { IncrementalSha256 } from "./file-sha256.js";
import { BinaryPartReader } from "./file-stream-source.js";
import {
  MAX_BUFFERED_DOWNLOAD_BYTES,
  MAX_OBJECT_ATTEMPTS,
  SHA256_DIGEST,
  UUID,
  browserObjectHeaders,
  chunkLength,
  hashBlob,
  mapConcurrent,
  normalizeFileError,
  requirePreparedPart,
  requireTransferSession,
  requireTransferStatus,
  retryChunk,
  sourceBlob,
  throwIfAborted,
  uploadBodyBytes,
  uploadBodyLength,
  validConcurrency,
  validPageSize,
  type FileSource,
  type UploadPartBody
} from "./file-transfer-internals.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import {
  createRequestBudget,
  resolveConnectTimeouts,
  type ResolvedConnectTimeouts,
  withCooperativeRequestBudget
} from "./request-budget.js";

export type MdbaseFileSource = FileSource;

export interface CollectionFileDescriptor {
  fileId: string;
  path: string;
  revision: string;
  contentDigest: `sha256:${string}`;
  size: number;
  mediaType?: string;
  mediaClass: import("@mdbase-dev/connect-protocol").FileMediaClass;
  modifiedAt: string;
}

export interface MdbaseFileDeleteReceipt {
  protocolVersion: 1;
  type: "file_deleted";
  mutationId: string;
  fileId: string;
  previousPath: string;
  revision: string;
}

export interface MdbaseFileStreamSource {
  /** Exact plaintext byte length. */
  size: number;
  /** SHA-256 commitment verified by both this client and the authority. */
  contentDigest: `sha256:${string}`;
  /**
   * A one-shot byte source. Each yielded chunk must fit within the upload part
   * size negotiated by the authority; ordinary browser and Node streams do.
   */
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  mediaType?: string;
}

export interface MdbaseFileProgress {
  phase: "hashing" | "uploading" | "downloading";
  transferredBytes: number;
  totalBytes: number;
}

export interface MdbaseFileListOptions extends ConnectRequestOptions {
  folder?: string;
  pageSize?: number;
}

export interface MdbaseFileUploadOptions extends ConnectRequestOptions {
  mediaType?: string;
  ifRevision?: string;
  concurrency?: number;
  /** Stable retry key. Reuse it after an ambiguous failure to resume or replay commit. */
  transferId?: string;
  onProgress?: (progress: MdbaseFileProgress) => void;
}

export type MdbaseFileStreamUploadOptions = Omit<
  MdbaseFileUploadOptions,
  "concurrency"
>;

export interface MdbaseFileDownloadOptions extends ConnectRequestOptions {
  concurrency?: number;
  onProgress?: (progress: MdbaseFileProgress) => void;
}

export interface MdbaseFileMoveOptions extends ConnectRequestOptions {
  ifRevision?: string;
  /** Reuse after an ambiguous network failure to receive the original receipt. */
  mutationId?: string;
}

export interface MdbaseFileDeleteOptions extends ConnectRequestOptions {
  ifRevision?: string;
  /** Reuse after an ambiguous network failure to receive the original receipt. */
  mutationId?: string;
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

/** Internal authenticated hosted-object delivery seam. */
export interface MdbaseHostedFileTransport {
  downloadPart(
    session: FileTransferSession,
    partIndex: number,
    expectedLength: number,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>>;
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
    private readonly framed?: MdbaseFramedFileTransport,
    private readonly hosted?: MdbaseHostedFileTransport,
    private readonly timeouts: ResolvedConnectTimeouts = resolveConnectTimeouts()
  ) {}

  async *list(options: MdbaseFileListOptions = {}): AsyncGenerator<CollectionFileDescriptor> {
    const budget = createRequestBudget(options, this.timeouts.requestMs);
    const signal = budget.signal;
    try {
    this.requireAction("list");
    let after: string | undefined;
    do {
      throwIfAborted(signal);
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
        signal
      );
      if (page.protocol_version !== 1 || page.type !== "files_page" || !Array.isArray(page.files)) {
        throw connectError("invalid_operation_response", "The authority returned an invalid file page.");
      }
      for (const file of page.files) {
        throwIfAborted(signal);
        yield clientFileDescriptor(file);
      }
      after = page.next;
    } while (after);
    } finally {
      budget.dispose();
    }
  }

  async upload(
    path: string,
    source: MdbaseFileSource,
    options: MdbaseFileUploadOptions = {}
  ): Promise<CollectionFileDescriptor> {
    return withCooperativeRequestBudget(options, this.timeouts.uploadMs, (budget) =>
      this.uploadWithinBudget(path, source, { ...options, signal: budget.signal, timeoutMs: null })
    );
  }

  private async uploadWithinBudget(
    path: string,
    source: MdbaseFileSource,
    options: MdbaseFileUploadOptions
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
    return this.uploadKnownSource(
      path,
      blob.size,
      `sha256:${digest}`,
      (options.mediaType ?? blob.type) || undefined,
      options,
      concurrency,
      async (_partIndex, offset, length) => blob.slice(offset, offset + length)
    );
  }

  /**
   * Upload a one-shot byte stream without accumulating multiple file parts.
   * SDK memory is bounded by one assembled negotiated part plus at most one
   * source chunk; a single-part upload may therefore hold the complete file.
   * Reuse `transferId` with a newly opened source after an ambiguous failure.
   */
  async uploadStream(
    path: string,
    source: MdbaseFileStreamSource,
    options: MdbaseFileStreamUploadOptions = {}
  ): Promise<CollectionFileDescriptor> {
    return withCooperativeRequestBudget(options, this.timeouts.uploadMs, (budget) =>
      this.uploadStreamWithinBudget(path, source, {
        ...options,
        signal: budget.signal,
        timeoutMs: null
      })
    );
  }

  private async uploadStreamWithinBudget(
    path: string,
    source: MdbaseFileStreamSource,
    options: MdbaseFileStreamUploadOptions
  ): Promise<CollectionFileDescriptor> {
    this.requireAction(options.ifRevision ? "replace" : "add");
    if (!Number.isSafeInteger(source.size) || source.size < 0) {
      throw connectError("invalid_request", "Streamed file size must be a non-negative safe integer.");
    }
    if (!SHA256_DIGEST.test(source.contentDigest)) {
      throw connectError("invalid_request", "Streamed files require a lowercase SHA-256 content digest.");
    }
    const reader = new BinaryPartReader(source.stream, options.signal);
    const hash = new IncrementalSha256();
    return this.uploadKnownSource(
      path,
      source.size,
      source.contentDigest,
      options.mediaType ?? source.mediaType,
      options,
      1,
      async (_partIndex, _offset, length) => {
        const bytes = await reader.read(length);
        hash.update(bytes);
        return bytes;
      },
      async () => {
        await reader.expectEnd();
        if (`sha256:${hash.digestHex()}` !== source.contentDigest) {
          throw connectError(
            "invalid_request",
            "Streamed file bytes do not match the declared SHA-256 digest."
          );
        }
      },
      () => reader.close(),
      (partSize) => reader.setMaxSourceChunkBytes(partSize)
    );
  }

  private async uploadKnownSource(
    path: string,
    size: number,
    contentDigest: `sha256:${string}`,
    mediaType: string | undefined,
    options: MdbaseFileStreamUploadOptions,
    concurrency: number,
    readPart: (partIndex: number, offset: number, length: number) => Promise<UploadPartBody>,
    finishSource?: () => Promise<void>,
    closeSource?: () => Promise<void>,
    prepareSource?: (partSize: number) => void
  ): Promise<CollectionFileDescriptor> {
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
          size,
          content_digest: contentDigest,
          ...(mediaType ? { media_type: mediaType } : {}),
          ...(options.ifRevision ? { if_revision: options.ifRevision } : {})
        },
        options.signal
      );
      requireTransferSession(session, transferId, "upload");
      if (session.total_size !== size || session.strategy.kind === "object_ranges") {
        throw connectError("invalid_operation_response", "The authority returned an incompatible upload strategy.");
      }
      const framed = session.strategy.kind === "framed_chunks";
      if (framed && !this.framed) {
        throw connectError("invalid_operation_response", "Encrypted file chunk delivery is unavailable.");
      }
      const partSize = session.strategy.kind === "object_put"
        ? Math.max(1, size)
        : session.strategy.kind === "framed_chunks"
          ? session.strategy.chunk_size
          : session.strategy.part_size;
      const partCount = session.strategy.kind === "object_put"
        ? 1
        : Math.ceil(size / partSize);
      const status = await this.request<FileTransferStatus>(
        "GET",
        `transfers/${encodeURIComponent(transferId)}`,
        undefined,
        options.signal
      );
      requireTransferStatus(status, session);
      if (status.state !== "open" && status.state !== "committed") {
        throw connectError(
          "invalid_operation_response",
          `The authority cannot resume a ${status.state} file transfer.`
        );
      }
      prepareSource?.(partSize);
      if (!framed && status.received.length === partCount) {
        const replay = await this.tryReplayUploadCommit(
          transferId,
          session.strategy.kind === "object_multipart" ? status.uploaded_parts : undefined,
          options.signal
        );
        if (replay) {
          committed = true;
          return clientFileDescriptor(replay.file);
        }
      }
      const received = new Set(status.received);
      const uploadedParts = new Map(
        status.uploaded_parts.map((part) => [part.part_number - 1, part])
      );
      let transferredBytes = [...received].reduce(
        (total, index) => total + chunkLength(size, partSize, index),
        0
      );
      const parts = await mapConcurrent(partCount, concurrency, async (partIndex) => {
        const offset = partIndex * partSize;
        const length = Math.min(partSize, Math.max(0, size - offset));
        const part = await readPart(partIndex, offset, length);
        if (uploadBodyLength(part) !== length) {
          throw connectError("invalid_request", "Streamed file bytes ended before the declared size.");
        }
        if (received.has(partIndex)) return uploadedParts.get(partIndex) ?? null;
        const uploaded = framed
          ? await retryChunk(
            async () => this.framed!.uploadChunk(
              session,
              partIndex,
              await uploadBodyBytes(part),
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
          totalBytes: size
        });
        return uploaded;
      });
      await finishSource?.();
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
        || receipt.file.path !== path
        || receipt.file.size !== size
        || receipt.file.content_digest !== contentDigest
      ) {
        throw connectError("invalid_operation_response", "The authority returned an invalid file receipt.");
      }
      committed = true;
      return clientFileDescriptor(receipt.file);
    } catch (error) {
      throw normalizeFileError(error);
    } finally {
      await closeSource?.().catch(() => undefined);
      if (!committed && options.transferId === undefined) await this.abort(transferId);
    }
  }

  async download(
    file: CollectionFileDescriptor,
    options: MdbaseFileDownloadOptions = {}
  ): Promise<Blob> {
    if (file.size > MAX_BUFFERED_DOWNLOAD_BYTES) {
      throw connectError(
        "invalid_request",
        `download() buffers at most ${MAX_BUFFERED_DOWNLOAD_BYTES} bytes; use downloadStream() for larger files.`
      );
    }
    const stream = await this.downloadStream(file, options);
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
    return new Blob(chunks.map((chunk) => {
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      return copy.buffer;
    }), { type: file.mediaType ?? "" });
  }

  /** Download and verify a file with network backpressure and bounded buffering. */
  async downloadStream(
    file: CollectionFileDescriptor,
    options: MdbaseFileDownloadOptions = {}
  ): Promise<ReadableStream<Uint8Array>> {
    return withCooperativeRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.openDownloadStream(file, options, budget.signal)
    );
  }

  private async openDownloadStream(
    file: CollectionFileDescriptor,
    options: MdbaseFileDownloadOptions,
    startupSignal: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    this.requireAction("read");
    const concurrency = validConcurrency(options.concurrency);
    const transferId = crypto.randomUUID();
    let session: FileTransferSession;
    try {
      session = await this.request<FileTransferSession>("POST", "downloads", {
        protocol_version: FILE_PROTOCOL_VERSION,
        type: "open_file_download",
        transfer_id: transferId,
        file_id: file.fileId,
        revision: file.revision
      }, startupSignal);
      requireTransferSession(session, transferId, "download");
      if (session.total_size !== file.size
          || session.strategy.kind !== "object_ranges"
            && session.strategy.kind !== "framed_chunks") {
        throw connectError("invalid_operation_response", "The authority returned an incompatible download session.");
      }
      if (session.strategy.kind === "framed_chunks" && !this.framed) {
        throw connectError("invalid_operation_response", "Encrypted file chunk delivery is unavailable.");
      }
      if (session.strategy.kind === "object_ranges" && file.size > 0 && !this.hosted) {
        throw connectError("invalid_operation_response", "Authenticated hosted file delivery is unavailable.");
      }
    } catch (error) {
      await this.abort(transferId);
      throw normalizeFileError(error);
    }

    const partSize = session.strategy.kind === "framed_chunks"
      ? session.strategy.chunk_size
      : session.strategy.part_size;
    const partCount = Math.ceil(file.size / partSize);
    const hash = new IncrementalSha256();
    let partIndex = 0;
    let partRemaining = 0;
    let hostedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let receivedBytes = 0;
    let closed = false;
    const deliveryController = new AbortController();
    const deliverySignal = options.signal
      ? AbortSignal.any([options.signal, deliveryController.signal])
      : deliveryController.signal;
    type FramedChunkResult =
      | { readonly ok: true; readonly chunk: Uint8Array }
      | { readonly ok: false; readonly error: unknown };
    const framedChunks = new Map<number, Promise<FramedChunkResult>>();
    let nextFramedPart = 0;
    const queueFramedChunks = () => {
      if (session.strategy.kind !== "framed_chunks") return;
      while (nextFramedPart < partCount && framedChunks.size < concurrency) {
        const index = nextFramedPart;
        nextFramedPart += 1;
        const pending = retryChunk(
          () => this.framed!.downloadChunk(session, index, deliverySignal),
          deliverySignal
        ).then<FramedChunkResult, FramedChunkResult>(
          (chunk) => ({ ok: true, chunk }),
          (error: unknown) => ({ ok: false, error })
        );
        framedChunks.set(index, pending);
      }
    };
    const finish = async () => {
      if (closed) return;
      closed = true;
      deliveryController.abort();
      await hostedReader?.cancel().catch(() => undefined);
      hostedReader = null;
      await Promise.all(framedChunks.values());
      framedChunks.clear();
      await this.abort(transferId);
    };
    const verify = () => {
      if (receivedBytes !== file.size || `sha256:${hash.digestHex()}` !== file.contentDigest) {
        throw connectError("invalid_operation_response", "Downloaded file bytes failed integrity verification.");
      }
    };

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          throwIfAborted(deliverySignal);
          if (session.strategy.kind === "object_ranges") {
            while (true) {
              if (!hostedReader) {
                if (partIndex >= partCount) {
                  verify();
                  await finish();
                  controller.close();
                  return;
                }
                const offset = partIndex * partSize;
                partRemaining = Math.min(partSize, file.size - offset);
                const body = await retryChunk(
                  () => this.hosted!.downloadPart(
                    session,
                    partIndex,
                    partRemaining,
                    deliverySignal
                  ),
                  deliverySignal
                );
                hostedReader = body.getReader();
              }
              const next = await hostedReader.read();
              if (next.done) {
                hostedReader.releaseLock();
                hostedReader = null;
                if (partRemaining !== 0) {
                  throw connectError(
                    "invalid_operation_response",
                    "A hosted file range ended before its declared byte length."
                  );
                }
                partIndex += 1;
                continue;
              }
              if (!(next.value instanceof Uint8Array)) {
                throw connectError(
                  "invalid_operation_response",
                  "A hosted file range returned a non-byte chunk."
                );
              }
              if (next.value.byteLength === 0) continue;
              if (next.value.byteLength > partRemaining) {
                throw connectError(
                  "invalid_operation_response",
                  "A hosted file range exceeded its declared byte length."
                );
              }
              partRemaining -= next.value.byteLength;
              hash.update(next.value);
              receivedBytes += next.value.byteLength;
              options.onProgress?.({
                phase: "downloading",
                transferredBytes: receivedBytes,
                totalBytes: file.size
              });
              controller.enqueue(next.value);
              return;
            }
          }
          if (partIndex >= partCount) {
            verify();
            await finish();
            controller.close();
            return;
          }
          const offset = partIndex * partSize;
          const length = Math.min(partSize, file.size - offset);
          queueFramedChunks();
          const pending = framedChunks.get(partIndex);
          if (!pending) {
            throw connectError("invalid_operation_response", "A file chunk was not scheduled.");
          }
          const result = await pending;
          framedChunks.delete(partIndex);
          if (!result.ok) throw result.error;
          const chunk = result.chunk;
          if (chunk.byteLength !== length) {
            throw connectError("invalid_operation_response", "A file chunk had the wrong byte length.");
          }
          hash.update(chunk);
          receivedBytes += chunk.byteLength;
          partIndex += 1;
          queueFramedChunks();
          options.onProgress?.({
            phase: "downloading",
            transferredBytes: receivedBytes,
            totalBytes: file.size
          });
          if (partIndex === partCount) {
            verify();
          }
          controller.enqueue(chunk);
          if (partIndex === partCount) {
            await finish();
            controller.close();
          }
        } catch (error) {
          await finish();
          controller.error(normalizeFileError(error));
        }
      },
      cancel: finish
    });
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
    return withCooperativeRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.moveWithinBudget(file, path, { ...options, signal: budget.signal, timeoutMs: null })
    );
  }

  private async moveWithinBudget(
    file: CollectionFileDescriptor,
    path: string,
    options: MdbaseFileMoveOptions
  ): Promise<CollectionFileDescriptor> {
    this.requireAction("move");
    const mutationId = options.mutationId ?? crypto.randomUUID();
    let receipt: MoveFileReceipt;
    try {
      receipt = await this.request<MoveFileReceipt>(
        "POST",
        `${encodeURIComponent(file.fileId)}/move`,
        {
          protocol_version: FILE_PROTOCOL_VERSION,
          type: "move_file",
          mutation_id: mutationId,
          file_id: file.fileId,
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
      || receipt.file.file_id !== file.fileId
      || receipt.file.path !== path
    ) {
      throw connectError("invalid_operation_response", "The authority returned an invalid file move receipt.");
    }
    return clientFileDescriptor(receipt.file);
  }

  async delete(
    file: CollectionFileDescriptor,
    options: MdbaseFileDeleteOptions = {}
  ): Promise<MdbaseFileDeleteReceipt> {
    return withCooperativeRequestBudget(options, this.timeouts.requestMs, (budget) =>
      this.deleteWithinBudget(file, { ...options, signal: budget.signal, timeoutMs: null })
    );
  }

  private async deleteWithinBudget(
    file: CollectionFileDescriptor,
    options: MdbaseFileDeleteOptions
  ): Promise<MdbaseFileDeleteReceipt> {
    this.requireAction("delete");
    const mutationId = options.mutationId ?? crypto.randomUUID();
    let receipt: WireDeleteFileReceipt;
    try {
      receipt = await this.request<WireDeleteFileReceipt>(
        "POST",
        `${encodeURIComponent(file.fileId)}/delete`,
        {
          protocol_version: FILE_PROTOCOL_VERSION,
          type: "delete_file",
          mutation_id: mutationId,
          file_id: file.fileId,
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
      || receipt.file_id !== file.fileId
      || receipt.previous_path !== file.path
    ) {
      throw connectError("invalid_operation_response", "The authority returned an invalid file delete receipt.");
    }
    return {
      protocolVersion: receipt.protocol_version,
      type: receipt.type,
      mutationId: receipt.mutation_id,
      fileId: receipt.file_id,
      previousPath: receipt.previous_path,
      revision: receipt.revision
    };
  }

  private async uploadPart(
    transferId: string,
    partIndex: number,
    offset: number,
    body: UploadPartBody,
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

function clientFileDescriptor(file: WireCollectionFileDescriptor): CollectionFileDescriptor {
  return {
    fileId: file.file_id,
    path: file.path,
    revision: file.revision,
    contentDigest: file.content_digest,
    size: file.size,
    ...(file.media_type ? { mediaType: file.media_type } : {}),
    mediaClass: file.media_class,
    modifiedAt: file.modified_at
  };
}

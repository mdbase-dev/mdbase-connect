import { createHash } from "node:crypto";
import type {
  CollectionFileDescriptor as WireCollectionFileDescriptor,
  FileCapability
} from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnectError } from "./errors.js";
import {
  MdbaseFileClient,
  type CollectionFileDescriptor,
  type MdbaseFramedFileTransport,
  type MdbaseHostedFileTransport
} from "./files.js";

const capability: FileCapability = {
  kind: "files",
  protocol_version: 1,
  actions: ["list", "read", "add", "replace", "move", "delete"],
  scope: { kind: "collection" }
};

afterEach(() => vi.restoreAllMocks());

describe("MdbaseFileClient", () => {
  it("hides cursor paging behind an async iterable", async () => {
    const calls: string[] = [];
    const client = fileClient(async (_method, path) => {
      calls.push(path ?? "");
      return calls.length === 1
        ? { protocol_version: 1, type: "files_page", files: [wireDescriptor("one.bin", bytes("one"))], next: "next" }
        : { protocol_version: 1, type: "files_page", files: [wireDescriptor("two.bin", bytes("two"))] };
    });

    const files = [];
    for await (const file of client.list({ folder: "Assets", pageSize: 25 })) files.push(file.path);

    expect(files).toEqual(["one.bin", "two.bin"]);
    expect(calls[0]).toContain("folder=Assets");
    expect(calls[0]).toContain("limit=25");
    expect(calls[1]).toContain("after=next");
  });

  it("hashes and uploads a single object without exposing prepared storage details", async () => {
    const content = bytes("hello R2");
    const controls: Array<{ path?: string; input?: any }> = [];
    const progress: string[] = [];
    const client = fileClient(async (_method, path, input) => {
      controls.push({ path, input });
      if (path === "uploads") return uploadSession(input.transfer_id, { kind: "object_put" }, content.length);
      if (path?.endsWith("/parts")) return prepared(input.transfer_id, 0, 0, content.length, "PUT", "https://r2.example/upload");
      if (path?.endsWith("/commit")) {
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireDescriptor("Assets/hello.bin", content)
        };
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(undefined, {
      status: 200,
      headers: { etag: '"single"' }
    }));

    const file = await client.upload("Assets/hello.bin", content, {
      onProgress: ({ phase }) => progress.push(phase)
    });

    expect(file.path).toBe("Assets/hello.bin");
    expect(controls[0]?.input).toMatchObject({
      path: "Assets/hello.bin",
      size: content.length,
      content_digest: digest(content)
    });
    expect(controls.at(-1)?.input).not.toHaveProperty("parts");
    expect(progress).toContain("hashing");
    expect(progress).toContain("uploading");
  });

  it("uploads multipart data concurrently and commits canonical ETags", async () => {
    const content = Uint8Array.from({ length: 17 }, (_, index) => index);
    const commits: any[] = [];
    const client = fileClient(async (_method, path, input) => {
      if (path === "uploads") return uploadSession(input.transfer_id, { kind: "object_multipart", part_size: 8 }, content.length);
      if (path?.endsWith("/parts")) {
        const index = input.part_number - 1;
        return prepared(input.transfer_id, index, index * 8, Math.min(8, content.length - index * 8), "PUT", `https://r2.example/upload/${index}`);
      }
      if (path?.endsWith("/commit")) {
        commits.push(input);
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireDescriptor("large.bin", content)
        };
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const index = Number(String(request).split("/").at(-1));
      return new Response(undefined, { status: 200, headers: { etag: `etag-${index}` } });
    });

    await client.upload("large.bin", content, { concurrency: 3 });

    expect(commits[0].parts).toEqual([
      { part_number: 1, etag: "etag-0" },
      { part_number: 2, etag: "etag-1" },
      { part_number: 3, etag: "etag-2" }
    ]);
  });

  it("resumes multipart uploads from authority-returned R2 part receipts", async () => {
    const content = Uint8Array.from({ length: 17 }, (_, index) => index);
    const preparedParts: number[] = [];
    const client = fileClient(async (_method, path, input) => {
      if (path === "uploads") {
        return uploadSession(
          input.transfer_id,
          { kind: "object_multipart", part_size: 8 },
          content.length
        );
      }
      if (path?.endsWith("/parts")) {
        const index = input.part_number - 1;
        preparedParts.push(index);
        return prepared(
          input.transfer_id,
          index,
          index * 8,
          Math.min(8, content.length - index * 8),
          "PUT",
          `https://r2.example/upload/${index}`
        );
      }
      if (path?.endsWith("/commit")) {
        expect(input.parts).toEqual([
          { part_number: 1, etag: "etag-0" },
          { part_number: 2, etag: "etag-existing" },
          { part_number: 3, etag: "etag-2" }
        ]);
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireDescriptor("resumed.bin", content)
        };
      }
      throw new Error(`Unexpected control path ${path}`);
    }, undefined, undefined, (transferId) => ({
      protocol_version: 1,
      type: "file_transfer_status",
      transfer_id: transferId,
      state: "open",
      received: [1],
      received_bytes: 8,
      uploaded_parts: [{ part_number: 2, etag: "etag-existing" }]
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const index = Number(String(request).split("/").at(-1));
      return new Response(undefined, { status: 200, headers: { etag: `etag-${index}` } });
    });

    await expect(client.upload("resumed.bin", content)).resolves.toMatchObject({
      path: "resumed.bin"
    });
    expect(preparedParts.sort()).toEqual([0, 2]);
  });

  it("uploads irregular byte streams with one negotiated part in memory", async () => {
    const content = Uint8Array.from({ length: 19 }, (_, index) => index + 1);
    const uploaded: Uint8Array[] = [];
    const progress: number[] = [];
    let committedParts: unknown;
    const expected = descriptor("stream.bin", content);
    const client = fileClient(async (_method, path, input) => {
      if (path === "uploads") {
        return uploadSession(input.transfer_id, { kind: "object_multipart", part_size: 8 }, content.length);
      }
      if (path?.endsWith("/parts")) {
        const index = input.part_number - 1;
        return prepared(
          input.transfer_id,
          index,
          index * 8,
          Math.min(8, content.length - index * 8),
          "PUT",
          `https://r2.example/stream/${index}`
        );
      }
      if (path?.endsWith("/commit")) {
        committedParts = input.parts;
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireFile(expected)
        };
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      const value = await requestBodyBytes(init?.body);
      expect(value.byteLength).toBeLessThanOrEqual(8);
      uploaded.push(value);
      return new Response(undefined, {
        status: 200,
        headers: { etag: `etag-${uploaded.length}` }
      });
    });
    const source = (async function* () {
      yield content.slice(0, 2);
      yield content.slice(2, 10);
      yield content.slice(10, 12);
      yield content.slice(12);
    })();

    await expect(client.uploadStream("stream.bin", {
      size: content.byteLength,
      contentDigest: digest(content),
      stream: source
    }, {
      onProgress: ({ phase, transferredBytes }) => {
        expect(phase).toBe("uploading");
        progress.push(transferredBytes);
      }
    })).resolves.toEqual(expected);

    expect(new Uint8Array(uploaded.flatMap((part) => [...part]))).toEqual(content);
    expect(committedParts).toEqual([
      { part_number: 1, etag: "etag-1" },
      { part_number: 2, etag: "etag-2" },
      { part_number: 3, etag: "etag-3" }
    ]);
    expect(progress).toEqual([8, 16, 19]);
  });

  it("verifies a streamed digest before commit and closes the source on failure", async () => {
    const content = bytes("stream integrity");
    let committed = false;
    let aborted = false;
    let closed = false;
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") {
        return uploadSession(input.transfer_id, { kind: "object_put" }, content.length);
      }
      if (path?.endsWith("/parts")) {
        return prepared(input.transfer_id, 0, 0, content.length, "PUT", "https://r2.example/stream");
      }
      if (path?.endsWith("/commit")) {
        committed = true;
        throw new Error("commit must not run");
      }
      if (method === "DELETE") {
        aborted = true;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(undefined, { status: 200 }));
    const source = (async function* () {
      try {
        yield content;
      } finally {
        closed = true;
      }
    })();

    await expect(client.uploadStream("stream.bin", {
      size: content.byteLength,
      contentDigest: digest(bytes("different bytes")),
      stream: source
    })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("SHA-256")
    });
    expect(committed).toBe(false);
    expect(aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("rejects source chunks larger than the negotiated upload part", async () => {
    const content = bytes("ninebytes");
    let uploaded = false;
    let aborted = false;
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") {
        return uploadSession(
          input.transfer_id,
          { kind: "object_multipart", part_size: 4 },
          content.length
        );
      }
      if (path?.endsWith("/parts")) {
        uploaded = true;
        throw new Error("oversized source chunks must fail before upload");
      }
      if (method === "DELETE") {
        aborted = true;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });

    await expect(client.uploadStream("stream.bin", {
      size: content.length,
      contentDigest: digest(content),
      stream: (async function* () { yield content; })()
    })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("negotiated 4-byte")
    });
    expect(uploaded).toBe(false);
    expect(aborted).toBe(true);
  });

  it("resumes streamed uploads without re-sending accepted parts", async () => {
    const content = Uint8Array.from({ length: 17 }, (_, index) => 30 + index);
    const preparedParts: number[] = [];
    const expected = descriptor("resumed-stream.bin", content);
    const client = fileClient(async (_method, path, input) => {
      if (path === "uploads") {
        return {
          ...uploadSession(input.transfer_id, { kind: "object_multipart", part_size: 8 }, content.length),
          received: [1],
          uploaded_parts: [{ part_number: 2, etag: "etag-existing" }]
        };
      }
      if (path?.endsWith("/parts")) {
        const index = input.part_number - 1;
        preparedParts.push(index);
        return prepared(
          input.transfer_id,
          index,
          index * 8,
          Math.min(8, content.length - index * 8),
          "PUT",
          `https://r2.example/resume-stream/${index}`
        );
      }
      if (path?.endsWith("/commit")) {
        expect(input.parts).toEqual([
          { part_number: 1, etag: "etag-0" },
          { part_number: 2, etag: "etag-existing" },
          { part_number: 3, etag: "etag-2" }
        ]);
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireFile(expected)
        };
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const index = Number(String(request).split("/").at(-1));
      return new Response(undefined, { status: 200, headers: { etag: `etag-${index}` } });
    });

    await expect(client.uploadStream("resumed-stream.bin", {
      size: content.byteLength,
      contentDigest: digest(content),
      stream: (async function* () {
        yield content.slice(0, 8);
        yield content.slice(8, 16);
        yield content.slice(16);
      })()
    }, {
      transferId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    })).resolves.toEqual(expected);
    expect(preparedParts).toEqual([0, 2]);
  });

  it("cancels a readable upload source and aborts a new transfer", async () => {
    const content = bytes("abcdefgh");
    const controller = new AbortController();
    let sourceCancelled = false;
    let transferAborted = false;
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") {
        return uploadSession(input.transfer_id, { kind: "object_multipart", part_size: 4 }, content.length);
      }
      if (path?.endsWith("/parts")) {
        const index = input.part_number - 1;
        return prepared(input.transfer_id, index, index * 4, 4, "PUT", `https://r2.example/cancel/${index}`);
      }
      if (method === "DELETE") {
        transferAborted = true;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(undefined, {
      status: 200,
      headers: { etag: "etag-1" }
    }));
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(content.slice(0, 4));
      },
      cancel() {
        sourceCancelled = true;
      }
    });

    await expect(client.uploadStream("cancel.bin", {
      size: content.byteLength,
      contentDigest: digest(content),
      stream
    }, {
      signal: controller.signal,
      onProgress: () => controller.abort()
    })).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(sourceCancelled).toBe(true);
    expect(transferAborted).toBe(true);
  });

  it("cancels a readable stream while its next chunk is pending", async () => {
    const content = bytes("wait");
    const controller = new AbortController();
    let sourceCancelled = false;
    let transferAborted = false;
    let startedRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") {
        return uploadSession(
          input.transfer_id,
          { kind: "object_multipart", part_size: content.length },
          content.length
        );
      }
      if (method === "DELETE") {
        transferAborted = true;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        startedRead();
      },
      cancel() {
        sourceCancelled = true;
      }
    }, { highWaterMark: 0 });

    const upload = client.uploadStream("pending-readable.bin", {
      size: content.byteLength,
      contentDigest: digest(content),
      stream
    }, { signal: controller.signal });
    await readStarted;
    controller.abort();

    await expect(upload).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(sourceCancelled).toBe(true);
    expect(transferAborted).toBe(true);
  });

  it("does not wait for a stalled async iterator to cooperate with cancellation", async () => {
    const content = bytes("wait");
    const controller = new AbortController();
    let iteratorClosed = false;
    let transferAborted = false;
    let startedRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      startedRead = resolve;
    });
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            startedRead();
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
          return() {
            iteratorClosed = true;
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          }
        };
      }
    };
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") {
        return uploadSession(
          input.transfer_id,
          { kind: "object_multipart", part_size: content.length },
          content.length
        );
      }
      if (method === "DELETE") {
        transferAborted = true;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });

    const upload = client.uploadStream("pending-iterable.bin", {
      size: content.byteLength,
      contentDigest: digest(content),
      stream: source
    }, { signal: controller.signal });
    await readStarted;
    controller.abort();

    await expect(upload).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(iteratorClosed).toBe(true);
    expect(transferAborted).toBe(true);
  });

  it("reassembles revision-pinned ranges in order and verifies the digest", async () => {
    const content = bytes("ordered range download");
    const file = descriptor("Assets/download.bin", content);
    let aborted = false;
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return uploadSession(input.transfer_id, { kind: "object_ranges", part_size: 7 }, content.length, "download");
      }
      if (method === "DELETE") {
        aborted = true;
        return { protocol_version: 1, type: "file_transfer_status", state: "aborted" };
      }
      throw new Error(`Unexpected control path ${path}`);
    }, undefined, {
      async downloadPart(_session, index) {
        const part = content.slice(index * 7, Math.min(content.length, (index + 1) * 7));
        return byteStream(part.slice(0, 2), part.slice(2));
      }
    });

    await expect(client.downloadBytes(file, { concurrency: 3 })).resolves.toEqual(content);
    expect(aborted).toBe(true);
  });

  it("fails closed on corrupt object bytes and cleans up the transfer", async () => {
    const content = bytes("expected");
    const file = descriptor("expected.bin", content);
    let aborts = 0;
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return uploadSession(input.transfer_id, { kind: "object_ranges", part_size: content.length }, content.length, "download");
      }
      if (method === "DELETE") {
        aborts += 1;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    }, undefined, {
      async downloadPart() {
        return byteStream(bytes("corrupt!"));
      }
    });

    await expect(client.download(file)).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({ code: "invalid_operation_response" })
    );
    expect(aborts).toBe(1);
  });

  it("fails a truncated hosted range without retrying after delivery begins", async () => {
    const content = bytes("expected bytes");
    const file = descriptor("expected.bin", content);
    let attempts = 0;
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return uploadSession(
          input.transfer_id,
          { kind: "object_ranges", part_size: content.length },
          content.length,
          "download"
        );
      }
      if (method === "DELETE") return {};
      throw new Error(`Unexpected control path ${path}`);
    }, undefined, {
      async downloadPart() {
        attempts += 1;
        return byteStream(content.slice(0, 3));
      }
    });

    await expect(client.downloadBytes(file)).rejects.toMatchObject({
      code: "invalid_operation_response",
      message: expect.stringContaining("ended before")
    });
    expect(attempts).toBe(1);
  });

  it("cancels an active hosted response when its consumer stops", async () => {
    const content = bytes("cancel hosted stream");
    const file = descriptor("cancel.bin", content);
    let responseCancelled = false;
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return uploadSession(
          input.transfer_id,
          { kind: "object_ranges", part_size: content.length },
          content.length,
          "download"
        );
      }
      if (method === "DELETE") return {};
      throw new Error(`Unexpected control path ${path}`);
    }, undefined, {
      async downloadPart() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content.slice(0, 3));
          },
          cancel() {
            responseCancelled = true;
          }
        });
      }
    });

    const stream = await client.downloadStream(file);
    const reader = stream.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel();
    expect(responseCancelled).toBe(true);
  });

  it("moves and deletes stable file identities with optimistic revisions", async () => {
    const original = descriptor("Assets/original.bin", bytes("stable"));
    const moved = { ...original, path: "Archive/final.bin", revision: "file:2" };
    const moveMutationId = crypto.randomUUID();
    const deleteMutationId = crypto.randomUUID();
    const calls: Array<{ method: string; path?: string; input?: any }> = [];
    const client = fileClient(async (method, path, input) => {
      calls.push({ method, path, input });
      if (path?.endsWith("/move")) {
        return {
          protocol_version: 1,
          type: "file_moved",
          mutation_id: input.mutation_id,
          file: wireFile(moved)
        };
      }
      return {
        protocol_version: 1,
        type: "file_deleted",
        mutation_id: input.mutation_id,
        file_id: moved.fileId,
        previous_path: moved.path,
        revision: "file:deleted:3"
      };
    });

    await expect(client.move(original, moved.path, { mutationId: moveMutationId }))
      .resolves.toEqual(moved);
    await expect(client.delete(moved, { mutationId: deleteMutationId })).resolves.toMatchObject({
      type: "file_deleted",
      fileId: moved.fileId,
      previousPath: moved.path
    });

    expect(calls[0]).toEqual({
      method: "POST",
      path: `${encodeURIComponent(original.fileId)}/move`,
      input: {
        protocol_version: 1,
        type: "move_file",
        mutation_id: moveMutationId,
        file_id: original.fileId,
        if_revision: original.revision,
        from_path: original.path,
        path: moved.path,
        update_references: false
      }
    });
    expect(calls[1]).toEqual({
      method: "POST",
      path: `${encodeURIComponent(moved.fileId)}/delete`,
      input: {
        protocol_version: 1,
        type: "delete_file",
        mutation_id: deleteMutationId,
        file_id: moved.fileId,
        if_revision: moved.revision,
        path: moved.path
      }
    });
  });

  it("requires lifecycle actions and validates identity-bound receipts", async () => {
    const value = descriptor("file.bin", bytes("value"));
    const request = vi.fn(async () => ({
      protocol_version: 1,
      type: "file_moved",
      mutation_id: crypto.randomUUID(),
      file: { ...value, file_id: crypto.randomUUID(), path: "moved.bin" }
    }));
    const readOnly = new MdbaseFileClient(
      () => ({ ...capability, actions: ["list", "read"] }),
      request
    );
    await expect(readOnly.move(value, "moved.bin")).rejects.toMatchObject({ code: "not_authorized" });
    await expect(readOnly.delete(value)).rejects.toMatchObject({ code: "not_authorized" });
    expect(request).not.toHaveBeenCalled();

    const invalid = new MdbaseFileClient(() => capability, request);
    await expect(invalid.move(value, "moved.bin")).rejects.toMatchObject({
      code: "invalid_operation_response"
    });
  });

  it("rejects missing actions before opening a transfer", async () => {
    const request = vi.fn();
    const client = new MdbaseFileClient(
      () => ({ ...capability, actions: ["list"] }),
      request
    );
    await expect(client.upload("no.bin", bytes("no"))).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({ code: "not_authorized" })
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("retries multipart parts without ETags, then aborts instead of committing", async () => {
    const content = bytes("multipart");
    let preparations = 0;
    let aborts = 0;
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") {
        return uploadSession(input.transfer_id, { kind: "object_multipart", part_size: 5 }, content.length);
      }
      if (path?.endsWith("/parts")) {
        preparations += 1;
        const index = input.part_number - 1;
        return prepared(
          input.transfer_id,
          index,
          index * 5,
          Math.min(5, content.length - index * 5),
          "PUT",
          `https://r2.example/upload/${index}`
        );
      }
      if (method === "DELETE") {
        aborts += 1;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(undefined, { status: 200 }));

    await expect(client.upload("multipart.bin", content, { concurrency: 1 })).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({ code: "temporarily_unavailable" })
    );
    expect(preparations).toBe(3);
    expect(aborts).toBe(1);
  });

  it("fails closed when hosted ranges are negotiated without an authenticated transport", async () => {
    const content = bytes("range integrity");
    const file = descriptor("range.bin", content);
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return uploadSession(input.transfer_id, { kind: "object_ranges", part_size: content.length }, content.length, "download");
      }
      if (method === "DELETE") return {};
      throw new Error(`Unexpected control path ${path}`);
    });
    const objectFetch = vi.spyOn(globalThis, "fetch");

    await expect(client.download(file)).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({ code: "invalid_operation_response" })
    );
    expect(objectFetch).not.toHaveBeenCalled();
  });

  it("round-trips empty files without object range requests", async () => {
    const content = new Uint8Array();
    const file = descriptor("empty.bin", content);
    const paths: string[] = [];
    const client = fileClient(async (method, path, input) => {
      paths.push(`${method} ${path}`);
      if (path === "downloads") {
        return uploadSession(input.transfer_id, { kind: "object_ranges", part_size: 1024 }, 0, "download");
      }
      if (method === "DELETE") return {};
      throw new Error(`Unexpected control path ${path}`);
    });
    const objectFetch = vi.spyOn(globalThis, "fetch");

    await expect(client.downloadBytes(file)).resolves.toEqual(content);
    expect(paths.some((path) => path.endsWith("/parts"))).toBe(false);
    expect(objectFetch).not.toHaveBeenCalled();
  });

  it("resumes encrypted framed uploads from the authority's received chunk set", async () => {
    const content = bytes("resume framed upload");
    const uploaded: Array<{ index: number; bytes: Uint8Array }> = [];
    let commit: any;
    const framed: MdbaseFramedFileTransport = {
      async uploadChunk(_session, index, chunk) {
        uploaded.push({ index, bytes: chunk });
      },
      async downloadChunk() {
        throw new Error("unexpected download");
      }
    };
    const client = fileClient(async (_method, path, input) => {
      if (path === "uploads") {
        return framedSession(input.transfer_id, content.length, "upload", [0], 6);
      }
      if (path?.endsWith("/commit")) {
        commit = input;
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireDescriptor("resume.bin", content)
        };
      }
      throw new Error(`Unexpected control path ${path}`);
    }, framed);

    await expect(client.upload("resume.bin", content, { concurrency: 2 })).resolves.toMatchObject({
      path: "resume.bin"
    });

    expect(uploaded.map(({ index }) => index)).toEqual([1, 2, 3]);
    expect(uploaded.map(({ bytes: chunk }) => [...chunk])).toEqual([
      [...content.slice(6, 12)],
      [...content.slice(12, 18)],
      [...content.slice(18)]
    ]);
    expect(commit).not.toHaveProperty("parts");
  });

  it("replays an idempotent commit after an ambiguous transport failure", async () => {
    const content = bytes("commit replay");
    let commits = 0;
    let aborts = 0;
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") {
        return uploadSession(input.transfer_id, { kind: "object_put" }, content.length);
      }
      if (path?.endsWith("/parts")) {
        return prepared(input.transfer_id, 0, 0, content.length, "PUT", "https://r2.example/upload");
      }
      if (path?.endsWith("/commit")) {
        commits += 1;
        if (commits < 3) throw new Error("response lost");
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireDescriptor("replay.bin", content)
        };
      }
      if (method === "DELETE") {
        aborts += 1;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(undefined, { status: 200 }));

    await expect(client.upload("replay.bin", content)).resolves.toMatchObject({
      path: "replay.bin"
    });
    expect(commits).toBe(3);
    expect(aborts).toBe(0);
  });

  it("resumes a caller-keyed object upload without re-sending committed bytes", async () => {
    const content = bytes("already in r2");
    const transferId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let commits = 0;
    const client = fileClient(async (_method, path, input) => {
      if (path === "uploads") {
        return {
          ...uploadSession(transferId, { kind: "object_put" }, content.length),
          received: [0]
        };
      }
      if (path?.endsWith("/commit")) {
        commits += 1;
        return {
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: input.transfer_id,
          file: wireDescriptor("resumed.bin", content)
        };
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    const objectFetch = vi.spyOn(globalThis, "fetch");

    await expect(client.upload("resumed.bin", content, { transferId })).resolves.toMatchObject({
      path: "resumed.bin"
    });
    expect(commits).toBe(1);
    expect(objectFetch).not.toHaveBeenCalled();
  });

  it("prefetches encrypted frames concurrently and emits them in order", async () => {
    const content = bytes("framed chunks stay ordered");
    const file = descriptor("framed.bin", content);
    let active = 0;
    let maximumActive = 0;
    const framed: MdbaseFramedFileTransport = {
      async uploadChunk() {
        throw new Error("unexpected upload");
      },
      async downloadChunk(session, index) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const size = session.strategy.kind === "framed_chunks"
          ? session.strategy.chunk_size
          : 0;
        const chunk = content.slice(index * size, Math.min(content.length, (index + 1) * size));
        active -= 1;
        return chunk;
      }
    };
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return framedSession(input.transfer_id, content.length, "download", [], 7);
      }
      if (method === "DELETE") return {};
      throw new Error(`Unexpected control path ${path}`);
    }, framed);

    await expect(client.downloadBytes(file, { concurrency: 4 })).resolves.toEqual(content);
    expect(maximumActive).toBe(4);
  });

  it("requires the streaming API for downloads above the bounded convenience limit", async () => {
    const request = vi.fn();
    const client = fileClient(request);
    const file = {
      ...descriptor("large.bin", bytes("placeholder")),
      size: 64 * 1024 * 1024 + 1
    };

    await expect(client.download(file)).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("downloadStream()")
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when an authority negotiates frames without a framed transport", async () => {
    const content = bytes("no transport");
    const client = fileClient(async (method, path, input) => {
      if (path === "uploads") return framedSession(input.transfer_id, content.length, "upload");
      if (method === "DELETE") return {};
      throw new Error(`Unexpected control path ${path}`);
    });

    await expect(client.upload("no-transport.bin", content)).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({ code: "invalid_operation_response" })
    );
  });
});

function fileClient(
  handler: (method: "GET" | "POST" | "DELETE", path?: string, input?: any) => Promise<any>,
  framed?: MdbaseFramedFileTransport,
  hosted?: MdbaseHostedFileTransport,
  status?: (transferId: string, session: any) => Promise<any> | any
): MdbaseFileClient {
  const sessions = new Map<string, any>();
  return new MdbaseFileClient(
    () => capability,
    async <Result>(method: "GET" | "POST" | "DELETE", path?: string, input?: unknown) => {
      const statusMatch = method === "GET" ? path?.match(/^transfers\/(.+)$/u) : undefined;
      if (statusMatch) {
        const transferId = decodeURIComponent(statusMatch[1]!);
        const session = sessions.get(transferId);
        if (session && status) return await status(transferId, session) as Result;
        if (session) {
          const partSize = session.strategy.kind === "object_put"
            ? Math.max(1, session.total_size)
            : session.strategy.part_size ?? session.strategy.chunk_size;
          return {
            protocol_version: 1,
            type: "file_transfer_status",
            transfer_id: transferId,
            state: "open",
            received: session.received,
            received_bytes: session.received.reduce(
              (total: number, index: number) =>
                total + Math.min(partSize, Math.max(0, session.total_size - index * partSize)),
              0
            ),
            uploaded_parts: session.uploaded_parts ?? []
          } as Result;
        }
      }
      const result = await handler(method, path, input);
      if (method === "POST" && path === "uploads" && result?.type === "file_transfer") {
        sessions.set(result.transfer_id, result);
      }
      return result as Result;
    },
    framed,
    hosted
  );
}

function uploadSession(
  transferId: string,
  strategy: { kind: "object_put" } | { kind: "object_multipart" | "object_ranges"; part_size: number },
  totalSize: number,
  direction: "upload" | "download" = "upload"
) {
  return {
    protocol_version: 1,
    type: "file_transfer",
    transfer_id: transferId,
    direction,
    protection: "transport_tls",
    strategy,
    total_size: totalSize,
    expires_at: "2026-08-01T12:00:00Z",
    received: []
  };
}

function framedSession(
  transferId: string,
  totalSize: number,
  direction: "upload" | "download",
  received: number[] = [],
  chunkSize = 1024
) {
  return {
    protocol_version: 1,
    type: "file_transfer",
    transfer_id: transferId,
    direction,
    protection: "grant_aead_v1",
    strategy: { kind: "framed_chunks", chunk_size: chunkSize },
    total_size: totalSize,
    expires_at: "2026-08-01T12:00:00Z",
    received
  };
}

function prepared(
  transferId: string,
  partIndex: number,
  offset: number,
  contentLength: number,
  method: "GET" | "PUT",
  url: string
) {
  return {
    protocol_version: 1,
    type: "file_part",
    transfer_id: transferId,
    part_index: partIndex,
    offset,
    content_length: contentLength,
    method,
    url,
    headers: {},
    expires_at: "2026-08-01T12:00:00Z"
  };
}

function descriptor(path: string, content: Uint8Array): CollectionFileDescriptor {
  return {
    fileId: crypto.randomUUID(),
    path,
    revision: `rev-${path}`,
    contentDigest: digest(content),
    size: content.length,
    mediaClass: "other",
    modifiedAt: "2026-08-01T12:00:00Z"
  };
}

function wireDescriptor(path: string, content: Uint8Array): WireCollectionFileDescriptor {
  return wireFile(descriptor(path, content));
}

function wireFile(file: CollectionFileDescriptor): WireCollectionFileDescriptor {
  return {
    file_id: file.fileId,
    path: file.path,
    revision: file.revision,
    content_digest: file.contentDigest,
    size: file.size,
    ...(file.mediaType ? { media_type: file.mediaType } : {}),
    media_class: file.mediaClass,
    modified_at: file.modifiedAt
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

async function requestBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Expected a binary request body.");
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

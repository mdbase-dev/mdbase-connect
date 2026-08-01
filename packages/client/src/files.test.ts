import { createHash } from "node:crypto";
import type {
  CollectionFileDescriptor,
  FileCapability
} from "@mdbase/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MdbaseConnectError } from "./errors.js";
import { MdbaseFileClient, type MdbaseFramedFileTransport } from "./files.js";

const capability: FileCapability = {
  kind: "files",
  protocol_version: 1,
  actions: ["list", "read", "add", "replace"],
  scope: { kind: "collection" }
};

afterEach(() => vi.restoreAllMocks());

describe("MdbaseFileClient", () => {
  it("hides cursor paging behind an async iterable", async () => {
    const calls: string[] = [];
    const client = fileClient(async (_method, path) => {
      calls.push(path ?? "");
      return calls.length === 1
        ? { protocol_version: 1, type: "files_page", files: [descriptor("one.bin", bytes("one"))], next: "next" }
        : { protocol_version: 1, type: "files_page", files: [descriptor("two.bin", bytes("two"))] };
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
          file: descriptor("Assets/hello.bin", content)
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
          file: descriptor("large.bin", content)
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

  it("reassembles revision-pinned ranges in order and verifies the digest", async () => {
    const content = bytes("ordered range download");
    const file = descriptor("Assets/download.bin", content);
    let aborted = false;
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return uploadSession(input.transfer_id, { kind: "object_ranges", part_size: 7 }, content.length, "download");
      }
      if (path?.endsWith("/parts")) {
        const offset = input.part_index * 7;
        return {
          ...prepared(input.transfer_id, input.part_index, offset, Math.min(7, content.length - offset), "GET", `https://r2.example/download/${input.part_index}`)
        };
      }
      if (method === "DELETE") {
        aborted = true;
        return { protocol_version: 1, type: "file_transfer_status", state: "aborted" };
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const index = Number(String(request).split("/").at(-1));
      const chunk = content.slice(index * 7, Math.min(content.length, (index + 1) * 7));
      return new Response(chunk, { status: 206 });
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
      if (path?.endsWith("/parts")) return prepared(input.transfer_id, 0, 0, content.length, "GET", "https://r2.example/corrupt");
      if (method === "DELETE") {
        aborts += 1;
        return {};
      }
      throw new Error(`Unexpected control path ${path}`);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes("corrupt!"), { status: 206 }));

    await expect(client.download(file)).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({ code: "invalid_operation_response" })
    );
    expect(aborts).toBe(1);
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

  it("rejects prepared parts that do not match the requested range", async () => {
    const content = bytes("range integrity");
    const file = descriptor("range.bin", content);
    const client = fileClient(async (method, path, input) => {
      if (path === "downloads") {
        return uploadSession(input.transfer_id, { kind: "object_ranges", part_size: content.length }, content.length, "download");
      }
      if (path?.endsWith("/parts")) {
        return prepared(input.transfer_id, 0, 1, content.length, "GET", "https://r2.example/range");
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
          file: descriptor("resume.bin", content)
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

  it("downloads encrypted frames concurrently, reorders them, and verifies integrity", async () => {
    const content = bytes("framed chunks stay ordered");
    const file = descriptor("framed.bin", content);
    const framed: MdbaseFramedFileTransport = {
      async uploadChunk() {
        throw new Error("unexpected upload");
      },
      async downloadChunk(session, index) {
        await new Promise((resolve) => setTimeout(resolve, (4 - index) * 2));
        const size = session.strategy.kind === "framed_chunks"
          ? session.strategy.chunk_size
          : 0;
        return content.slice(index * size, Math.min(content.length, (index + 1) * size));
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
  framed?: MdbaseFramedFileTransport
): MdbaseFileClient {
  return new MdbaseFileClient(
    () => capability,
    async <Result>(method: "GET" | "POST" | "DELETE", path?: string, input?: unknown) =>
      await handler(method, path, input) as Result,
    framed
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
    file_id: crypto.randomUUID(),
    path,
    revision: `rev-${path}`,
    content_digest: digest(content),
    size: content.length,
    media_class: "other",
    modified_at: "2026-08-01T12:00:00Z"
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

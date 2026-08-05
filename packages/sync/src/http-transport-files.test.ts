import type { CollectionFileDescriptor } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSyncTransport } from "./http-transport.js";

const authorityId = "01910000-0000-7000-8000-000000000001";
const transferIdPattern = /^[0-9a-f-]{36}$/iu;
const bytes = new TextEncoder().encode("R2-bytes");
const descriptor: CollectionFileDescriptor = {
  file_id: "01920000-0000-7000-8000-000000000002",
  path: "images/r2.png",
  revision: "file:revision:1",
  content_digest: "sha256:1822065da77f7029260d42ba10ea7a7d0006f7e9bb23669ad35daa5a94e8602a",
  size: bytes.byteLength,
  media_type: "image/png",
  media_class: "image",
  modified_at: "2026-08-01T00:00:00.000Z"
};

afterEach(() => vi.unstubAllGlobals());

describe("hosted sync file data plane", () => {
  it("streams authenticated bounded ranges and keeps bytes out of control JSON", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let transferId = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/files/downloads")) {
        const body = JSON.parse(String(init?.body));
        transferId = body.transfer_id;
        expect(transferId).toMatch(transferIdPattern);
        expect(body).toEqual({
          protocol_version: 1,
          type: "open_file_download",
          transfer_id: transferId,
          file_id: descriptor.file_id,
          revision: descriptor.revision
        });
        return Response.json({
          protocol_version: 1,
          type: "file_transfer",
          transfer_id: transferId,
          direction: "download",
          protection: "transport_tls",
          strategy: { kind: "object_ranges", part_size: 3 },
          total_size: descriptor.size,
          expires_at: "2026-08-01T01:00:00.000Z",
          received: []
        });
      }
      if (url.includes(`/downloads/${transferId}/parts/`)) {
        const part = Number(url.slice(url.lastIndexOf("/") + 1));
        const value = bytes.slice(part * 3, part * 3 + 3);
        return new Response(value, { headers: { "content-length": String(value.byteLength) } });
      }
      if (url.endsWith(`/files/transfers/${transferId}`)) {
        return Response.json({
          protocol_version: 1,
          type: "file_transfer_status",
          transfer_id: transferId,
          state: "aborted",
          received: [],
          received_bytes: 0
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const transport = new HttpSyncTransport(
      `https://connect.example/v1/authorities/${authorityId}/sync`,
      "replica-token"
    );
    const received: number[] = [];
    for await (const chunk of transport.downloadFile(descriptor)) received.push(...chunk);

    expect(new Uint8Array(received)).toEqual(bytes);
    for (const call of calls.filter((call) => call.url.startsWith("https://connect.example"))) {
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer replica-token");
      if (call.init?.body) expect(String(call.init.body)).not.toContain("R2-bytes");
    }
    expect(calls.filter((call) => call.url.includes(`/downloads/${transferId}/parts/`))).toHaveLength(3);
  });

  it("uses the sync snapshot boundary for file manifests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        `https://connect.example/v1/authorities/${authorityId}/sync/files/snapshot?snapshot_id=snapshot-1&page=next`
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer replica-token");
      return Response.json({
        protocol_version: 1,
        type: "file_snapshot_page",
        snapshot_id: "snapshot-1",
        scope_epoch: 1,
        cursor: 4,
        files: []
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpSyncTransport(
      `https://connect.example/v1/authorities/${authorityId}/sync`,
      "replica-token"
    );

    await transport.fileSnapshot("snapshot-1", "next");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops a multipart download when the authority revokes a later range", async () => {
    let transferId = "";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/files/downloads")) {
        transferId = JSON.parse(String(init?.body)).transfer_id;
        return Response.json({
          protocol_version: 1,
          type: "file_transfer",
          transfer_id: transferId,
          direction: "download",
          protection: "transport_tls",
          strategy: { kind: "object_ranges", part_size: 3 },
          total_size: descriptor.size,
          expires_at: "2026-08-01T01:00:00.000Z",
          received: []
        });
      }
      if (url.endsWith(`/downloads/${transferId}/parts/0`)) {
        return new Response(bytes.slice(0, 3), { headers: { "content-length": "3" } });
      }
      if (url.endsWith(`/downloads/${transferId}/parts/1`)) {
        return Response.json(
          { error: { code: "not_authorized", message: "Replica access was revoked." } },
          { status: 403 }
        );
      }
      if (url.endsWith(`/files/transfers/${transferId}`)) return Response.json({ state: "aborted" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpSyncTransport(
      `https://connect.example/v1/authorities/${authorityId}/sync`,
      "replica-token"
    );
    await expect(async () => {
      for await (const _chunk of transport.downloadFile(descriptor)) {
        // drain
      }
    }).rejects.toMatchObject({ code: "not_authorized" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/parts/2"))).toBe(false);
  });

  it("streams a multipart writable snapshot directly to R2 and commits its ETags", async () => {
    const transferId = "01940000-0000-7000-8000-000000000001";
    const uploaded: Uint8Array[] = [];
    const controlBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://r2.example/upload")) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        uploaded.push(new Uint8Array(await (init?.body as Blob).arrayBuffer()));
        return new Response(null, { status: 200, headers: { etag: `etag-${uploaded.length}` } });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body) controlBodies.push(body);
      if (url.endsWith("/files/uploads")) {
        return Response.json({
          protocol_version: 1,
          type: "file_transfer",
          transfer_id: transferId,
          direction: "upload",
          protection: "transport_tls",
          strategy: { kind: "object_multipart", part_size: 3 },
          total_size: bytes.byteLength,
          expires_at: "2026-08-01T01:00:00.000Z",
          received: []
        });
      }
      if (url.endsWith(`/files/transfers/${transferId}`)) {
        return Response.json({
          protocol_version: 1,
          type: "file_transfer_status",
          transfer_id: transferId,
          state: "open",
          received: [],
          received_bytes: 0,
          uploaded_parts: []
        });
      }
      if (url.endsWith(`/uploads/${transferId}/parts`)) {
        const index = body.part_number - 1;
        const length = Math.min(3, bytes.byteLength - index * 3);
        return Response.json({
          protocol_version: 1,
          type: "file_part",
          transfer_id: transferId,
          part_index: index,
          offset: index * 3,
          content_length: length,
          method: "PUT",
          url: `https://r2.example/upload?part=${index}`,
          headers: { authorization: "must-not-forward", "content-length": String(length) },
          expires_at: "2026-08-01T01:00:00.000Z"
        });
      }
      if (url.endsWith(`/uploads/${transferId}/commit`)) {
        expect(body.parts).toEqual([
          { part_number: 1, etag: "etag-1" },
          { part_number: 2, etag: "etag-2" },
          { part_number: 3, etag: "etag-3" }
        ]);
        return Response.json({
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: transferId,
          file: descriptor
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const transport = new HttpSyncTransport(
      `https://connect.example/v1/authorities/${authorityId}/sync`,
      "replica-token"
    );
    const source = (async function* () {
      yield bytes.slice(0, 2);
      yield bytes.slice(2, 7);
      yield bytes.slice(7);
    })();

    const receipt = await transport.uploadFile({
      protocol_version: 1,
      type: "open_file_upload",
      transfer_id: transferId,
      path: descriptor.path,
      size: bytes.byteLength,
      content_digest: descriptor.content_digest,
      media_type: descriptor.media_type
    }, source);

    expect(receipt.file).toEqual(descriptor);
    expect(new Uint8Array(uploaded.flatMap((part) => [...part]))).toEqual(bytes);
    expect(JSON.stringify(controlBodies)).not.toContain("R2-bytes");
  });

  it("recovers an ambiguous committed multipart upload without reading or re-uploading bytes", async () => {
    const transferId = "01940000-0000-7000-8000-000000000002";
    let committed = false;
    let controlCommits = 0;
    let objectPuts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://r2.example/upload")) {
        objectPuts += 1;
        return new Response(null, { status: 200, headers: { etag: `etag-${objectPuts}` } });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/files/uploads")) {
        return Response.json({
          protocol_version: 1,
          type: "file_transfer",
          transfer_id: transferId,
          direction: "upload",
          protection: "transport_tls",
          strategy: { kind: "object_multipart", part_size: 3 },
          total_size: bytes.byteLength,
          expires_at: "2026-08-01T01:00:00.000Z",
          received: [],
          uploaded_parts: []
        });
      }
      if (url.endsWith(`/files/transfers/${transferId}`)) {
        return Response.json({
          protocol_version: 1,
          type: "file_transfer_status",
          transfer_id: transferId,
          state: committed ? "committed" : "open",
          received: committed ? [0, 1, 2] : [],
          received_bytes: committed ? bytes.byteLength : 0,
          uploaded_parts: committed ? [
            { part_number: 1, etag: "etag-1" },
            { part_number: 2, etag: "etag-2" },
            { part_number: 3, etag: "etag-3" }
          ] : []
        });
      }
      if (url.endsWith(`/uploads/${transferId}/parts`)) {
        const index = body.part_number - 1;
        return Response.json({
          protocol_version: 1,
          type: "file_part",
          transfer_id: transferId,
          part_index: index,
          offset: index * 3,
          content_length: Math.min(3, bytes.byteLength - index * 3),
          method: "PUT",
          url: `https://r2.example/upload?part=${index}`,
          headers: {},
          expires_at: "2026-08-01T01:00:00.000Z"
        });
      }
      if (url.endsWith(`/uploads/${transferId}/commit`)) {
        controlCommits += 1;
        if (!committed) {
          committed = true;
          throw new TypeError("connection reset after commit");
        }
        expect(body.parts).toEqual([
          { part_number: 1, etag: "etag-1" },
          { part_number: 2, etag: "etag-2" },
          { part_number: 3, etag: "etag-3" }
        ]);
        return Response.json({
          protocol_version: 1,
          type: "file_upload_committed",
          transfer_id: transferId,
          file: descriptor
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpSyncTransport(
      `https://connect.example/v1/authorities/${authorityId}/sync`,
      "replica-token"
    );
    const request = {
      protocol_version: 1 as const,
      type: "open_file_upload" as const,
      transfer_id: transferId,
      path: descriptor.path,
      size: bytes.byteLength,
      content_digest: descriptor.content_digest
    };
    await expect(transport.uploadFile(request, (async function* () { yield bytes; })()))
      .rejects.toThrow("connection reset after commit");
    let sourceRead = false;
    const receipt = await transport.uploadFile(request, (async function* () {
      sourceRead = true;
      yield bytes;
    })());

    expect(receipt.file).toEqual(descriptor);
    expect(sourceRead).toBe(false);
    expect(objectPuts).toBe(3);
    expect(controlCommits).toBe(2);
  });
});

import type { CollectionFileDescriptor } from "@mdbase/connect-protocol";
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
  it("streams pinned object ranges from R2 and keeps bytes out of Render JSON", async () => {
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
      if (url.endsWith(`/downloads/${transferId}/parts`)) {
        const body = JSON.parse(String(init?.body));
        const offset = body.part_index * 3;
        const contentLength = Math.min(3, descriptor.size - offset);
        return Response.json({
          protocol_version: 1,
          type: "file_part",
          transfer_id: transferId,
          part_index: body.part_index,
          offset,
          content_length: contentLength,
          method: "GET",
          url: `https://r2.example/object?part=${body.part_index}`,
          headers: { range: `bytes=${offset}-${offset + contentLength - 1}` },
          expires_at: "2026-08-01T01:00:00.000Z"
        });
      }
      if (url.startsWith("https://r2.example/object")) {
        const part = Number(new URL(url).searchParams.get("part"));
        const value = bytes.slice(part * 3, part * 3 + 3);
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return new Response(value, {
          status: 206,
          headers: { "content-length": String(value.byteLength) }
        });
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
    expect(calls.filter((call) => call.url.startsWith("https://r2.example"))).toHaveLength(3);
    for (const call of calls.filter((call) => call.url.startsWith("https://connect.example"))) {
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer replica-token");
      if (call.init?.body) expect(String(call.init.body)).not.toContain("R2-bytes");
    }
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

  it("rejects redirects and unsafe prepared object URLs", async () => {
    for (const preparedUrl of [
      "http://r2.example/object",
      "file:///tmp/private",
      "https://user:password@r2.example/object"
    ]) {
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
            strategy: { kind: "object_ranges", part_size: descriptor.size },
            total_size: descriptor.size,
            expires_at: "2026-08-01T01:00:00.000Z",
            received: []
          });
        }
        if (url.endsWith(`/downloads/${transferId}/parts`)) {
          return Response.json({
            protocol_version: 1,
            type: "file_part",
            transfer_id: transferId,
            part_index: 0,
            offset: 0,
            content_length: descriptor.size,
            method: "GET",
            url: preparedUrl,
            headers: {},
            expires_at: "2026-08-01T01:00:00.000Z"
          });
        }
        return Response.json({ state: "aborted" });
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
      }).rejects.toMatchObject({ code: "invalid_sync_response" });
      expect(fetchMock.mock.calls.some(([input]) => String(input) === preparedUrl)).toBe(false);
      vi.unstubAllGlobals();
    }
  });
});

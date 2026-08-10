import type {
  FileFrameHeader,
  FileTransferSession,
  GrantEncryption
} from "@mdbase-dev/connect-protocol";
import { decodeFileFrame } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryGrantKeyStore,
  deriveP256SharedSecret
} from "./crypto.js";
import { MdbaseConnectError } from "./errors.js";
import {
  GrantFileTransferCipher,
  type FileTransferBinding
} from "./file-crypto.js";
import type { StoredToken } from "./internal-types.js";
import { LocalFileTransport } from "./local-file-transport.js";

const ids = {
  grant: "01911111-1111-7111-8111-111111111111",
  application: "01922222-2222-7222-8222-222222222222",
  connector: "01933333-3333-7333-8333-333333333333",
  collection: "01944444-4444-7444-8444-444444444444",
  transfer: "01955555-5555-7555-8555-555555555555"
};

afterEach(() => vi.restoreAllMocks());

describe("LocalFileTransport", () => {
  it("backs off an explicit busy control response before sending a fresh envelope", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fixture = await transportFixture("download", false);
    const requests: Array<{ request_id: string; counter: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const code = requests.length === 1 ? "connector_busy" : "connector_offline";
      return new Response(
        JSON.stringify({ error: { code, message: code } }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    });

    const controlled = fixture.transport.control(
      fixture.token,
      "GET",
      "?limit=10",
      undefined
    );

    await expect(controlled).rejects.toMatchObject({ code: "connector_offline" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.request_id).not.toBe(requests[0]?.request_id);
    expect(requests[1]?.counter).not.toBe(requests[0]?.counter);
  });

  it("encrypts upload frames with the exact negotiated transfer binding", async () => {
    const fixture = await transportFixture("upload");
    const plaintext = new TextEncoder().encode("local upload");
    let received: Uint8Array | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const encoded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const frame = decodeFileFrame(encoded);
      expect(frame.kind).toBe("upload_chunk");
      expect(frame.header).toMatchObject({
        grant_id: ids.grant,
        authority_id: ids.connector,
        transfer_id: ids.transfer,
        chunk_index: 0,
        offset: 0,
        plaintext_length: plaintext.byteLength
      });
      received = await fixture.peerCipher.decryptChunk(encoded);
      return new Response(undefined, { status: 204 });
    });

    await fixture.transport.uploadChunk(fixture.session, 0, plaintext);

    expect(received).toEqual(plaintext);
    expect(fixture.directAvailable).toHaveBeenCalledOnce();
  });

  it("authenticates download frames and rejects chunk substitution", async () => {
    const fixture = await transportFixture("download");
    const plaintext = new TextEncoder().encode("local download");
    const validHeader = header(fixture.encryption, fixture.session, 0, plaintext.byteLength);
    const valid = await fixture.peerCipher.encryptChunk(
      "download_chunk",
      validHeader,
      plaintext
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fileResponse(valid));

    await expect(fixture.transport.downloadChunk(fixture.session, 0)).resolves.toEqual(plaintext);

    const wrong = await fixture.peerCipher.encryptChunk(
      "download_chunk",
      { ...validHeader, total_size: validHeader.total_size + 1 },
      plaintext
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(fileResponse(wrong));
    await expect(fixture.transport.downloadChunk(fixture.session, 0)).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({
        code: "invalid_operation_response"
      })
    );
  });

  it("uses encrypted relay delivery when direct access is not allowed", async () => {
    const fixture = await transportFixture("upload", false);
    const plaintext = new TextEncoder().encode("relay upload");
    let received: Uint8Array | undefined;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(
        `https://connect.example/v1/authorities/${ids.collection}/files/upload`
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
      const encoded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      received = await fixture.peerCipher.decryptChunk(encoded);
      return new Response(undefined, { status: 204 });
    });

    await fixture.transport.uploadChunk(fixture.session, 0, plaintext);

    expect(received).toEqual(plaintext);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.relayAvailable).toHaveBeenCalledOnce();
  });

  it("falls back from an unreachable loopback to the relay with the same chunk", async () => {
    const fixture = await transportFixture("upload");
    const plaintext = new TextEncoder().encode("fallback!!!!");
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("loopback unavailable"))
      .mockImplementationOnce(async (url, init) => {
        expect(String(url)).toContain("https://connect.example/v1/authorities/");
        const encoded = new Uint8Array(await new Response(init?.body).arrayBuffer());
        await expect(fixture.peerCipher.decryptChunk(encoded)).resolves.toEqual(plaintext);
        return new Response(undefined, { status: 204 });
      });

    await fixture.transport.uploadChunk(fixture.session, 0, plaintext);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.directUnavailable).toHaveBeenCalledOnce();
    expect(fixture.relayAvailable).toHaveBeenCalledOnce();
  });

  it("does not bypass an explicit direct authorization rejection", async () => {
    const fixture = await transportFixture("upload");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "direct_operation_rejected", message: "Denied" } }),
      { status: 403, headers: { "content-type": "application/json" } }
    ));

    await expect(fixture.transport.uploadChunk(
      fixture.session,
      0,
      new TextEncoder().encode("denied bytes")
    )).rejects.toEqual(expect.objectContaining<Partial<MdbaseConnectError>>({
      code: "direct_operation_rejected",
      status: 403
    }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.relayAvailable).not.toHaveBeenCalled();
  });

  it("authenticates and decrypts download chunks returned through the relay", async () => {
    const fixture = await transportFixture("download", false);
    const plaintext = new TextEncoder().encode("relay download");
    const encoded = await fixture.peerCipher.encryptChunk(
      "download_chunk",
      header(fixture.encryption, fixture.session, 0, plaintext.byteLength),
      plaintext
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(
        `https://connect.example/v1/authorities/${ids.collection}/files/download/${ids.transfer}/0`
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
      return fileResponse(encoded);
    });

    await expect(fixture.transport.downloadChunk(fixture.session, 0))
      .resolves.toEqual(plaintext);
    expect(fixture.relayAvailable).toHaveBeenCalledOnce();
  });

  it("refreshes an expired relay bearer before retrying an idempotent chunk", async () => {
    const fixture = await transportFixture("upload", false);
    const plaintext = new TextEncoder().encode("refresh me!!");
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { code: "invalid_token", message: "Expired" } }),
        { status: 401, headers: { "content-type": "application/json" } }
      ))
      .mockImplementationOnce(async (_url, init) => {
        const encoded = new Uint8Array(await new Response(init?.body).arrayBuffer());
        await expect(fixture.peerCipher.decryptChunk(encoded)).resolves.toEqual(plaintext);
        return new Response(undefined, { status: 204 });
      });

    await fixture.transport.uploadChunk(fixture.session, 0, plaintext);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.refreshAuthorization).toHaveBeenCalledOnce();
  });

  it("sends encrypted file control through the relay when direct is disabled", async () => {
    const fixture = await transportFixture("upload", false);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe(
        `https://connect.example/v1/authorities/${ids.collection}/files/control`
      );
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({
        type: "encrypted_operation_request",
        operation: "file_control",
        grant_id: ids.grant,
        collection_id: ids.collection
      });
      expect(request).not.toHaveProperty("input");
      return new Response(
        JSON.stringify({ error: { code: "connector_offline", message: "Offline" } }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    });

    await expect(fixture.transport.control(fixture.token, "GET", "", undefined))
      .rejects.toEqual(expect.objectContaining<Partial<MdbaseConnectError>>({
        code: "connector_offline",
        status: 503
      }));
  });

  it("uses a fresh encrypted request when a file read falls back to relay", async () => {
    const fixture = await transportFixture("upload");
    const requests: Array<{ request_id: string; counter: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new TypeError("loopback unavailable");
      return new Response(
        JSON.stringify({ error: { code: "connector_offline", message: "Offline" } }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    });

    await expect(fixture.transport.control(fixture.token, "GET", "", undefined))
      .rejects.toMatchObject({ code: "connector_offline" });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.request_id).not.toBe(requests[0]?.request_id);
    expect(requests[1]?.counter).not.toBe(requests[0]?.counter);
  });

  it("retries an evicted file read once with a fresh encrypted request", async () => {
    const fixture = await transportFixture("upload", false);
    const requests: Array<{ request_id: string; counter: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        error: {
          code: requests.length === 1 ? "fresh_request_required" : "connector_offline",
          message: requests.length === 1 ? "Use a fresh request." : "Offline"
        }
      }), {
        status: requests.length === 1 ? 409 : 503,
        headers: { "content-type": "application/json" }
      });
    });

    await expect(fixture.transport.control(fixture.token, "GET", "", undefined))
      .rejects.toMatchObject({ code: "connector_offline" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.request_id).not.toBe(requests[0]?.request_id);
    expect(requests[1]?.counter).not.toBe(requests[0]?.counter);
  });

  it("keeps the exact encrypted request when a file mutation falls back to relay", async () => {
    const fixture = await transportFixture("upload");
    const request = {
      protocol_version: 1,
      type: "open_file_upload",
      mutation_id: "01977777-7777-7777-8777-777777777777",
      path: "Assets/file.bin",
      size: 12
    };
    const requests: Array<{ request_id: string; counter: string; ciphertext: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new TypeError("loopback unavailable");
      return new Response(
        JSON.stringify({ error: { code: "connector_offline", message: "Offline" } }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    });

    await expect(fixture.transport.control(fixture.token, "POST", "uploads", request))
      .rejects.toMatchObject({ code: "connector_offline" });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it("maps lifecycle mutations to explicit encrypted control routes", async () => {
    const fixture = await transportFixture("upload", false);
    const fileId = "01966666-6666-7666-8666-666666666666";
    const deleteRequest = {
      protocol_version: 1,
      type: "delete_file",
      mutation_id: "01977777-7777-7777-8777-777777777777",
      file_id: fileId,
      if_revision: "file:1",
      path: "Assets/file.bin"
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "connector_offline", message: "Offline" } }),
      { status: 503, headers: { "content-type": "application/json" } }
    ));

    await expect(fixture.transport.control(
      fixture.token,
      "POST",
      `${fileId}/delete`,
      deleteRequest
    )).rejects.toMatchObject({ code: "connector_offline" });
    expect(fetch).toHaveBeenCalledOnce();

    fetch.mockClear();
    await expect(fixture.transport.control(
      fixture.token,
      "POST",
      fileId,
      deleteRequest
    )).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function transportFixture(
  direction: "upload" | "download",
  direct = true
) {
  const applicationStore = new MemoryGrantKeyStore();
  const connectorStore = new MemoryGrantKeyStore();
  const application = await applicationStore.create("grant");
  const connector = await connectorStore.create("connector");
  const encryption: GrantEncryption = {
    protocol_version: 1,
    suite: "P256-HKDF-SHA256-AES256GCM",
    key_id: "local-file-key",
    scope_epoch: 4,
    connector_id: ids.connector,
    collection_id: ids.collection,
    application_agreement_public_key: application.agreementPublicKey,
    connector_agreement_public_key: connector.agreementPublicKey
  };
  const token: StoredToken = {
    version: 1,
    accessToken: "access",
    clientId: ids.application,
    collectionId: ids.collection,
    collectionName: "Local files",
    operations: [],
    scope: { access: "full_collection" },
    expiresAt: Date.now() + 60_000,
    refreshToken: "refresh",
    refreshExpiresAt: Date.now() + 3_600_000,
    grantId: ids.grant,
    encryption,
    fileCapability: {
      kind: "files",
      protocol_version: 1,
      actions: ["list", "read", "add", "replace"],
      scope: { kind: "collection" }
    },
    keyHandle: "grant",
    savedAt: Date.now()
  };
  const session: FileTransferSession = {
    protocol_version: 1,
    type: "file_transfer",
    transfer_id: ids.transfer,
    direction,
    protection: "grant_aead_v1",
    strategy: { kind: "framed_chunks", chunk_size: 65_536 },
    total_size: direction === "upload" ? 12 : 14,
    expires_at: "2026-08-01T12:00:00Z",
    received: []
  };
  const binding: FileTransferBinding = {
    grantId: ids.grant,
    applicationId: ids.application,
    authorityId: ids.connector,
    transferId: ids.transfer,
    direction,
    encryption
  };
  const shared = await deriveP256SharedSecret(
    connector.agreementPrivateKey,
    application.agreementPublicKey
  );
  const peerCipher = await GrantFileTransferCipher.fromSharedSecret(shared, binding);
  const directAvailable = vi.fn();
  const directUnavailable = vi.fn();
  const relayAvailable = vi.fn();
  const refreshAuthorization = vi.fn(async () => token);
  const transport = new LocalFileTransport({
    keyStore: applicationStore,
    serverUrl: "https://connect.example",
    loopbackUrl: "http://127.0.0.1:28485",
    authorizedToken: async () => token,
    refreshAuthorization,
    shouldAttemptDirect: async () => direct,
    onDirectAvailable: directAvailable,
    onDirectUnavailable: directUnavailable,
    onRelayAvailable: relayAvailable
  });
  return {
    transport,
    session,
    encryption,
    token,
    peerCipher,
    directAvailable,
    directUnavailable,
    relayAvailable,
    refreshAuthorization
  };
}

function header(
  encryption: GrantEncryption,
  session: FileTransferSession,
  chunkIndex: number,
  length: number
): FileFrameHeader {
  const chunkSize = session.strategy.kind === "framed_chunks"
    ? session.strategy.chunk_size
    : 0;
  return {
    protocol_version: 1,
    protection: "grant_aead_v1",
    grant_id: ids.grant,
    authority_id: ids.connector,
    collection_id: ids.collection,
    transfer_id: ids.transfer,
    direction: session.direction,
    chunk_size: chunkSize,
    chunk_index: chunkIndex,
    offset: chunkIndex * chunkSize,
    plaintext_length: length,
    total_size: session.total_size,
    scope_epoch: encryption.scope_epoch,
    key_id: encryption.key_id
  };
}

function fileResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/mdbase-connect-file" }
  });
}

import type {
  FileFrameHeader,
  FileTransferSession,
  GrantEncryption
} from "@mdbase/connect-protocol";
import { decodeFileFrame } from "@mdbase/connect-protocol";
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

  it("does not derive keys or touch loopback when direct delivery is not allowed", async () => {
    const fixture = await transportFixture("upload", false);
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(
      fixture.transport.uploadChunk(
        fixture.session,
        0,
        new Uint8Array(fixture.session.total_size)
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<MdbaseConnectError>>({
        code: "temporarily_unavailable"
      })
    );
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
  const transport = new LocalFileTransport({
    keyStore: applicationStore,
    loopbackUrl: "http://127.0.0.1:28485",
    authorizedToken: async () => token,
    shouldAttemptDirect: async () => direct,
    onDirectAvailable: directAvailable
  });
  return { transport, session, encryption, peerCipher, directAvailable };
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

import type {
  EncryptedRelayOperationRequest,
  FileFrameHeader,
  GrantEncryption
} from "@mdbase-dev/connect-protocol";
import {
  encodeFileFrame,
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  FILE_TRANSFER_PROTOCOL_VERSION,
  MAX_FILE_FRAME_BYTES,
  RELAY_ENCRYPTION_SUITE
} from "@mdbase-dev/connect-protocol";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import type { RelayHub } from "../../relay.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { registerLocalFileRoutes } from "./local-routes.js";

const collectionId = "11111111-1111-4111-8111-111111111111";
const connectorId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const applicationId = "44444444-4444-4444-8444-444444444444";
const transferId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
const encryption: GrantEncryption = {
  protocol_version: 1,
  suite: RELAY_ENCRYPTION_SUITE,
  key_id: "key-1",
  scope_epoch: 4,
  connector_id: connectorId,
  collection_id: collectionId,
  application_agreement_public_key: "application-key",
  connector_agreement_public_key: "connector-key"
};
const grant = {
  grant_id: grantId,
  application_id: applicationId,
  connector_id: connectorId,
  local_id: collectionId,
  encryption,
  file_capability: {
    kind: "files",
    protocol_version: 1,
    actions: ["list", "read", "add"],
    scope: { kind: "collection" }
  }
};

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
});

describe("local collection file relay routes", () => {
  it("routes an exactly bound encrypted control envelope", async () => {
    const { app, relay } = await fixture();
    const envelope = encryptedEnvelope();
    vi.mocked(relay.routeEncrypted).mockResolvedValue({
      ...envelope,
      type: "encrypted_operation_response"
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/control`,
      headers: { authorization: "Bearer token" },
      payload: envelope
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().envelope.type).toBe("encrypted_operation_response");
    expect(relay.routeEncrypted).toHaveBeenCalledWith(connectorId, envelope);
  });

  it("distinguishes a stale file-control key from foreign grant metadata", async () => {
    const { app } = await fixture();
    const stale = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/control`,
      headers: { authorization: "Bearer token" },
      payload: { ...encryptedEnvelope(), key_id: "old-key" }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("encryption_binding_stale");

    const foreign = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/control`,
      headers: { authorization: "Bearer token" },
      payload: {
        ...encryptedEnvelope(),
        grant_id: "77777777-7777-4777-8777-777777777777"
      }
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe("invalid_encrypted_envelope");
  });

  it("relays a bounded opaque upload frame without decoding its ciphertext", async () => {
    const { app, relay } = await fixture();
    const encoded = fileFrame("upload_chunk");
    vi.mocked(relay.routeFile).mockImplementation(async (_connector, request) => ({
      kind: "upload_acknowledged",
      header: { ...request.header, type: "upload_acknowledged" },
      payload: new Uint8Array()
    }));

    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/upload`,
      headers: {
        authorization: "Bearer token",
        "content-type": "application/mdbase-connect-file"
      },
      payload: Buffer.from(encoded)
    });

    expect(response.statusCode).toBe(204);
    const request = vi.mocked(relay.routeFile).mock.calls[0]![1];
    expect(request.kind).toBe("upload_chunk");
    expect(request.header).toMatchObject({
      grant_id: grantId,
      transfer_id: transferId,
      chunk_index: 0
    });
    expect([...request.payload]).toEqual([...encoded]);
  });

  it("rejects upload frames bound to another key before relay delivery", async () => {
    const { app, relay } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/upload`,
      headers: {
        authorization: "Bearer token",
        "content-type": "application/mdbase-connect-file"
      },
      payload: Buffer.from(fileFrame("upload_chunk", { key_id: "foreign-key" }))
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_file_frame");
    expect(relay.routeFile).not.toHaveBeenCalled();
  });

  it("validates the connector's inner download frame before returning bytes", async () => {
    const { app, relay } = await fixture();
    const encoded = fileFrame("download_chunk");
    vi.mocked(relay.routeFile).mockImplementation(async (_connector, request) => ({
      kind: "download_chunk",
      header: { ...request.header, type: "download_chunk" },
      payload: encoded
    }));

    const response = await app.inject({
      method: "GET",
      url: `/v1/authorities/${collectionId}/files/download/${transferId}/0`,
      headers: { authorization: "Bearer token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/mdbase-connect-file");
    expect([...response.rawPayload]).toEqual([...encoded]);
  });

  it("enforces file capability, media type, and the binary route body limit", async () => {
    const denied = await fixture({ ...grant, file_capability: null });
    const noCapability = await denied.app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/upload`,
      headers: {
        authorization: "Bearer token",
        "content-type": "application/mdbase-connect-file"
      },
      payload: Buffer.from(fileFrame("upload_chunk"))
    });
    expect(noCapability.statusCode).toBe(403);
    expect(noCapability.json().error).toMatchObject({
      code: "insufficient_access",
      details: {
        required_operations: ["files"],
        granted_operations: [],
        missing_operations: ["files"]
      }
    });

    const allowed = await fixture();
    const wrongMediaType = await allowed.app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/upload`,
      headers: {
        authorization: "Bearer token",
        "content-type": "application/octet-stream"
      },
      payload: Buffer.from(fileFrame("upload_chunk"))
    });
    expect(wrongMediaType.statusCode).toBe(415);

    const oversized = await allowed.app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/files/upload`,
      headers: {
        authorization: "Bearer token",
        "content-type": "application/mdbase-connect-file"
      },
      payload: Buffer.alloc(MAX_FILE_FRAME_BYTES + 1)
    });
    expect(oversized.statusCode).toBe(413);
  });
});

async function fixture(row = grant) {
  const app = Fastify();
  apps.push(app);
  app.addContentTypeParser(
    "application/mdbase-connect-file",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  registerErrorHandler(app);
  const db = {
    query: vi.fn(async () => ({ rows: [row], rowCount: 1 }))
  } as unknown as DatabasePool;
  const relay = {
    routeEncrypted: vi.fn(),
    routeFile: vi.fn()
  } as unknown as RelayHub;
  registerLocalFileRoutes(app, { db, relay });
  await app.ready();
  return { app, db, relay };
}

function encryptedEnvelope(): EncryptedRelayOperationRequest {
  return {
    type: "encrypted_operation_request",
    protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
    suite: RELAY_ENCRYPTION_SUITE,
    request_id: requestId,
    grant_id: grantId,
    application_id: applicationId,
    connector_id: connectorId,
    collection_id: collectionId,
    operation: "file_control",
    scope_epoch: encryption.scope_epoch,
    key_id: encryption.key_id,
    counter: "1",
    ciphertext: "ciphertext"
  };
}

function fileFrame(
  kind: "upload_chunk" | "download_chunk",
  overrides: Partial<FileFrameHeader> = {}
): Uint8Array {
  const header: FileFrameHeader = {
    protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
    protection: "grant_aead_v1",
    grant_id: grantId,
    authority_id: connectorId,
    collection_id: collectionId,
    transfer_id: transferId,
    direction: kind === "upload_chunk" ? "upload" : "download",
    chunk_size: 64 * 1024,
    chunk_index: 0,
    offset: 0,
    plaintext_length: 3,
    total_size: 3,
    scope_epoch: encryption.scope_epoch,
    key_id: encryption.key_id,
    ...overrides
  };
  return encodeFileFrame({
    kind,
    header,
    payload: new Uint8Array(header.plaintext_length + 16)
  });
}

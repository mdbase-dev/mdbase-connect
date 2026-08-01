import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeFileFrame,
  encodeFileFrame,
  type FileFrameHeader,
  type GrantEncryption
} from "@mdbase-dev/connect-protocol";
import { MemoryGrantKeyStore, deriveP256SharedSecret } from "./crypto.js";
import {
  FileTransferCryptoError,
  GrantFileTransferCipher,
  type FileTransferBinding
} from "./file-crypto.js";

const ids = {
  grant: "01911111-1111-7111-8111-111111111111",
  application: "01922222-2222-7222-8222-222222222222",
  connector: "01933333-3333-7333-8333-333333333333",
  authority: "01944444-4444-7444-8444-444444444444",
  collection: "01955555-5555-7555-8555-555555555555",
  transfer: "01966666-6666-7666-8666-666666666666"
};

async function fixture() {
  const applicationStore = new MemoryGrantKeyStore();
  const connectorStore = new MemoryGrantKeyStore();
  const application = await applicationStore.create("grant");
  const connector = await connectorStore.create("connector");
  const encryption: GrantEncryption = {
    protocol_version: 1,
    suite: "P256-HKDF-SHA256-AES256GCM",
    key_id: "enc_test",
    scope_epoch: 7,
    connector_id: ids.connector,
    collection_id: ids.collection,
    application_agreement_public_key: application.agreementPublicKey,
    connector_agreement_public_key: connector.agreementPublicKey
  };
  const binding: FileTransferBinding = {
    grantId: ids.grant,
    applicationId: ids.application,
    authorityId: ids.authority,
    transferId: ids.transfer,
    direction: "upload",
    encryption
  };
  const applicationCipher = await GrantFileTransferCipher.open(applicationStore, "grant", binding);
  const shared = await deriveP256SharedSecret(
    connector.agreementPrivateKey,
    application.agreementPublicKey
  );
  const connectorCipher = await GrantFileTransferCipher.fromSharedSecret(shared, binding);
  const header: FileFrameHeader = {
    protocol_version: 1,
    protection: "grant_aead_v1",
    grant_id: ids.grant,
    authority_id: ids.authority,
    collection_id: ids.collection,
    transfer_id: ids.transfer,
    direction: "upload",
    chunk_size: 65536,
    chunk_index: 0,
    offset: 0,
    plaintext_length: 12,
    total_size: 12,
    scope_epoch: 7,
    key_id: "enc_test"
  };
  return { applicationStore, applicationCipher, connectorCipher, binding, header };
}

describe("file transfer encryption", () => {
  it("matches the shared Rust and browser ciphertext fixture", async () => {
    const golden = JSON.parse(readFileSync(
      new URL("../../protocol/test/fixtures/file-crypto-v1.json", import.meta.url),
      "utf8"
    ));
    const cipher = await GrantFileTransferCipher.fromSharedSecret(
      Buffer.from(golden.shared_secret_base64, "base64"),
      golden.binding
    );
    const encoded = await cipher.encryptChunk(
      golden.binding.direction === "upload" ? "upload_chunk" : "download_chunk",
      golden.header,
      Buffer.from(golden.plaintext_base64, "base64")
    );
    expect(Buffer.from(encoded).toString("base64")).toBe(golden.frame_base64);
    expect(Buffer.from(await cipher.decryptChunk(encoded)).toString("base64"))
      .toBe(golden.plaintext_base64);
  });

  it("uses an independent grant-bound chunk data plane", async () => {
    const { applicationStore, applicationCipher, connectorCipher, header } = await fixture();
    const encoded = await applicationCipher.encryptChunk(
      "upload_chunk",
      header,
      new TextEncoder().encode("hello binary")
    );
    expect(new TextDecoder().decode(await connectorCipher.decryptChunk(encoded))).toBe("hello binary");
    expect(await applicationStore.nextCounter("grant")).toBe("1");
  });

  it("authenticates ciphertext and every mutable frame header field", async () => {
    const { applicationCipher, connectorCipher, header } = await fixture();
    const encoded = await applicationCipher.encryptChunk(
      "upload_chunk",
      header,
      new TextEncoder().encode("hello binary")
    );
    const payloadTamper = encoded.slice();
    payloadTamper[payloadTamper.length - 1] ^= 1;
    await expect(connectorCipher.decryptChunk(payloadTamper)).rejects.toEqual(
      expect.objectContaining<Partial<FileTransferCryptoError>>({ code: "authentication_failed" })
    );

    const decoded = decodeFileFrame(encoded);
    const headerTamper = encodeFileFrame({
      ...decoded,
      header: { ...decoded.header, total_size: 13 }
    });
    await expect(connectorCipher.decryptChunk(headerTamper)).rejects.toEqual(
      expect.objectContaining<Partial<FileTransferCryptoError>>({ code: "authentication_failed" })
    );
  });

  it("rejects transfer substitution before attempting decryption", async () => {
    const { applicationCipher, binding, header } = await fixture();
    const encoded = await applicationCipher.encryptChunk(
      "upload_chunk",
      header,
      new TextEncoder().encode("hello binary")
    );
    const wrongTransfer = await GrantFileTransferCipher.fromSharedSecret(
      new Uint8Array(32),
      { ...binding, transferId: "01977777-7777-7777-8777-777777777777" }
    );
    await expect(wrongTransfer.decryptChunk(encoded)).rejects.toEqual(
      expect.objectContaining<Partial<FileTransferCryptoError>>({ code: "header_binding_mismatch" })
    );
  });

  it("rejects inconsistent plaintext sizes before encryption", async () => {
    const { applicationCipher, header } = await fixture();
    await expect(applicationCipher.encryptChunk(
      "upload_chunk",
      header,
      new Uint8Array(11)
    )).rejects.toEqual(
      expect.objectContaining<Partial<FileTransferCryptoError>>({ code: "plaintext_length_mismatch" })
    );
  });
});

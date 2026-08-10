import { describe, expect, it } from "vitest";
import type { GrantEncryption } from "@mdbase-dev/connect-protocol";
import {
  encryptRelayRequest,
  authorityProofMessage,
  MemoryGrantKeyStore,
  RelayCryptoError,
  signAuthorityRequest
} from "./crypto.js";
import { AUTHORITY_PROOF_HEADERS } from "@mdbase-dev/connect-protocol";

const ids = {
  grant: "01911111-1111-7111-8111-111111111111",
  application: "01922222-2222-7222-8222-222222222222",
  connector: "01933333-3333-7333-8333-333333333333",
  collection: "01944444-4444-7444-8444-444444444444",
  request: "01955555-5555-7555-8555-555555555555"
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
    scope_epoch: 1,
    connector_id: ids.connector,
    collection_id: ids.collection,
    application_agreement_public_key: application.agreementPublicKey,
    connector_agreement_public_key: connector.agreementPublicKey
  };
  return { applicationStore, encryption };
}

describe("encrypted relay client", () => {
  it("keeps private keys non-extractable and emits only ciphertext plus bound metadata", async () => {
    const { applicationStore, encryption } = await fixture();
    const key = await applicationStore.get("grant");
    expect(key?.agreementPrivateKey.extractable).toBe(false);
    const request = await encryptRelayRequest(
      applicationStore,
      "grant",
      { grantId: ids.grant, applicationId: ids.application, encryption },
      "read",
      { path: "private.md", marker: "MUST_NOT_APPEAR" },
      ids.request
    );
    expect(request).toMatchObject({
      type: "encrypted_operation_request",
      protocol_version: 3,
      grant_id: ids.grant,
      application_id: ids.application,
      connector_id: ids.connector,
      collection_id: ids.collection,
      request_id: ids.request,
      operation: "read",
      counter: "1"
    });
    expect(JSON.stringify(request)).not.toContain("private.md");
    expect(JSON.stringify(request)).not.toContain("MUST_NOT_APPEAR");
  });

  it("allocates unique monotonic counters under concurrent load", async () => {
    const { applicationStore, encryption } = await fixture();
    const requests = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      encryptRelayRequest(
        applicationStore,
        "grant",
        { grantId: ids.grant, applicationId: ids.application, encryption },
        "query",
        { index }
      )
    ));
    const counters = requests.map((request) => BigInt(request.counter));
    expect(new Set(counters).size).toBe(50);
    expect(counters.toSorted((left, right) => left < right ? -1 : 1))
      .toEqual(Array.from({ length: 50 }, (_, index) => BigInt(index + 1)));
  });

  it("rejects a missing or substituted application key", async () => {
    const { applicationStore, encryption } = await fixture();
    await applicationStore.delete("grant");
    await expect(encryptRelayRequest(
      applicationStore,
      "grant",
      { grantId: ids.grant, applicationId: ids.application, encryption },
      "read",
      {}
    )).rejects.toEqual(expect.objectContaining<Partial<RelayCryptoError>>({ code: "missing_grant_key" }));
  });

  it("rejects malformed and off-profile P-256 keys before encryption", async () => {
    const { applicationStore, encryption } = await fixture();
    await expect(encryptRelayRequest(
      applicationStore,
      "grant",
      {
        grantId: ids.grant,
        applicationId: ids.application,
        encryption: { ...encryption, connector_agreement_public_key: "not-a-p256-key" }
      },
      "read",
      {}
    )).rejects.toEqual(expect.objectContaining<Partial<RelayCryptoError>>({ code: "invalid_public_key" }));
  });

  it("rejects relay bindings with non-protocol identities", async () => {
    const { applicationStore, encryption } = await fixture();
    await expect(encryptRelayRequest(
      applicationStore,
      "grant",
      {
        grantId: ids.grant,
        applicationId: ids.application,
        encryption: { ...encryption, connector_id: "stale-connector-id" }
      },
      "read",
      {}
    )).rejects.toEqual(expect.objectContaining<Partial<RelayCryptoError>>({
      code: "unsupported_encryption"
    }));
  });

  it("uses an independent non-extractable P-256 key for authority proofs", async () => {
    const store = new MemoryGrantKeyStore();
    const record = await store.create("authority");
    expect(record.agreementPrivateKey.algorithm.name).toBe("ECDH");
    expect(record.signingPrivateKey.algorithm.name).toBe("ECDSA");
    expect(record.agreementPrivateKey.extractable).toBe(false);
    expect(record.signingPrivateKey.extractable).toBe(false);
    expect(record.signingPublicKey).not.toBe(record.agreementPublicKey);
    const timestamp = 1_785_000_000;
    const nonce = "01955555-5555-4555-8555-555555555555";
    const headers = await signAuthorityRequest(store, "authority", record.signingPublicKey, {
      method: "POST",
      target: "/v1/authorities/one/operations/create",
      body: "{\"title\":\"proof\"}",
      credential: "hsa_secret",
      timestamp,
      nonce
    });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlBytes(record.signingPublicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const message = await authorityProofMessage({
      method: "POST",
      target: "/v1/authorities/one/operations/create",
      body: "{\"title\":\"proof\"}",
      credential: "hsa_secret",
      timestamp,
      nonce
    });
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlBytes(headers[AUTHORITY_PROOF_HEADERS.signature]),
      new TextEncoder().encode(message)
    )).toBe(true);
  });
});

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

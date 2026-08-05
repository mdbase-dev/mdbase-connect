import {
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  RELAY_ENCRYPTION_SUITE,
  type EncryptedRelayOperation,
  type EncryptedRelayOperationRequest,
  type EncryptedRelayOperationResponse,
  type GrantEncryption
} from "@mdbase-dev/connect-protocol";

export interface MdbaseFixtureRelayOperation {
  request: EncryptedRelayOperationRequest;
  operation: EncryptedRelayOperation;
  input: unknown;
}

export interface MdbaseConnectorRelayFixture {
  decrypt(request: unknown): Promise<MdbaseFixtureRelayOperation>;
  success(
    request: EncryptedRelayOperationRequest,
    result: unknown
  ): Promise<EncryptedRelayOperationResponse>;
}

export interface FixtureRelayBinding {
  grantId: string;
  applicationId: string;
  encryption: GrantEncryption;
}

export async function generateConnectorKey(): Promise<{
  privateKey: CryptoKey;
  publicKey: string;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as CryptoKeyPair;
  return {
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    ),
    publicKey: encodeBytes(await crypto.subtle.exportKey("raw", pair.publicKey))
  };
}

export function connectorRelayFixture(
  privateKey: CryptoKey,
  binding: FixtureRelayBinding
): MdbaseConnectorRelayFixture {
  return {
    async decrypt(value) {
      const request = encryptedRequest(value, binding);
      const key = await connectorDirectionalKey(privateKey, binding, "request", "decrypt");
      const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: relayNonce(request.counter),
        additionalData: new TextEncoder().encode(relayAad(binding, request, "request")),
        tagLength: 128
      }, key, decodeBytes(request.ciphertext));
      return {
        request,
        operation: request.operation,
        input: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext))
      };
    },
    async success(request, result) {
      encryptedRequest(request, binding);
      const key = await connectorDirectionalKey(privateKey, binding, "response", "encrypt");
      const ciphertext = await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv: relayNonce(request.counter),
        additionalData: new TextEncoder().encode(relayAad(binding, request, "response")),
        tagLength: 128
      }, key, new TextEncoder().encode(JSON.stringify({ ok: true, result })));
      return {
        ...request,
        type: "encrypted_operation_response",
        ciphertext: encodeBytes(ciphertext)
      };
    }
  };
}

function encryptedRequest(
  value: unknown,
  binding: FixtureRelayBinding
): EncryptedRelayOperationRequest {
  const request = value as Partial<EncryptedRelayOperationRequest> | null;
  if (
    !request
    || request.type !== "encrypted_operation_request"
    || request.protocol_version !== OPERATION_TRANSPORT_PROTOCOL_VERSION
    || request.suite !== RELAY_ENCRYPTION_SUITE
    || request.grant_id !== binding.grantId
    || request.application_id !== binding.applicationId
    || request.connector_id !== binding.encryption.connector_id
    || request.collection_id !== binding.encryption.collection_id
    || request.scope_epoch !== binding.encryption.scope_epoch
    || request.key_id !== binding.encryption.key_id
    || typeof request.request_id !== "string"
    || typeof request.operation !== "string"
    || typeof request.counter !== "string"
    || typeof request.ciphertext !== "string"
  ) {
    throw new Error("The fixture received an invalid encrypted relay request.");
  }
  return request as EncryptedRelayOperationRequest;
}

async function connectorDirectionalKey(
  privateKey: CryptoKey,
  binding: FixtureRelayBinding,
  direction: "request" | "response",
  usage: "decrypt" | "encrypt"
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey(
    "raw",
    decodeBytes(binding.encryption.application_agreement_public_key),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peer },
    privateKey,
    256
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(relayContext(binding))
  );
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt,
    info: new TextEncoder().encode(
      direction === "request"
        ? "mdbase-connect relay request key v1"
        : "mdbase-connect relay response key v1"
    )
  }, material, { name: "AES-GCM", length: 256 }, false, [usage]);
}

function relayContext(binding: FixtureRelayBinding): string {
  const encryption = binding.encryption;
  return [
    "mdbase-connect",
    OPERATION_TRANSPORT_PROTOCOL_VERSION,
    encryption.suite,
    binding.grantId,
    binding.applicationId,
    encryption.connector_id,
    encryption.collection_id,
    encryption.scope_epoch,
    encryption.key_id
  ].join("|");
}

function relayAad(
  binding: FixtureRelayBinding,
  request: EncryptedRelayOperationRequest,
  direction: "request" | "response"
): string {
  return [
    relayContext(binding),
    request.request_id,
    direction,
    request.operation,
    request.counter
  ].join("|");
}

function relayNonce(counter: string): Uint8Array<ArrayBuffer> {
  const value = BigInt(counter);
  if (value <= 0n || value > 18_446_744_073_709_551_615n || value.toString() !== counter) {
    throw new Error("The fixture received an invalid encrypted relay counter.");
  }
  const nonce = new Uint8Array(new ArrayBuffer(12));
  new DataView(nonce.buffer).setBigUint64(4, value, false);
  return nonce;
}

function encodeBytes(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBytes(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("The fixture received malformed encrypted relay data.");
  }
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

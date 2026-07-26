import {
  ENCRYPTED_RELAY_PROTOCOL_VERSION,
  HOSTED_PROOF_DOMAIN,
  HOSTED_PROOF_HEADERS,
  HOSTED_PROOF_VERSION,
  RELAY_ENCRYPTION_SUITE,
  type CollectionOperation,
  type EncryptedRelayOperationRequest,
  type EncryptedRelayOperationResponse,
  type GrantEncryption
} from "@mdbase/connect-protocol";

const DATABASE_NAME = "mdbase-connect-keys";
const STORE_NAME = "grant-keys";
const MAX_U64 = 18_446_744_073_709_551_615n;
const REQUEST_INFO = "mdbase-connect relay request key v1";
const RESPONSE_INFO = "mdbase-connect relay response key v1";

export interface GrantKeyRecord {
  handle: string;
  privateKey: CryptoKey;
  signingKey?: CryptoKey;
  publicKey: string;
}

export interface GrantKeyStore {
  create(handle: string): Promise<GrantKeyRecord>;
  get(handle: string): Promise<GrantKeyRecord | null>;
  nextCounter(handle: string): Promise<string>;
  delete(handle: string): Promise<void>;
}

interface PersistedGrantKey extends GrantKeyRecord {
  counter: string;
}

/** Origin-scoped storage for non-extractable grant keys and atomic counters. */
export class IndexedDbGrantKeyStore implements GrantKeyStore {
  private database: Promise<IDBDatabase> | null = null;

  async create(handle: string): Promise<GrantKeyRecord> {
    const record = await generateGrantKey(handle);
    const database = await this.open();
    await idbWrite(database, (store) => store.add({ ...record, counter: "0" } satisfies PersistedGrantKey));
    return record;
  }

  async get(handle: string): Promise<GrantKeyRecord | null> {
    const database = await this.open();
    const value = await idbRequest<PersistedGrantKey | undefined>(
      database.transaction(STORE_NAME).objectStore(STORE_NAME).get(handle)
    );
    return value ? {
      handle: value.handle,
      privateKey: value.privateKey,
      signingKey: value.signingKey,
      publicKey: value.publicKey
    } : null;
  }

  async nextCounter(handle: string): Promise<string> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(handle);
      let next: string | null = null;
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const record = request.result as PersistedGrantKey | undefined;
        if (!record) {
          transaction.abort();
          reject(new RelayCryptoError("missing_grant_key", "The encrypted grant key is unavailable."));
          return;
        }
        const counter = BigInt(record.counter) + 1n;
        if (counter > MAX_U64) {
          transaction.abort();
          reject(new RelayCryptoError("counter_exhausted", "The encrypted grant must be authorized again."));
          return;
        }
        next = counter.toString();
        store.put({ ...record, counter: next } satisfies PersistedGrantKey);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Key counter transaction aborted."));
      transaction.oncomplete = () => {
        if (next) resolve(next);
      };
    });
  }

  async delete(handle: string): Promise<void> {
    const database = await this.open();
    await idbWrite(database, (store) => store.delete(handle));
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new RelayCryptoError(
        "key_storage_unavailable",
        "Encrypted relay authorization requires browser IndexedDB or an injected grant key store."
      );
    }
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME, { keyPath: "handle" });
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    }
    return this.database;
  }
}

/** Deterministic process-local storage for tests, CLIs, and non-browser adapters. */
export class MemoryGrantKeyStore implements GrantKeyStore {
  private readonly records = new Map<string, PersistedGrantKey>();
  private sequence: Promise<void> = Promise.resolve();

  async create(handle: string): Promise<GrantKeyRecord> {
    if (this.records.has(handle)) throw new Error(`Grant key already exists: ${handle}`);
    const record = await generateGrantKey(handle);
    this.records.set(handle, { ...record, counter: "0" });
    return record;
  }

  async get(handle: string): Promise<GrantKeyRecord | null> {
    const value = this.records.get(handle);
    return value ? {
      handle: value.handle,
      privateKey: value.privateKey,
      signingKey: value.signingKey,
      publicKey: value.publicKey
    } : null;
  }

  nextCounter(handle: string): Promise<string> {
    let resolve!: (value: string) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    this.sequence = this.sequence.then(() => {
      const record = this.records.get(handle);
      if (!record) throw new RelayCryptoError("missing_grant_key", "The encrypted grant key is unavailable.");
      const counter = BigInt(record.counter) + 1n;
      if (counter > MAX_U64) throw new RelayCryptoError("counter_exhausted", "The encrypted grant must be authorized again.");
      record.counter = counter.toString();
      resolve(record.counter);
    }).catch((error) => {
      reject(error);
    });
    return result;
  }

  async delete(handle: string): Promise<void> {
    this.records.delete(handle);
  }
}

export interface RelayBinding {
  grantId: string;
  applicationId: string;
  encryption: GrantEncryption;
}

export interface HostedProofInput {
  method: string;
  target: string;
  body?: string;
  credential: string;
  timestamp?: number;
  nonce?: string;
}

/** Sign one hosted-provider or token-refresh request with the approved grant key. */
export async function signHostedRequest(
  store: GrantKeyStore,
  handle: string,
  expectedPublicKey: string,
  input: HostedProofInput
): Promise<Record<string, string>> {
  const record = await requireKey(store, handle, expectedPublicKey);
  if (!record.signingKey) {
    throw new RelayCryptoError(
      "missing_grant_key",
      "The hosted grant signing key is unavailable. Reconnect this application."
    );
  }
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1_000);
  const nonce = input.nonce ?? crypto.randomUUID();
  const message = await hostedProofMessage({ ...input, timestamp, nonce });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    record.signingKey,
    new TextEncoder().encode(message)
  );
  return {
    [HOSTED_PROOF_HEADERS.version]: String(HOSTED_PROOF_VERSION),
    [HOSTED_PROOF_HEADERS.timestamp]: String(timestamp),
    [HOSTED_PROOF_HEADERS.nonce]: nonce,
    [HOSTED_PROOF_HEADERS.signature]: bytesToBase64Url(new Uint8Array(signature))
  };
}

export async function hostedProofMessage(
  input: Required<Pick<HostedProofInput, "method" | "target" | "credential" | "timestamp" | "nonce">>
    & Pick<HostedProofInput, "body">
): Promise<string> {
  const method = input.method.toUpperCase();
  const bodyHash = await sha256Base64Url(input.body ?? "");
  const credentialHash = await sha256Base64Url(input.credential);
  for (const value of [method, input.target, String(input.timestamp), input.nonce]) {
    if (!value || value.includes("\n") || value.includes("\r")) {
      throw new RelayCryptoError("invalid_proof_input", "Hosted request proof metadata is invalid.");
    }
  }
  return [
    HOSTED_PROOF_DOMAIN,
    HOSTED_PROOF_VERSION,
    method,
    input.target,
    bodyHash,
    credentialHash,
    input.timestamp,
    input.nonce
  ].join("\n");
}

export async function encryptRelayRequest(
  store: GrantKeyStore,
  handle: string,
  binding: RelayBinding,
  operation: CollectionOperation,
  input: unknown,
  requestId = crypto.randomUUID()
): Promise<EncryptedRelayOperationRequest> {
  validateEncryption(binding.encryption);
  const record = await requireKey(store, handle, binding.encryption.application_public_key);
  const counter = await store.nextCounter(handle);
  const metadata = { binding, requestId, operation, counter };
  const key = await deriveDirectionalKey(record.privateKey, binding, "request");
  const plaintext = new TextEncoder().encode(JSON.stringify(input ?? {}));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce(counter),
    additionalData: new TextEncoder().encode(aad(metadata, "request")),
    tagLength: 128
  }, key, plaintext);
  return {
    type: "encrypted_operation_request",
    ...envelopeMetadata(metadata),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptRelayResponse<Result>(
  store: GrantKeyStore,
  handle: string,
  binding: RelayBinding,
  request: EncryptedRelayOperationRequest,
  response: EncryptedRelayOperationResponse
): Promise<{ ok: true; result: Result } | { ok: false; error: { code: string; message: string } }> {
  if (!sameEnvelopeMetadata(request, response)) {
    throw new RelayCryptoError("invalid_encrypted_response", "Encrypted response metadata does not match its request.");
  }
  const record = await requireKey(store, handle, binding.encryption.application_public_key);
  const metadata = {
    binding,
    requestId: request.request_id,
    operation: request.operation,
    counter: request.counter
  };
  const key = await deriveDirectionalKey(record.privateKey, binding, "response");
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: nonce(request.counter),
      additionalData: new TextEncoder().encode(aad(metadata, "response")),
      tagLength: 128
    }, key, toArrayBuffer(base64UrlToBytes(response.ciphertext)));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    if (value?.ok === true && "result" in value) return value;
    if (value?.ok === false
        && typeof value.error?.code === "string"
        && typeof value.error?.message === "string") return value;
    throw new Error("invalid response body");
  } catch (error) {
    if (error instanceof RelayCryptoError) throw error;
    throw new RelayCryptoError("encrypted_response_rejected", "The encrypted connector response could not be authenticated.");
  }
}

export class RelayCryptoError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

async function generateGrantKey(handle: string): Promise<GrantKeyRecord> {
  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const publicKey = bytesToBase64Url(new Uint8Array(
    await crypto.subtle.exportKey("raw", generated.publicKey)
  ));
  const privatePkcs8 = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privatePkcs8,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    privatePkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return { handle, privateKey, signingKey, publicKey };
}

async function requireKey(store: GrantKeyStore, handle: string, expectedPublicKey: string): Promise<GrantKeyRecord> {
  const record = await store.get(handle);
  if (!record || record.publicKey !== expectedPublicKey) {
    throw new RelayCryptoError("missing_grant_key", "The encrypted grant key is unavailable or does not match the grant.");
  }
  return record;
}

async function deriveDirectionalKey(
  privateKey: CryptoKey,
  binding: RelayBinding,
  direction: "request" | "response"
): Promise<CryptoKey> {
  let peer: CryptoKey;
  let shared: ArrayBuffer;
  try {
    peer = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(p256PublicKey(binding.encryption.connector_public_key)),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  } catch {
    throw new RelayCryptoError("invalid_public_key", "The connector relay public key is invalid.");
  }
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const contextBytes = new TextEncoder().encode(context(binding));
  const salt = await crypto.subtle.digest("SHA-256", contextBytes);
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt,
    info: new TextEncoder().encode(direction === "request" ? REQUEST_INFO : RESPONSE_INFO)
  }, material, { name: "AES-GCM", length: 256 }, false, direction === "request" ? ["encrypt"] : ["decrypt"]);
}

function context(binding: RelayBinding): string {
  const value = binding.encryption;
  return [
    "mdbase-connect",
    ENCRYPTED_RELAY_PROTOCOL_VERSION,
    value.suite,
    binding.grantId,
    binding.applicationId,
    value.connector_id,
    value.collection_id,
    value.scope_epoch,
    value.key_id
  ].join("|");
}

function aad(
  metadata: { binding: RelayBinding; requestId: string; operation: CollectionOperation; counter: string },
  direction: "request" | "response"
): string {
  return [context(metadata.binding), metadata.requestId, direction, metadata.operation, metadata.counter].join("|");
}

function envelopeMetadata(metadata: {
  binding: RelayBinding;
  requestId: string;
  operation: CollectionOperation;
  counter: string;
}): Omit<EncryptedRelayOperationRequest, "type" | "ciphertext"> {
  const encryption = metadata.binding.encryption;
  return {
    protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
    suite: RELAY_ENCRYPTION_SUITE,
    request_id: metadata.requestId,
    grant_id: metadata.binding.grantId,
    application_id: metadata.binding.applicationId,
    connector_id: encryption.connector_id,
    collection_id: encryption.collection_id,
    operation: metadata.operation,
    scope_epoch: encryption.scope_epoch,
    key_id: encryption.key_id,
    counter: metadata.counter
  };
}

function sameEnvelopeMetadata(
  request: EncryptedRelayOperationRequest,
  response: EncryptedRelayOperationResponse
): boolean {
  return response.type === "encrypted_operation_response"
    && typeof response.ciphertext === "string"
    && request.protocol_version === response.protocol_version
    && request.suite === response.suite
    && request.request_id === response.request_id
    && request.grant_id === response.grant_id
    && request.application_id === response.application_id
    && request.connector_id === response.connector_id
    && request.collection_id === response.collection_id
    && request.operation === response.operation
    && request.scope_epoch === response.scope_epoch
    && request.key_id === response.key_id
    && request.counter === response.counter;
}

function validateEncryption(encryption: GrantEncryption): void {
  if (encryption.protocol_version !== ENCRYPTED_RELAY_PROTOCOL_VERSION
      || encryption.suite !== RELAY_ENCRYPTION_SUITE
      || !Number.isSafeInteger(encryption.scope_epoch)
      || encryption.scope_epoch <= 0
      || !encryption.key_id
      || encryption.key_id.includes("|")) {
    throw new RelayCryptoError("unsupported_encryption", "The grant uses an unsupported relay encryption profile.");
  }
  p256PublicKey(encryption.application_public_key);
  p256PublicKey(encryption.connector_public_key);
}

function nonce(counter: string): Uint8Array<ArrayBuffer> {
  const value = BigInt(counter);
  if (value <= 0n || value > MAX_U64 || value.toString() !== counter) {
    throw new RelayCryptoError("invalid_counter", "The encrypted relay counter is invalid.");
  }
  const result = new Uint8Array(new ArrayBuffer(12));
  const view = new DataView(result.buffer);
  view.setBigUint64(4, value, false);
  return result;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RelayCryptoError("invalid_base64", "Encrypted relay data is malformed.");
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function p256PublicKey(value: string): Uint8Array {
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new RelayCryptoError("invalid_public_key", "Encrypted relay public keys must be uncompressed P-256 points.");
  }
  return bytes;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function idbRequest<T = IDBValidKey>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function idbWrite(database: IDBDatabase, operation: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Grant key transaction aborted."));
    transaction.oncomplete = () => resolve();
  });
}

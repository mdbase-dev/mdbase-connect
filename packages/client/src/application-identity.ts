import {
  applicationInstallationIdFromPublicKey,
  authorizationSigningMessage,
  type ApplicationAuthorizationBinding,
  type ApplicationAuthorizationProof
} from "@mdbase-dev/connect-protocol";
import type { Application } from "./internal-types.js";

const DATABASE_NAME = "mdbase-connect-identities";
const STORE_NAME = "application-identities";
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_ORDER = P256_ORDER / 2n;

export interface ApplicationIdentity {
  handle: string;
  signingPrivateKey: CryptoKey;
  signingPublicKey: string;
}

export interface ApplicationIdentityStore {
  create(handle: string): Promise<ApplicationIdentity>;
  get(handle: string): Promise<ApplicationIdentity | null>;
  delete(handle: string): Promise<void>;
}

/** Origin-scoped persistence for one non-extractable signing key per app/server installation. */
export class IndexedDbApplicationIdentityStore implements ApplicationIdentityStore {
  private database: Promise<IDBDatabase> | null = null;

  async create(handle: string): Promise<ApplicationIdentity> {
    const record = await generateApplicationIdentity(handle);
    const database = await this.open();
    await idbWrite(database, (store) => store.add(record));
    return record;
  }

  async get(handle: string): Promise<ApplicationIdentity | null> {
    const database = await this.open();
    return await idbRequest<ApplicationIdentity | undefined>(
      database.transaction(STORE_NAME).objectStore(STORE_NAME).get(handle)
    ) ?? null;
  }

  async delete(handle: string): Promise<void> {
    const database = await this.open();
    await idbWrite(database, (store) => store.delete(handle));
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new ApplicationIdentityStoreError(
        "Persistent application identity requires browser IndexedDB or an injected identity store."
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

/** Process-local identity storage for portable applications, tests, and custom hosts. */
export class MemoryApplicationIdentityStore implements ApplicationIdentityStore {
  private readonly records = new Map<string, ApplicationIdentity>();

  async create(handle: string): Promise<ApplicationIdentity> {
    if (this.records.has(handle)) throw new Error(`Application identity already exists: ${handle}`);
    const record = await generateApplicationIdentity(handle);
    this.records.set(handle, record);
    return record;
  }

  async get(handle: string): Promise<ApplicationIdentity | null> {
    return this.records.get(handle) ?? null;
  }

  async delete(handle: string): Promise<void> {
    this.records.delete(handle);
  }
}

export class ApplicationIdentityStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationIdentityStoreError";
  }
}

export { authorizationSigningMessage };

export async function applicationInstallationId(
  identity: Pick<ApplicationIdentity, "signingPublicKey">
): Promise<string> {
  return applicationInstallationIdFromPublicKey(identity.signingPublicKey);
}

export async function signApplicationAuthorization(
  binding: ApplicationAuthorizationBinding,
  identity: Pick<ApplicationIdentity, "signingPrivateKey" | "signingPublicKey">
): Promise<ApplicationAuthorizationProof> {
  if (
    binding.installation_signing_public_key !== identity.signingPublicKey
    || binding.application_installation_id !== await applicationInstallationId(identity)
  ) {
    throw new Error("Application authorization identity does not match its binding.");
  }
  const signature = canonicalSignature(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.signingPrivateKey,
    authorizationSigningMessage(binding) as BufferSource
  )));
  return { binding, signature: base64Url(signature) };
}

export async function applicationIdentity(
  store: ApplicationIdentityStore,
  serverUrl: string,
  application: Application
): Promise<ApplicationIdentity> {
  const handle = `application-installation:v2:${serverUrl}:${application.id}`;
  const existing = await store.get(handle);
  if (existing) return existing;
  try {
    return await store.create(handle);
  } catch (error) {
    const raced = await store.get(handle);
    if (raced) return raced;
    throw error;
  }
}

async function generateApplicationIdentity(handle: string): Promise<ApplicationIdentity> {
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const signingPublicKey = base64Url(new Uint8Array(
    await crypto.subtle.exportKey("raw", signing.publicKey)
  ));
  const signingPkcs8 = await crypto.subtle.exportKey("pkcs8", signing.privateKey);
  const signingPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    signingPkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return { handle, signingPrivateKey, signingPublicKey };
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function idbWrite(
  database: IDBDatabase,
  write: (store: IDBObjectStore) => IDBRequest
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    write(transaction.objectStore(STORE_NAME)).onerror = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Identity transaction aborted."));
    transaction.oncomplete = () => resolve();
  });
}

function concat(values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function canonicalSignature(signature: Uint8Array): Uint8Array {
  if (signature.byteLength !== 64) throw new Error("Application authorization signature is invalid.");
  const s = bytesBigInt(signature.slice(32));
  if (s === 0n || s >= P256_ORDER) throw new Error("Application authorization signature is invalid.");
  if (s <= P256_HALF_ORDER) return signature;
  return concat([signature.slice(0, 32), bigIntBytes(P256_ORDER - s, 32)]);
}

function bytesBigInt(value: Uint8Array): bigint {
  return BigInt(`0x${hex(value)}`);
}

function bigIntBytes(value: bigint, length: number): Uint8Array {
  const encoded = value.toString(16).padStart(length * 2, "0");
  return Uint8Array.from(
    { length },
    (_, index) => Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16)
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

import type {
  GrantEncryption,
  GrantScope,
  MdbaseAppManifest
} from "@mdbase-dev/connect-protocol";
import { validateGrantEncryption } from "./crypto.js";
import { MdbaseConnectError } from "./errors.js";
import type { StoredToken } from "./internal-types.js";
import type { MdbaseDeviceAuthorization } from "./authorization-types.js";
import { canonicalJson } from "./operation-helpers.js";
import {
  bytesToBase64Url,
  randomBase64Url
} from "./base64.js";

export function canonicalLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:"
      || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash) {
    throw new MdbaseConnectError(
      "invalid_loopback_url",
      "loopbackUrl must be an HTTP origin on 127.0.0.1 or ::1."
    );
  }
  return url.origin;
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export function apiError(body: any, fallbackCode: string, fallbackMessage: string, status?: number): MdbaseConnectError {
  return new MdbaseConnectError(
    oauthErrorCode(body) ?? body?.error?.code ?? fallbackCode,
    body?.error_description ?? body?.error?.message ?? fallbackMessage,
    { status, details: body?.error?.details }
  );
}

export function oauthErrorCode(body: any): string | undefined {
  return typeof body?.error === "string" ? body.error : undefined;
}

export function validAuthorityTokenResponse(value: unknown, collectionId: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof collectionId !== "string") return false;
  const authority = value as {
    operations_url?: unknown;
    sync_url?: unknown;
    replica_id?: unknown;
    access_token?: unknown;
    proof_public_key?: unknown;
  };
  if (
    typeof authority.operations_url !== "string"
    || typeof authority.sync_url !== "string"
    || typeof authority.replica_id !== "string"
    || authority.replica_id.length === 0
    || typeof authority.access_token !== "string"
    || authority.access_token.length === 0
    || (
      authority.proof_public_key !== undefined
      && (
        typeof authority.proof_public_key !== "string"
        || authority.proof_public_key.length === 0
      )
    )
  ) return false;
  try {
    const operations = new URL(authority.operations_url);
    const sync = new URL(authority.sync_url);
    return [operations, sync].every((url) =>
      (
        url.protocol === "https:"
        || (
          url.protocol === "http:"
          && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
        )
      )
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
    )
      && /^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/operations$/i.test(operations.pathname)
      && /^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sync$/i.test(sync.pathname)
      && operations.origin === sync.origin
      && operations.pathname.split("/")[3] === collectionId
      && sync.pathname.split("/")[3] === collectionId;
  } catch {
    return false;
  }
}

export function validStoredAuthority(
  authority: StoredToken["authority"],
  collectionId: string
): boolean {
  return validAuthorityTokenResponse({
    operations_url: authority?.operationsUrl,
    sync_url: authority?.syncUrl,
    replica_id: authority?.replicaId,
    access_token: authority?.accessToken,
    proof_public_key: authority?.proofPublicKey
  }, collectionId);
}

export function validStoredEncryption(
  encryption: StoredToken["encryption"],
  collectionId: string
): encryption is GrantEncryption {
  if (!encryption || typeof encryption !== "object" || Array.isArray(encryption)) {
    return false;
  }
  if (encryption.collection_id !== collectionId) return false;
  try {
    validateGrantEncryption(encryption);
    return true;
  } catch {
    return false;
  }
}

export function parseDeviceAuthorization(body: any): MdbaseDeviceAuthorization {
  if (
    typeof body?.device_code !== "string"
    || typeof body?.user_code !== "string"
    || typeof body?.verification_uri !== "string"
    || typeof body?.verification_uri_complete !== "string"
    || !Number.isFinite(body?.expires_in)
    || !Number.isFinite(body?.interval)
  ) {
    throw new MdbaseConnectError(
      "invalid_device_authorization_response",
      "Connect returned an invalid downloaded application authorization response."
    );
  }
  return {
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete,
    expiresAt: Date.now() + Math.max(1, body.expires_in) * 1_000,
    intervalSeconds: Math.max(1, body.interval)
  };
}

export function parseStored<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

export function parseGrantScope(value: unknown): GrantScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = value as Partial<GrantScope>;
  if (scope.access !== "contract" && scope.access !== "full_collection") return null;
  if (!Array.isArray(scope.contracts)) return null;
  if (scope.contracts.some((contract) =>
    !contract
    || typeof contract !== "object"
    || contract.contract_type !== "record"
    || typeof contract.id !== "string"
    || typeof contract.version !== "string"
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(contract.version)
    || !/^sha256:[0-9a-f]{64}$/.test(contract.digest)
    || !contract.schema
    || typeof contract.schema !== "object"
    || Array.isArray(contract.schema)
    || !Array.isArray(contract.implementations)
    || contract.implementations.some((implementation) =>
      !implementation
      || typeof implementation !== "object"
      || typeof implementation.type_name !== "string"
      || !Number.isInteger(implementation.type_version)
      || !/^sha256:[0-9a-f]{64}$/.test(implementation.digest)
      || !implementation.fields
      || typeof implementation.fields !== "object"
      || Array.isArray(implementation.fields)
      || Object.values(implementation.fields).some((field) => typeof field !== "string")
    )
  )) return null;
  return scope as GrantScope;
}

export function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function defaultManifestSource(): string {
  if (typeof location === "undefined") {
    throw new MdbaseConnectError(
      "manifest_required",
      "manifest is required outside a browser environment."
    );
  }
  if (location.origin === "null") {
    throw new MdbaseConnectError(
      "manifest_required",
      "Downloaded applications must provide their v1 portable manifest inline."
    );
  }
  return new URL("/.well-known/mdbase-app.json", location.origin).href;
}

export function defaultRedirectUri(): string {
  if (typeof location === "undefined") {
    throw new MdbaseConnectError(
      "redirect_uri_required",
      "redirectUri is required outside a browser environment."
    );
  }
  return location.href.split(/[?#]/)[0];
}

export function defaultCallbackUrl(): string {
  if (typeof location === "undefined") {
    throw new MdbaseConnectError(
      "callback_url_required",
      "callbackUrl is required outside a browser environment."
    );
  }
  return location.href;
}

export function defaultStorage(memoryOnly: boolean): Storage {
  if (memoryOnly) return new MemoryStorage();
  if (typeof localStorage === "undefined") {
    throw new MdbaseConnectError(
      "storage_required",
      "storage is required outside a browser environment."
    );
  }
  try {
    const probe = `mdbase-connect:probe:${randomBase64Url(8)}`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return new MemoryStorage();
  }
}

export class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value));
  }
}

export function isOpaquePortableManifest(manifest: MdbaseAppManifest | string): boolean {
  if (typeof manifest === "string" || manifest.distribution !== "portable") return false;
  return typeof location === "undefined"
    || location.origin === "null"
    || !["http:", "https:"].includes(location.protocol);
}

export function manifestStorageFingerprint(manifest: MdbaseAppManifest): string {
  const canonical = canonicalJson(manifest);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

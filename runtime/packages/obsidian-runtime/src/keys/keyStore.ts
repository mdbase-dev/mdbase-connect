/**
 * Device key storage in Obsidian (private sync at ship, `sealed-envelope.md` §5.1:
 * "Private keys are kept in the platform's key store where one exists").
 *
 * **What is stored.** Only the device's own secrets (Ed25519 signing, X25519 KEM,
 * X25519 Noise), as one opaque blob the runtime exports. Epoch keys are not
 * stored: the device recovers them from the log with its KEM key (key wraps and
 * the rekey history box).
 *
 * **Why not plain non-extractable WebCrypto keys.** The runtime (WASM) signs,
 * unwraps and seals with these keys itself. WebCrypto has no ChaCha20, and Ed25519
 * and X25519 are missing on Android WebView 133, so they cannot live only inside
 * WebCrypto. Instead:
 *
 * 1. A **key-encryption key** (AES-GCM-256, generated `extractable: false`) is kept
 *    in IndexedDB. Script, including other plugins, can use it but never read its
 *    bytes.
 * 2. The secrets blob is encrypted under it with AES-GCM. The AAD binds the
 *    namespace (collection + device), so a blob can't be swapped between
 *    collections.
 * 3. **Where the ciphertext lives:**
 *    - With Obsidian's `SecretStorage` (desktop: Electron `safeStorage`, so the OS
 *      keychain, DPAPI or libsecret), the ciphertext goes there. Decrypting then
 *      needs both the OS-protected secret and the origin's IndexedDB key.
 *    - Otherwise the ciphertext stays in IndexedDB, next to the key. Mobile
 *      WebView storage sits in the app's private data directory.
 * 4. **Never in a vault file.** Sync tools would copy it to other devices, and the
 *    vault is user-readable.
 *
 * **What this does not protect against:**
 * - code running in the same Obsidian process, such as a malicious plugin. It can
 *   call the runtime or the unwrap path. Obsidian has no isolation between plugins;
 * - malware reading the process memory;
 * - on Chromium, non-extractable keys stored in IndexedDB on disk unencrypted.
 *   So without `SecretStorage`, at-rest protection is the OS's app sandbox.
 *
 * **Loss.** If the browser storage is cleared (Android "Clear storage", browser eviction),
 * the device identity is gone. The device must re-enrol and be approved again.
 * {@link DeviceKeyStore.load} reports this as `lost`, distinct from `absent`
 * (never created), so the UI can say so.
 */

import { decodeBase64, encodeBase64 } from "../embed/base64.js";
import { hex, sha256 } from "../util/hash.js";
import { openDb, req, tx } from "../util/idb.js";

/** The part of Obsidian's `app.secretStorage` used here (Obsidian ≥ 1.11.4). */
export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/** How the stored secrets are protected. */
export type Protection = "keychain" | "browser-storage";

/** Result of {@link DeviceKeyStore.load}. */
export type LoadResult =
  | { readonly kind: "present"; readonly secrets: Uint8Array; readonly protection: Protection }
  | { readonly kind: "absent" }
  | { readonly kind: "lost"; readonly reason: "kek_missing" | "ciphertext_missing" | "decrypt_failed" };

interface BlobRecord {
  readonly v: 1;
  /** Where the ciphertext is. */
  readonly where: "idb" | "secret-storage";
  readonly iv?: Uint8Array;
  readonly ct?: Uint8Array;
}

const DB = "mdbase-keys-v1";
const KEK = "kek";
const BLOB = "blob";
const enc = new TextEncoder();

/** Encrypted storage for one device identity in one collection. */
export class DeviceKeyStore {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly namespace: string,
    private readonly secretId: string,
    private readonly secretStorage: SecretStorageLike | null,
  ) {}

  /**
   * Open the store for `namespace` (`<collection id>/<device id>`).
   * Pass `app.secretStorage` where it exists.
   */
  static async open(namespace: string, opts: { secretStorage?: SecretStorageLike | null; idb?: IDBFactory } = {}): Promise<DeviceKeyStore> {
    const db = await openDb(DB, 1, [KEK, BLOB], opts.idb);
    // SecretStorage ids: lowercase alphanumeric with dashes.
    const secretId = `mdbase-device-${hex(await sha256(enc.encode(namespace))).slice(0, 32)}`;
    return new DeviceKeyStore(db, namespace, secretId, opts.secretStorage ?? null);
  }

  /** How secrets saved now would be protected. */
  get protection(): Protection {
    return this.secretStorage ? "keychain" : "browser-storage";
  }

  private aad(): Uint8Array {
    return enc.encode(`mdbase/v1/obsidian-device-secrets\0${this.namespace}`);
  }

  /** Encrypt and store `secrets`, replacing any previous ones. */
  async save(secrets: Uint8Array): Promise<void> {
    const kek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.aad() as BufferSource }, kek, secrets as BufferSource));
    let record: BlobRecord;
    if (this.secretStorage) {
      this.secretStorage.setSecret(this.secretId, `v1.${encodeBase64(iv)}.${encodeBase64(ct)}`);
      if (this.secretStorage.getSecret(this.secretId) === null) throw new Error("SecretStorage did not keep the device secret");
      record = { v: 1, where: "secret-storage" };
    } else {
      record = { v: 1, where: "idb", iv, ct };
    }
    // Key and record commit together, durably.
    await tx(this.db, [KEK, BLOB], "readwrite", (t) => {
      t.objectStore(KEK).put(kek, this.namespace);
      t.objectStore(BLOB).put(record, this.namespace);
    });
  }

  /** Load and decrypt the secrets. */
  async load(): Promise<LoadResult> {
    const [kek, record] = await tx(this.db, [KEK, BLOB], "readonly", (t) =>
      Promise.all([req<CryptoKey | undefined>(t.objectStore(KEK).get(this.namespace)), req<BlobRecord | undefined>(t.objectStore(BLOB).get(this.namespace))]),
    );
    const external = this.secretStorage?.getSecret(this.secretId) || null;
    if (!record) {
      // Ciphertext in the keychain without its key: the browser storage was cleared.
      return external ? { kind: "lost", reason: "kek_missing" } : { kind: "absent" };
    }
    if (!kek) return { kind: "lost", reason: "kek_missing" };
    let iv: Uint8Array | undefined;
    let ct: Uint8Array | undefined;
    if (record.where === "idb") {
      iv = record.iv;
      ct = record.ct;
    } else if (external) {
      const m = /^v1\.([^.]+)\.([^.]+)$/.exec(external);
      if (m) {
        iv = decodeBase64(m[1]!);
        ct = decodeBase64(m[2]!);
      }
    }
    if (!iv || !ct) return { kind: "lost", reason: "ciphertext_missing" };
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: this.aad() as BufferSource }, kek, ct as BufferSource);
      return { kind: "present", secrets: new Uint8Array(pt), protection: record.where === "idb" ? "browser-storage" : "keychain" };
    } catch {
      return { kind: "lost", reason: "decrypt_failed" };
    }
  }

  /** Forget the device identity (device revoked, collection removed). */
  async erase(): Promise<void> {
    await tx(this.db, [KEK, BLOB], "readwrite", (t) => {
      t.objectStore(KEK).delete(this.namespace);
      t.objectStore(BLOB).delete(this.namespace);
    });
    // Obsidian's SecretStorage has no delete; overwrite with an empty value.
    if (this.secretStorage?.getSecret(this.secretId)) this.secretStorage.setSecret(this.secretId, "");
  }

  close(): void {
    this.db.close();
  }
}

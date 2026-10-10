/** Bounded, untrusted encrypted-upload locator metadata ONLY. No file, path,
 * digest, plaintext hash, key or checkpoint body. Survives disposable st_* reset.
 * A lookup is never authority: fresh native journal authentication/current owner,
 * epoch/wake/folder/resource checks and committed-prefix rehash remain mandatory.
 * Unwired: trusted native bridge callbacks are still to implement from merged APIs.
 */
const TABLE = "hosted_upload_locator_v1";
const MAX_ROWS = 64;
const MAX_CHUNKS = 128;
const MAX_SEALED_METADATA = 64 << 10;
const MAX_ID = Number.MAX_SAFE_INTEGER;
export interface UploadLocatorOwner {
  transfer: Uint8Array;
  grant: Uint8Array;
  clientPk: Uint8Array;
  account: Uint8Array;
}
/** Structural locator only. Native authenticates the complete encrypted object.
 * `readBoundary` MUST yield this only after native-known encrypted metadata PUT,
 * and MUST recheck all current owner/epoch/wake/admission/resource fences.
 */
export interface UploadCipherLocator extends UploadLocatorOwner {
  epoch: number;
  attachment: Uint8Array;
  cipherHash: Uint8Array;
  sealedBytes: number;
  committedChunks: number;
  expiresAtMs: number;
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS ${TABLE} (
 collection BLOB NOT NULL CHECK(length(collection)=16),
 transfer BLOB NOT NULL CHECK(length(transfer)=16),
 grant_id BLOB NOT NULL CHECK(length(grant_id)=16),
 client_pk BLOB NOT NULL CHECK(length(client_pk)=32),
 account BLOB NOT NULL CHECK(length(account)=16),
 epoch INTEGER NOT NULL CHECK(typeof(epoch)='integer' AND epoch>0 AND epoch<=9007199254740991),
 attachment BLOB NOT NULL CHECK(length(attachment)=32),
 cipher_hash BLOB NOT NULL CHECK(length(cipher_hash)=32),
 sealed_bytes INTEGER NOT NULL CHECK(typeof(sealed_bytes)='integer' AND sealed_bytes>0 AND sealed_bytes<=65536),
 chunks INTEGER NOT NULL CHECK(typeof(chunks)='integer' AND chunks>0 AND chunks<=128),
 expires INTEGER NOT NULL CHECK(typeof(expires)='integer' AND expires>0 AND expires<=9007199254740991),
 PRIMARY KEY(collection,transfer,grant_id,client_pk,account)
) WITHOUT ROWID`;
const SELECT = `SELECT epoch,attachment,cipher_hash,sealed_bytes,chunks,expires FROM ${TABLE}
 WHERE collection=? AND transfer=? AND grant_id=? AND client_pk=? AND account=? LIMIT 1`;
function bytes(value: unknown, length: number): Uint8Array {
  const v = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(v instanceof Uint8Array) || v.length !== length) throw new Error("invalid upload locator bytes");
  return v.slice();
}
function uint(value: unknown, max = MAX_ID): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new Error("invalid upload locator bound");
  return value;
}
function owner(value: UploadLocatorOwner | null): UploadLocatorOwner {
  if (!value) throw new Error("current native upload owner unavailable");
  return { transfer: bytes(value.transfer, 16), grant: bytes(value.grant, 16),
    clientPk: bytes(value.clientPk, 32), account: bytes(value.account, 16) };
}
function locator(value: UploadCipherLocator | null): UploadCipherLocator {
  if (!value) throw new Error("current native upload boundary unavailable");
  // Only fixed-sized typed metadata is copied; no arbitrary opaque BLOB channel.
  return { ...owner(value), epoch: uint(value.epoch), attachment: bytes(value.attachment, 32),
    cipherHash: bytes(value.cipherHash, 32), sealedBytes: uint(value.sealedBytes, MAX_SEALED_METADATA),
    committedChunks: uint(value.committedChunks, MAX_CHUNKS), expiresAtMs: uint(value.expiresAtMs) };
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean { return a.every((v, i) => v === b[i]); }
function sameOwner(a: UploadLocatorOwner, b: UploadLocatorOwner): boolean {
  return equalBytes(a.transfer, b.transfer) && equalBytes(a.grant, b.grant) &&
    equalBytes(a.clientPk, b.clientPk) && equalBytes(a.account, b.account);
}
function sameLocator(a: UploadCipherLocator, b: UploadCipherLocator): boolean {
  return sameOwner(a, b) && a.epoch === b.epoch && equalBytes(a.attachment, b.attachment) &&
    equalBytes(a.cipherHash, b.cipherHash) && a.sealedBytes === b.sealedBytes &&
    a.committedChunks === b.committedChunks && a.expiresAtMs === b.expiresAtMs;
}
function row(v: Record<string, SqlStorageValue>, o: UploadLocatorOwner): UploadCipherLocator {
  return { ...owner(o), epoch: uint(v.epoch), attachment: bytes(v.attachment, 32),
    cipherHash: bytes(v.cipher_hash, 32), sealedBytes: uint(v.sealed_bytes, MAX_SEALED_METADATA),
    committedChunks: uint(v.chunks, MAX_CHUNKS), expiresAtMs: uint(v.expires) };
}

/** Constructor/schema is host-local, not permission. All data boundaries below
 * use fresh synchronous trusted-native callbacks, never client/SQL authority.
 */
export class UploadLocators {
  private readonly collection: Uint8Array;
  constructor(private readonly storage: DurableObjectStorage, collection: Uint8Array,
    private readonly now: () => number = Date.now) {
    this.collection = bytes(collection, 16);
    storage.sql.exec(SCHEMA);
  }
  private key(o: UploadLocatorOwner): Uint8Array[] {
    return [this.collection, o.transfer, o.grant, o.clientPk, o.account];
  }
  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid upload locator clock");
    return now;
  }
  /** No await/retry: known SQL transaction must succeed before durable wire ACK.
   * A callback exception/drift/refusal rolls back; unknown transaction outcomes
   * propagate and must never produce an ACK or restore possible ownership.
   */
  put(readBoundary: () => UploadCipherLocator | null): void {
    const next = locator(readBoundary());
    const now = this.clock();
    if (next.expiresAtMs <= now || next.expiresAtMs > now + 86_400_000)
      throw new Error("expired or over-grace upload locator boundary");
    this.storage.transactionSync(() => {
      if (!sameLocator(next, locator(readBoundary()))) throw new Error("upload boundary changed");
      this.storage.sql.exec(`DELETE FROM ${TABLE} WHERE expires<=?`, this.clock());
      const rows = this.storage.sql.exec(SELECT, ...this.key(next)).toArray();
      const old = rows.length ? row(rows[0], next) : null;
      if (old && (old.epoch !== next.epoch || !equalBytes(old.attachment, next.attachment) ||
          (next.committedChunks === old.committedChunks ? !sameLocator(old, next)
            : next.committedChunks !== old.committedChunks + 1)))
        throw new Error("upload locator progress changed");
      if (!old) {
        const total = this.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM ${TABLE}`).one().n;
        if (!Number.isSafeInteger(total) || total < 0 || total >= MAX_ROWS) throw new Error("upload locator budget exhausted");
      }
      this.storage.sql.exec(`INSERT INTO ${TABLE}
       (collection,transfer,grant_id,client_pk,account,epoch,attachment,cipher_hash,sealed_bytes,chunks,expires)
       VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(collection,transfer,grant_id,client_pk,account) DO UPDATE SET
       cipher_hash=excluded.cipher_hash,sealed_bytes=excluded.sealed_bytes,chunks=excluded.chunks,expires=excluded.expires`,
       ...this.key(next), next.epoch, next.attachment, next.cipherHash, next.sealedBytes,
       next.committedChunks, next.expiresAtMs);
      if (next.expiresAtMs <= this.clock() || !sameLocator(next, locator(readBoundary())))
        throw new Error("upload boundary changed before SQL commit");
    });
  }
  /** Fresh current owner selects a single bounded UNTRUSTED locator, not progress
   * or ownership. Native MUST authenticate R2 journal and rehash before output.
   */
  get(readOwner: () => UploadLocatorOwner | null): UploadCipherLocator | null {
    const current = owner(readOwner());
    const rows = this.storage.sql.exec(SELECT, ...this.key(current)).toArray();
    const result = rows.length ? row(rows[0], current) : null;
    if (!sameOwner(current, owner(readOwner()))) throw new Error("upload owner changed");
    return result && result.expiresAtMs > this.clock() ? result : null;
  }
  /** Forget only exact current owner metadata; no remote deletion or plaintext.
   * Does not claim that a native uncertain commit was aborted.
   */
  remove(readOwner: () => UploadLocatorOwner | null): void {
    const current = owner(readOwner());
    this.storage.transactionSync(() => {
      if (!sameOwner(current, owner(readOwner()))) throw new Error("upload owner changed");
      this.storage.sql.exec(`DELETE FROM ${TABLE} WHERE collection=? AND transfer=? AND grant_id=? AND client_pk=? AND account=?`,
        ...this.key(current));
      if (!sameOwner(current, owner(readOwner()))) throw new Error("upload owner changed before SQL commit");
    });
  }
}

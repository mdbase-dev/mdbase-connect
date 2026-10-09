// The control plane's client for the mdbase-next log service (log-service-api.md §3,
// §4, §5, §12) over plain HTTPS: `GET /v1/nonce`, then `POST /v1/rpc` with an
// `ls-request` frame, a bearer token and a proof-of-possession signature.
//
// Tokens follow the log service's format (crates/log-service/src/auth.rs):
//   hex(claims) "." hex(Ed25519(issuer, H("mdbase/v1/ls-token", claims)))
//   claims = {0: role (0 device, 1 control plane), ? 1: device, 2: sign_pk,
//             3: expires_at ms, 4: "mdbase-log", ? 5: collection}
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { decodeCbor, domainHash, encodeCbor, uuidBytes, type Cbor, type Decoded } from "./policy-wire.js";
import { ed25519RawPublicKey, type LogServiceConfig } from "./policy-keys.js";
import type { CollectionDeletionFact, CollectionDeletionPage } from "./collection-deletion.js";
import { readBoundedBytes } from "../../platform/bounded-json.js";

export const LOG_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Existing strict restore tuple; never mutable import progress or key authority. */
export type NativeRestorePlan = readonly [1, number, number, Uint8Array, number, Uint8Array, Uint8Array, Uint8Array];
export type NativeRestoreSettings = readonly [1, readonly [number, number, number, number], number, number];
export interface NativeBackupFrame { raw: Uint8Array; hash: Uint8Array }
export interface NativeBackupFinish {
  raw: Uint8Array; collection: Uint8Array; session: Uint8Array; head: number;
  chain: Uint8Array; revision: number; pageCount: number; finalHash: Uint8Array;
}
const NATIVE_PAGE_BYTES = 4 * 1024 * 1024;
const NATIVE_OBJECT_BYTES = 9 * 1024 * 1024;

export type AppendResult =
  | { kind: "appended"; first: number; last: number }
  | { kind: "head-moved"; head: number; chain: Uint8Array }
  | { kind: "duplicate"; index: number; seq: number };

/** An error frame from the log service (log-service-api.md §10). */
export class LogServiceError extends Error {
  constructor(readonly code: string, readonly reason: string | undefined, readonly details?: Decoded) {
    super(`log service ${code}${reason ? ` (${reason})` : ""}`);
  }

  /** Waiting and retrying the same request can succeed. */
  get retryable(): boolean {
    return ["unavailable", "rate_limited", "unauthenticated"].includes(this.code);
  }
}

function edKey(pem: string, name: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${name} must be an Ed25519 key.`);
  return key;
}

const struct = (fields: Array<readonly [number, Cbor | undefined]>): Cbor => ({ struct: fields });

function field(value: Decoded, key: number): Decoded | undefined {
  return value instanceof Map ? value.get(key) : undefined;
}

function seqField(value: Decoded, key: number): number {
  const result = field(value, key);
  if (typeof result !== "number" || result < 0) throw new Error(`log service response field ${key} is not a sequence number`);
  return result;
}

function bytesField(value: Decoded, key: number): Uint8Array {
  const result = field(value, key);
  if (!(result instanceof Uint8Array)) throw new Error(`log service response field ${key} is not bytes`);
  return result;
}

const DELETION_REPLY_BYTES = 32 * 1024;
const deletionUnavailable = (): never => { throw new LogServiceError("unavailable", "collection_deletion_floor_unavailable"); };
function deletionFields(value: Decoded, count: number): Map<number | string, Decoded> {
  if (!(value instanceof Map) || value.size !== count || [...value.keys()].some((key, index) => key !== index)) return deletionUnavailable();
  return value;
}
function deletionUint(value: Decoded | undefined, positive = false): bigint {
  if (typeof value !== "bigint" && !(typeof value === "number" && Number.isSafeInteger(value))) return deletionUnavailable();
  const n = BigInt(value);
  if (n < (positive ? 1n : 0n) || n > (1n << 64n) - 1n) return deletionUnavailable();
  return n;
}
function deletionUuid(value: Decoded | undefined): string {
  if (!(value instanceof Uint8Array) || value.length !== 16 || value.every(byte => byte === 0)) return deletionUnavailable();
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function deletionUuidBytes(value: string): Uint8Array {
  if (typeof value !== "string" || value.length !== 36 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value) || value === "00000000-0000-0000-0000-000000000000") throw new Error("invalid_collection_deletion_uuid");
  return uuidBytes(value);
}
function deletionRow(value: Decoded): CollectionDeletionFact {
  if (!Array.isArray(value) || value.length !== 3) return deletionUnavailable();
  return {collection:deletionUuid(value[0]),deletionId:deletionUuid(value[1]),lifecycleEpoch:deletionUint(value[2],true)};
}

function nativeMap(value: Decoded, count: number, keys = Array.from({length: count}, (_, index) => index)): Map<number, Decoded> {
  if (!(value instanceof Map) || value.size !== count || [...value.keys()].some((key, index) => key !== keys[index])) throw new Error("native_backup_response_shape");
  return value as Map<number, Decoded>;
}
function nativeUint(value: Decoded | undefined, max: number, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > max) throw new Error("native_backup_integer_bounds");
  return value;
}
function nativeBytes(value: Decoded | undefined, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error("native_backup_bytes_shape");
  return value;
}
function nativeCbor(value: Decoded): Cbor {
  if (value instanceof Map) return struct([...value.entries()].map(([key, item]) => {
    if (typeof key !== "number") throw new Error("native_backup_response_shape");
    return [key, nativeCbor(item)] as const;
  }));
  if (Array.isArray(value)) return value.map(nativeCbor);
  return value;
}
function nativeFrame(value: Decoded, max: number): NativeBackupFrame {
  const fields = nativeMap(value, 2), raw = fields.get(0), hash = nativeBytes(fields.get(1), 32);
  if (!(raw instanceof Uint8Array) || !raw.length || raw.length > max || !createHash("sha256").update(raw).digest().equals(Buffer.from(hash))) throw new Error("native_backup_frame_hash");
  return {raw, hash};
}
function nativeAck(value: Decoded): void {
  if (nativeMap(value, 1).get(0) !== true) throw new Error("native_backup_ack");
}
function nativeAux(value: Decoded): {page: number; hash: Uint8Array} {
  const result = nativeMap(value, 3);
  if (result.get(0) !== true) throw new Error("native_backup_aux_ack");
  return {page: nativeUint(result.get(1), 65_536), hash: nativeBytes(result.get(2), 32)};
}
function validateNativePlan(plan: NativeRestorePlan): void {
  if (plan.length !== 8 || plan[0] !== 1) throw new Error("native_backup_restore_plan");
  nativeUint(plan[1], 64 * 1024 * 1024 * 1024 + 4 * 1024 * 1024 * 1024);
  nativeUint(plan[2], Number.MAX_SAFE_INTEGER - 1, true); nativeUint(plan[4], plan[2] + 1, true);
  for (const index of [3, 5, 6, 7] as const) nativeBytes(plan[index], 32);
}
function validateNativeSettings(settings: NativeRestoreSettings): void {
  if (settings.length !== 4 || settings[0] !== 1 || !Array.isArray(settings[1]) || settings[1].length !== 4 || ![30, 365].includes(settings[2]) || !Number.isSafeInteger(settings[3])) throw new Error("native_backup_restore_settings");
  for (const quota of settings[1]) nativeUint(quota, Number.MAX_SAFE_INTEGER);
}

export class LogServiceClient {
  private readonly issuer: KeyObject;
  private readonly transport: KeyObject;
  private readonly transportPublicKey: Uint8Array;
  private readonly baseUrl: string;
  private requestId = 0;
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(config: LogServiceConfig, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.baseUrl = config.url.replace(/\/+$/u, "");
    this.issuer = edKey(config.tokenIssuerKeyPem, "MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY");
    this.transport = edKey(config.transportKeyPem, "MDBASE_NEXT_LOG_TRANSPORT_KEY");
    this.transportPublicKey = ed25519RawPublicKey(this.transport);
  }

  /** Mint a log-service access token. Device tokens name the device and, narrowing them, one collection. */
  mintToken(claims: { device?: string; signPublicKey: Uint8Array; collection?: string; expiresAt: number }): string {
    const encoded = encodeCbor(struct([
      [0, claims.device ? 0 : 1],
      [1, claims.device ? uuidBytes(claims.device) : undefined],
      [2, claims.signPublicKey],
      [3, claims.expiresAt],
      [4, "mdbase-log"],
      [5, claims.collection ? uuidBytes(claims.collection) : undefined],
    ]));
    const signature = sign(null, domainHash("mdbase/v1/ls-token", encoded), this.issuer);
    return `${Buffer.from(encoded).toString("hex")}.${Buffer.from(signature).toString("hex")}`;
  }

  private controlPlaneToken(): string {
    const now = this.now();
    if (!this.cached || this.cached.expiresAt - 60_000 <= now) {
      const expiresAt = now + LOG_TOKEN_LIFETIME_MS;
      this.cached = { token: this.mintToken({ signPublicKey: this.transportPublicKey, expiresAt }), expiresAt };
    }
    return this.cached.token;
  }

  private async fetchBytes(path: string, init: RequestInit, limit?: number): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, ...(limit === undefined ? {} : {redirect:"manual"}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (limit !== undefined && response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new LogServiceError("unavailable", "redirect");
    }
    const body = limit === undefined ? new Uint8Array(await response.arrayBuffer()) : await readBoundedBytes(response, limit);
    if (!response.ok && !(response.headers.get("content-type") ?? "").includes("cbor")) {
      throw new LogServiceError(response.status >= 500 ? "unavailable" : "invalid", `http_${response.status}`);
    }
    return body;
  }

  private async rpc(method: string, params: Cbor, deletion = false, nativeLimit?: number): Promise<Decoded> {
    const strict = deletion || nativeLimit !== undefined;
    const nonceHex = new TextDecoder().decode(await this.fetchBytes("/v1/nonce", { method: "GET" }, strict ? 256 : undefined)).trim();
    if (!/^[0-9a-f]{64}$/u.test(nonceHex)) throw new LogServiceError("unavailable", "nonce");
    const requestId = ++this.requestId;
    const body = encodeCbor(struct([[0, 0], [1, requestId], [2, method], [3, params]]));
    if (nativeLimit !== undefined && body.length > NATIVE_OBJECT_BYTES + 64 * 1024) throw new Error("native_backup_request_bounds");
    const token = this.controlPlaneToken();
    const collectionField = field(field(decodeCbor(body), 3)!, 0);
    const collection = collectionField instanceof Uint8Array && collectionField.length === 16
      ? collectionField : new Uint8Array(16);
    // auth::http_digest: method is the LS RPC method, not HTTP POST.
    const digest = domainHash("mdbase/v1/ls-http", Buffer.concat([
      Buffer.from(method), Buffer.of(0), Buffer.from("/v1/rpc"), Buffer.of(0), collection,
      createHash("sha256").update(token, "utf8").digest(), createHash("sha256").update(body).digest(),
      Buffer.from(nonceHex, "hex"),
    ]));
    const frame = decodeCbor(await this.fetchBytes("/v1/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/vnd.mdbase.v1+cbor",
        authorization: `Bearer ${token}`,
        "x-mdbase-nonce": nonceHex,
        "x-mdbase-sig": Buffer.from(sign(null, digest, this.transport)).toString("hex"),
      },
      body: Buffer.from(body),
    }, deletion ? DELETION_REPLY_BYTES : nativeLimit), strict ? {canonicalStructs:true,maxDepth:deletion ? 12 : 32} : undefined);
    if (strict && (!(frame instanceof Map) || frame.size !== 3 || field(frame,0) !== 1 || field(frame,1) !== requestId || (frame.has(2) === frame.has(3)))) {
      if (deletion) return deletionUnavailable();
      throw new LogServiceError("unavailable", "native_backup_frame");
    }
    const error = field(frame, 3);
    if (error !== undefined) {
      const code = field(error, 0);
      const reason = field(error, 1);
      throw new LogServiceError(typeof code === "string" ? code : "invalid", typeof reason === "string" ? reason : undefined, field(error, 4));
    }
    const result = field(frame, 2);
    if (field(frame, 0) !== 1 || result === undefined) throw new Error("malformed log service response");
    return result;
  }

  /** Exact-position control read; control items are never compacted. */
  async controlItemAt(collection: string, seq: number): Promise<Uint8Array | null> {
    const result = await this.rpc("read", struct([[0, uuidBytes(collection)], [1, seq - 1], [2, 1], [3, 1]]));
    const items = field(result, 0);
    if (!Array.isArray(items)) throw new Error("malformed control read response");
    if (items.length === 0) return null;
    const item = items[0];
    if (!Array.isArray(item) || typeof item[0] !== "number" || !(item[1] instanceof Uint8Array)) throw new Error("malformed control item response");
    return item[0] === seq ? item[1] : null;
  }

  async head(collection: string): Promise<{ seq: number; chain: Uint8Array }> {
    const result = await this.rpc("head", struct([[0, uuidBytes(collection)]]));
    return { seq: seqField(result, 0), chain: bytesField(result, 1) };
  }

  async append(collection: string, expectSeq: number, expectPrev: Uint8Array, items: Uint8Array[]): Promise<AppendResult> {
    const result = await this.rpc("append", struct([[0, uuidBytes(collection)], [1, expectSeq], [2, expectPrev], [3, items]]));
    switch (field(result, 0)) {
      case 0: return { kind: "appended", first: seqField(result, 1), last: seqField(result, 2) };
      case 1: return { kind: "head-moved", head: seqField(result, 1), chain: bytesField(result, 2) };
      case 2: return { kind: "duplicate", index: seqField(result, 1), seq: seqField(result, 2) };
      default: throw new Error("unknown append result");
    }
  }

  /** `create_log`: idempotent for the same genesis bytes; `invalid`/`exists` for a different genesis. */
  async createLog(collection: string, genesis: Uint8Array): Promise<void> {
    await this.rpc("create_log", struct([[0, uuidBytes(collection)], [1, genesis]]));
  }

  async setQuota(collection: string, quotas: { storageBytes: number; itemsPerSecond: number; bytesPerSecond: number; burstItems: number }): Promise<void> {
    await this.rpc("set_quota", struct([[0, uuidBytes(collection)], [1, [quotas.storageBytes, quotas.itemsPerSecond, quotas.bytesPerSecond, quotas.burstItems]]]));
  }

  /** CP-only permanent nil floor. A matching floor is NOT a Gone/Deleted ACK. */
  async recordCollectionDeletion(fact: CollectionDeletionFact): Promise<{fact:CollectionDeletionFact;generation:bigint}> {
    const {collection,deletionId,lifecycleEpoch} = fact;
    const collectionBytes = deletionUuidBytes(collection), deletionBytes = deletionUuidBytes(deletionId);
    if (typeof lifecycleEpoch !== "bigint") throw new Error("invalid_collection_deletion_epoch");
    const epoch = deletionUint(lifecycleEpoch,true);
    const result = deletionFields(await this.rpc("registry_record_collection_deletion", struct([
      [0,new Uint8Array(16)],[1,collectionBytes],[2,deletionBytes],[3,epoch],
    ]),true),5);
    const actual = deletionRow([result.get(1)!,result.get(2)!,result.get(3)!]);
    if (result.get(0) !== 1 || actual.collection !== collection || actual.deletionId !== deletionId || actual.lifecycleEpoch !== epoch) return deletionUnavailable();
    return {fact:actual,generation:deletionUint(result.get(4))};
  }

  /** Generation-pinned keyset page; never a cached positive liveness permit. */
  async registryCollectionDeletions(after: string | null = null, expected: bigint | null = null): Promise<CollectionDeletionPage> {
    const cursor = after === null ? null : deletionUuidBytes(after);
    if (after !== null && expected === null) throw new Error("collection_deletion_generation_required");
    if (expected !== null && typeof expected !== "bigint") throw new Error("invalid_collection_deletion_generation");
    const generation = expected === null ? null : deletionUint(expected);
    const result = deletionFields(await this.rpc("registry_collection_deletions", struct([
      [0,new Uint8Array(16)],[1,cursor],[2,generation],
    ]),true),5);
    const revision = deletionUint(result.get(1)), values = result.get(2), done = result.get(4);
    if (result.get(0) !== 1 || (expected !== null && revision !== expected) || !Array.isArray(values) || values.length > 128 || typeof done !== "boolean" || done !== (values.length < 128)) return deletionUnavailable();
    const rows = values.map(deletionRow);
    let previous = after;
    for (const row of rows) { if (previous !== null && row.collection <= previous) return deletionUnavailable(); previous = row.collection; }
    const next = result.get(3) === null ? null : deletionUuid(result.get(3));
    if (next !== previous) return deletionUnavailable();
    return {generation:revision,rows,after:next,done};
  }

  /** Fixed native backup/import methods. No generic RPC or CP token is exposed. */
  async backupBegin(collection: string): Promise<NativeBackupFrame> {
    return nativeFrame(await this.rpc("backup_begin", struct([[0, deletionUuidBytes(collection)]]), false, 128 * 1024), 64 * 1024);
  }

  async backupPage(collection: string, session: Uint8Array, page: number, previous: Uint8Array): Promise<NativeBackupFrame> {
    nativeBytes(session, 16); nativeBytes(previous, 32); nativeUint(page, 65_536, true);
    return nativeFrame(await this.rpc("backup_page", struct([[0, deletionUuidBytes(collection)], [1, session], [2, page], [3, previous]]), false, NATIVE_PAGE_BYTES + 1024), NATIVE_PAGE_BYTES);
  }

  async backupFinish(collection: string, session: Uint8Array, finalHash: Uint8Array): Promise<NativeBackupFinish> {
    nativeBytes(session, 16); nativeBytes(finalHash, 32);
    const result = nativeMap(await this.rpc("backup_finish", struct([[0, deletionUuidBytes(collection)], [1, session], [2, finalHash]]), false, 64 * 1024), 8);
    if (result.get(0) !== 1) throw new Error("native_backup_finish");
    const actualCollection = nativeBytes(result.get(1), 16), actualSession = nativeBytes(result.get(2), 16), actualHash = nativeBytes(result.get(7), 32);
    if (!Buffer.from(actualCollection).equals(Buffer.from(deletionUuidBytes(collection))) || !Buffer.from(actualSession).equals(Buffer.from(session)) || !Buffer.from(actualHash).equals(Buffer.from(finalHash))) throw new Error("native_backup_finish_binding");
    return {raw: encodeCbor(struct([...result.entries()].map(([key, value]) => [key, nativeCbor(value)]))), collection: actualCollection, session: actualSession,
      head: nativeUint(result.get(3), Number.MAX_SAFE_INTEGER, true), chain: nativeBytes(result.get(4), 32), revision: nativeUint(result.get(5), 2 ** 52, true),
      pageCount: nativeUint(result.get(6), 65_536, true), finalHash: actualHash};
  }

  async backupAbort(collection: string, session: Uint8Array): Promise<void> {
    nativeBytes(session, 16);
    nativeAck(await this.rpc("backup_abort", struct([[0, deletionUuidBytes(collection)], [1, session]]), false, 64 * 1024));
  }

  /** Explicit bounded range: avoids issuing or following object download URLs. */
  async nativeObjectRange(collection: string, address: Uint8Array, offset: number, length: number): Promise<{bytes: Uint8Array; size: number; checksum: Uint8Array}> {
    nativeBytes(address, 32); nativeUint(offset, NATIVE_OBJECT_BYTES); nativeUint(length, 1024 * 1024, true);
    if (offset + length > NATIVE_OBJECT_BYTES) throw new Error("native_backup_object_bounds");
    const result = nativeMap(await this.rpc("get_object", struct([[0, deletionUuidBytes(collection)], [1, address], [2, [offset, length]]]), false, length + 1024), 3, [0, 2, 3]);
    const raw = result.get(0);
    if (!(raw instanceof Uint8Array) || raw.length !== length) throw new Error("native_backup_object_range");
    return {bytes: raw, size: nativeUint(result.get(2), NATIVE_OBJECT_BYTES, true), checksum: nativeBytes(result.get(3), 32)};
  }

  async importNativeItems(collection: string, input: {items: ReadonlyArray<readonly [number, Uint8Array]>; settings?: NativeRestoreSettings; plan?: NativeRestorePlan; final?: {retainedFrom: number; head: number; chain: Uint8Array}}): Promise<{head: number; chain: Uint8Array; live: boolean; strict: boolean}> {
    if (input.items.length > 32 || input.items.reduce((sum, [seq, bytes]) => {nativeUint(seq, Number.MAX_SAFE_INTEGER, true); if (!(bytes instanceof Uint8Array)) throw new Error("native_backup_item"); return sum + bytes.length;}, 0) > NATIVE_PAGE_BYTES) throw new Error("native_backup_items_bounds");
    if (input.plan) validateNativePlan(input.plan);
    if (input.settings) validateNativeSettings(input.settings);
    if (input.plan && !input.settings) throw new Error("native_backup_settings_required");
    const final = input.final;
    if (final) {nativeUint(final.retainedFrom, Number.MAX_SAFE_INTEGER, true); nativeUint(final.head, Number.MAX_SAFE_INTEGER, true); nativeBytes(final.chain, 32);}
    const result = nativeMap(await this.rpc("import", struct([[0, deletionUuidBytes(collection)], [1, input.items.map(([seq, bytes]) => [seq, bytes])],
      [2, final ? struct([[0, final.retainedFrom], [1, final.head], [2, final.chain]]) : undefined],
      [3, input.settings ? [...input.settings].map(value => Array.isArray(value) ? [...value] : value) as Cbor : undefined], [4, input.plan ? [...input.plan] : undefined]]), false, 64 * 1024), 4);
    if (typeof result.get(2) !== "boolean" || result.get(3) !== true) throw new Error("native_backup_strict_import");
    return {head: nativeUint(result.get(0), Number.MAX_SAFE_INTEGER, true), chain: nativeBytes(result.get(1), 32), live: result.get(2) as boolean, strict: true};
  }

  async importNativeObject(collection: string, address: Uint8Array, kind: number, bytes: Uint8Array): Promise<void> {
    nativeBytes(address, 32);
    if (![16, 17, 18, 19].includes(kind) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > NATIVE_OBJECT_BYTES) throw new Error("native_backup_object_bounds");
    nativeAck(await this.rpc("import_object", struct([[0, deletionUuidBytes(collection)], [1, address], [2, kind], [3, bytes]]), false, 64 * 1024));
  }

  async importNativeSnapshot(collection: string, pointer: readonly [number, Uint8Array, Uint8Array, number, boolean], refs: readonly Uint8Array[]): Promise<void> {
    nativeUint(pointer[0], Number.MAX_SAFE_INTEGER, true); nativeBytes(pointer[1], 32); nativeBytes(pointer[2], 16);
    if (!Number.isSafeInteger(pointer[3]) || typeof pointer[4] !== "boolean" || refs.length > 4096) throw new Error("native_backup_snapshot_bounds");
    for (const ref of refs) nativeBytes(ref, 32);
    nativeAck(await this.rpc("import_snapshot", struct([[0, deletionUuidBytes(collection)], [1, struct(pointer.map((value, index) => [index, value]))], [2, [...refs]]]), false, 64 * 1024));
  }

  async restoreAuxBegin(collection: string, header: Uint8Array, finalHash: Uint8Array, pageCount: number): Promise<{page: number; hash: Uint8Array}> {
    if (!(header instanceof Uint8Array) || !header.length || header.length > 64 * 1024) throw new Error("native_backup_header_bounds");
    nativeBytes(finalHash, 32); nativeUint(pageCount, 65_536, true);
    return nativeAux(await this.rpc("restore_aux_begin", struct([[0, deletionUuidBytes(collection)], [1, header], [2, finalHash], [3, pageCount]]), false, 64 * 1024));
  }

  async restoreAuxPage(collection: string, page: Uint8Array): Promise<{page: number; hash: Uint8Array}> {
    if (!(page instanceof Uint8Array) || !page.length || page.length > NATIVE_PAGE_BYTES) throw new Error("native_backup_page_bounds");
    return nativeAux(await this.rpc("restore_aux_page", struct([[0, deletionUuidBytes(collection)], [1, page]]), false, 64 * 1024));
  }

  async deleteLog(collection: string): Promise<void> {
    await this.rpc("delete_log", struct([[0, uuidBytes(collection)]]));
  }
}

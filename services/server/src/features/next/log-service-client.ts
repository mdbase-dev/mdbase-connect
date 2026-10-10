// The control plane's client for the mdbase-next log service (log-service-api.md §3,
// §4, §5, §12) over plain HTTPS: `GET /v1/nonce`, then `POST /v1/rpc` with an
// `ls-request` frame, a bearer token and a proof-of-possession signature.
//
// Tokens follow the log service's format (crates/log-service/src/auth.rs):
//   hex(claims) "." hex(Ed25519(issuer, H("mdbase/v1/ls-token", claims)))
//   claims = {0: role (0 device, 1 control plane), ? 1: device, 2: sign_pk,
//             3: expires_at ms, 4: "mdbase-log", ? 5: collection}
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { decodeCbor, domainHash, encodeCbor, keyId, uuidBytes, type Cbor, type Decoded } from "./policy-wire.js";
import { ed25519RawPublicKey, type LogServiceConfig } from "./policy-keys.js";
import type { CollectionDeletionFact, CollectionDeletionPage } from "./collection-deletion.js";
import { readBoundedBytes } from "../../platform/bounded-json.js";
import { pitrLogUrl, type LabPitrConfig } from "./lab-pitr-config.js";

export const LOG_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

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

export class LogServiceClient {
  private readonly issuer: KeyObject;
  private readonly transport: KeyObject;
  private readonly transportPublicKey: Uint8Array;
  private readonly baseUrl: string;
  private readonly pitr: LabPitrConfig | undefined;
  private readonly pitrPublicIdentity: Readonly<{ transportPublicKey: string; issuerKeyId: string }> | undefined;
  private requestId = 0;
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(config: LogServiceConfig, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    this.baseUrl = config.url.replace(/\/+$/u, "");
    this.pitr = config.labPitr ? Object.freeze({ ...config.labPitr }) : undefined;
    this.issuer = edKey(config.tokenIssuerKeyPem, "MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY");
    this.transport = edKey(config.transportKeyPem, "MDBASE_NEXT_LOG_TRANSPORT_KEY");
    this.transportPublicKey = ed25519RawPublicKey(this.transport);
    // Public metadata only, captured once from already loaded startup keys. The
    // observer never parses a PEM, signs, mints a token or reads private material.
    this.pitrPublicIdentity = this.pitr ? Object.freeze({ transportPublicKey: Buffer.from(this.transportPublicKey).toString("hex"),
      issuerKeyId: Buffer.from(keyId(ed25519RawPublicKey(this.issuer))).toString("hex") }) : undefined;
  }

  pitrControlIdentity(): Readonly<{ transportPublicKey: string; issuerKeyId: string }> | null {
    return this.pitrPublicIdentity ? { ...this.pitrPublicIdentity } : null;
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

  private async fetchBytes(path: string, init: RequestInit, limit?: number, base = this.baseUrl): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${base}${path}`, { ...init, ...(limit === undefined ? {} : {redirect:"manual"}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

  private async rpc(method: string, params: Cbor, deletion = false, isolatedRegistry = false): Promise<Decoded> {
    if (isolatedRegistry && (!this.pitr || method !== "registry_collection_deletions")) throw new Error("lab_pitr_registry_configuration_required");
    const requestId = ++this.requestId;
    const body = encodeCbor(struct([[0, 0], [1, requestId], [2, method], [3, params]]));
    const decoded = field(decodeCbor(body), 3)!;
    // Registry deletion writes name the original subject in field 1, not nil field 0.
    const subject = field(decoded, method === "registry_record_collection_deletion" ? 1 : 0);
    const hex = subject instanceof Uint8Array && subject.length === 16 ? Buffer.from(subject).toString("hex") : "";
    const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const base = isolatedRegistry ? this.pitr!.logUrl : pitrLogUrl(this.baseUrl, this.pitr, id);
    const nonceHex = new TextDecoder().decode(await this.fetchBytes("/v1/nonce", { method: "GET" }, deletion ? 256 : undefined, base)).trim();
    if (!/^[0-9a-f]{64}$/u.test(nonceHex)) throw new LogServiceError("unavailable", "nonce");
    const token = this.controlPlaneToken();
    const collectionField = field(decoded, 0);
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
    }, deletion ? DELETION_REPLY_BYTES : undefined, base), deletion ? {canonicalStructs:true,maxDepth:12} : undefined);
    if (deletion && (!(frame instanceof Map) || frame.size !== 3 || field(frame,0) !== 1 || field(frame,1) !== requestId || (frame.has(2) === frame.has(3)))) return deletionUnavailable();
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
    return this.deletionPage(after, expected, false);
  }

  /** Fixed-run nil cut, never the shared registry or a liveness permit. */
  async labPitrCollectionDeletions(run: string, after: string | null = null, expected: bigint | null = null): Promise<CollectionDeletionPage> {
    if (!this.pitr || run !== this.pitr.run || (after !== null && after !== this.pitr.active && after !== this.pitr.deleted)) throw new Error("lab_pitr_registry_configuration_required");
    return this.deletionPage(after, expected, true);
  }

  private async deletionPage(after: string | null, expected: bigint | null, isolated: boolean): Promise<CollectionDeletionPage> {
    const cursor = after === null ? null : deletionUuidBytes(after);
    if (after !== null && expected === null) throw new Error("collection_deletion_generation_required");
    if (expected !== null && typeof expected !== "bigint") throw new Error("invalid_collection_deletion_generation");
    const generation = expected === null ? null : deletionUint(expected);
    const result = deletionFields(await this.rpc("registry_collection_deletions", struct([
      [0,new Uint8Array(16)],[1,cursor],[2,generation],
    ]),true,isolated),5);
    const revision = deletionUint(result.get(1)), values = result.get(2), done = result.get(4);
    if (result.get(0) !== 1 || (expected !== null && revision !== expected) || !Array.isArray(values) || values.length > 128 || typeof done !== "boolean" || done !== (values.length < 128)) return deletionUnavailable();
    const rows = values.map(deletionRow);
    if (isolated && rows.some(row => row.collection !== this.pitr!.active && row.collection !== this.pitr!.deleted)) return deletionUnavailable();
    let previous = after;
    for (const row of rows) { if (previous !== null && row.collection <= previous) return deletionUnavailable(); previous = row.collection; }
    const next = result.get(3) === null ? null : deletionUuid(result.get(3));
    if (next !== previous) return deletionUnavailable();
    return {generation:revision,rows,after:next,done};
  }

  async deleteLog(collection: string): Promise<void> {
    await this.rpc("delete_log", struct([[0, uuidBytes(collection)]]));
  }
}

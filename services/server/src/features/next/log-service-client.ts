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

export const LOG_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export type AppendResult =
  | { kind: "appended"; first: number; last: number }
  | { kind: "head-moved"; head: number; chain: Uint8Array }
  | { kind: "duplicate"; index: number; seq: number };

/** An error frame from the log service (log-service-api.md §10). */
export class LogServiceError extends Error {
  constructor(readonly code: string, readonly reason: string | undefined) {
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

  private async fetchBytes(path: string, init: RequestInit): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok && !(response.headers.get("content-type") ?? "").includes("cbor")) {
      throw new LogServiceError(response.status >= 500 ? "unavailable" : "invalid", `http_${response.status}`);
    }
    return body;
  }

  private async rpc(method: string, params: Cbor): Promise<Decoded> {
    const nonceHex = new TextDecoder().decode(await this.fetchBytes("/v1/nonce", { method: "GET" })).trim();
    if (!/^[0-9a-f]{64}$/u.test(nonceHex)) throw new LogServiceError("unavailable", "nonce");
    this.requestId += 1;
    const body = encodeCbor(struct([[0, 0], [1, this.requestId], [2, method], [3, params]]));
    const digest = domainHash("mdbase/v1/item-sig", Buffer.concat([
      Buffer.from("ls-http"), Buffer.from(nonceHex, "hex"), Buffer.from(method), Buffer.of(0), createHash("sha256").update(body).digest(),
    ]));
    const frame = decodeCbor(await this.fetchBytes("/v1/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/vnd.mdbase.v1+cbor",
        authorization: `Bearer ${this.controlPlaneToken()}`,
        "x-mdbase-nonce": nonceHex,
        "x-mdbase-sig": Buffer.from(sign(null, digest, this.transport)).toString("hex"),
      },
      body: Buffer.from(body),
    }));
    const error = field(frame, 3);
    if (error !== undefined) {
      const code = field(error, 0);
      const reason = field(error, 1);
      throw new LogServiceError(typeof code === "string" ? code : "invalid", typeof reason === "string" ? reason : undefined);
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

  async deleteLog(collection: string): Promise<void> {
    await this.rpc("delete_log", struct([[0, uuidBytes(collection)]]));
  }
}

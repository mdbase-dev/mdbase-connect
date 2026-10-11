/**
 * The hosted deployment's client of the Connect control plane (cloud-copy bootstrap;
 * Connect PRs #615/#616). Custody (src/custody/, hosted) uses it to read this
 * collection's service-device record and to obtain and refresh the role-0 log token.
 *
 * - `GET  <cp>/internal/v1/next/collections/:id/service-devices/hosted`
 * - `POST <cp>/internal/v1/next/service-devices/:device/log-token {collection}`
 *
 * Authenticated by the deployment's inbound control-plane token
 * (`MDBASE_NEXT_HOSTED_INTERNAL_TOKEN` on the Connect side). HTTPS only, no
 * redirects, bounded responses, abortable. A record is data to verify, not trust:
 * custody re-derives the public keys after unwrap and checks them against this record
 * and the log's enrolment. Tokens are cached in RAM only and refreshed a minute before
 * they expire.
 */

import { parsePitrBinding, PITR_RUN, type PitrBinding } from "./pitr-phase.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const KEY = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_WRAPPED_BYTES = 64 * 1024;
const TOKEN_LIFETIME_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 60_000;
const TIMEOUT_MS = 10_000;
const CURRENT_TIMEOUT_MS = 5000;
const MAX_CURRENT_BYTES = 4096;
const MAX_READS = 64;
const CPP_HEX32 = /^[0-9a-f]{64}(?![\s\S])/;
const CPP_HEX64 = /^[0-9a-f]{128}(?![\s\S])/;
const CPP_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/;
const cppUuid = (s: unknown): s is string => typeof s === "string" && CPP_UUID.test(s) && s !== "00000000-0000-0000-0000-000000000000";
const cppObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

/** Authenticated channel response DATA; never a physical/native/pending permit. */
export interface MigrationClaimData {
  schema: "mdbase-migration-claim/1";
  collection_id: string;
  owner_account: string;
  started_us: string;
  target: { runtime: "shadow"; root_key_id: string; hosted: {
    device_id: string; sign_pk: string; kem_pk: string; noise_pk: string;
  } };
}
export interface MigrationClaimReadProof { device_id: string; challenge: string; sig: string; }

/** Public ORIGINAL identity verified by the caller before checking current CP.
 * No permission flags, substituted issuer, or restored positive permit. */
export interface PitrIdentity {
  collection: string;
  device: string;
  kind: "desktop" | "mobile" | "app-runtime" | "cli" | "hosted" | "escrow";
  signPublicKey: string;
  genesisSha256: string;
  policyKeyId: string;
}
const IDENTITY_KEYS = ["collection", "device", "kind", "signPublicKey", "genesisSha256", "policyKeyId"] as const;
/** ORIGINAL LS grant UUID/current client PK, not a grants.id or device identity.
 * Runtime must first verify its original signed caller and policy transcript. */
export interface PitrAppGrantIdentity {
  principal: "app-grant";
  collection: string;
  grant: string;
  clientPublicKey: string;
  genesisSha256: string;
  policyKeyId: string;
}
const GRANT_KEYS = ["principal", "collection", "grant", "clientPublicKey", "genesisSha256", "policyKeyId"] as const;
/** Verified original CP token issuer + transport proof, never a device principal.
 * This purpose observes pending original genesis, not nil/serving authority. */
export interface PitrCpGenesisIdentity {
  principal: "control-plane";
  purpose: "pending-original-genesis";
  collection: string;
  genesisSha256: string;
  transportPublicKey: string;
  issuerKeyId: string;
  policyKeyId: string;
}
const CP_GENESIS_KEYS = ["principal", "purpose", "collection", "genesisSha256", "transportPublicKey", "issuerKeyId", "policyKeyId"] as const;
/** Appended/current-member CP collection point, NOT pending-genesis authority. */
export type PitrCpCollectionIdentity = Omit<PitrCpGenesisIdentity,"purpose"> & {purpose:"collection"};
/** Both original run subjects plus the verified CP issuer/transport. Nil can only
 * read isolated denial metadata or propagate an exact live-CP denial tuple. */
export type PitrCpNilReadIdentity = Omit<PitrCpGenesisIdentity,"purpose"|"genesisSha256"> & {
  collection:"00000000-0000-0000-0000-000000000000";purpose:"registry-read";
  activeGenesisSha256:string;deletedGenesisSha256:string;
};
export type PitrCpNilRecordIdentity = Omit<PitrCpNilReadIdentity,"purpose"> & {
  purpose:"deletion-record";subject:string;deletionId:string;lifecycleEpoch:string;
};
export type PitrCpNilPeekIdentity = Omit<PitrCpGenesisIdentity,"purpose"> & {
  collection:"00000000-0000-0000-0000-000000000000";purpose:"deletion-peek";subject:string;
};
type CpPointIdentity=PitrCpCollectionIdentity|PitrCpNilPeekIdentity|PitrCpNilReadIdentity|PitrCpNilRecordIdentity;
const CP_NIL_KEYS=["principal","purpose","collection","transportPublicKey","issuerKeyId","policyKeyId","activeGenesisSha256","deletedGenesisSha256"] as const;
function cpPointIdentityValid(value:CpPointIdentity):boolean{
  if(!value||typeof value!=="object"||value.principal!=="control-plane"
    ||typeof value.transportPublicKey!=="string"||!KEY.test(value.transportPublicKey)||value.transportPublicKey==="0".repeat(64)
    ||typeof value.issuerKeyId!=="string"||!/^[0-9a-f]{32}$/.test(value.issuerKeyId)
    ||typeof value.policyKeyId!=="string"||!/^[0-9a-f]{32}$/.test(value.policyKeyId))return false;
  const keys=value.purpose==="collection"?CP_GENESIS_KEYS:value.purpose==="deletion-peek"?[...CP_GENESIS_KEYS,"subject"]:value.purpose==="registry-read"?CP_NIL_KEYS
    :value.purpose==="deletion-record"?[...CP_NIL_KEYS,"subject","deletionId","lifecycleEpoch"]:[];
  if(!keys.length||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k)))return false;
  if(value.purpose==="collection")return nonnil(value.collection)&&typeof value.genesisSha256==="string"&&KEY.test(value.genesisSha256);
  if(value.purpose==="deletion-peek")return value.collection==="00000000-0000-0000-0000-000000000000"&&nonnil(value.subject)
    &&typeof value.genesisSha256==="string"&&KEY.test(value.genesisSha256);
  if(value.collection!=="00000000-0000-0000-0000-000000000000"||typeof value.activeGenesisSha256!=="string"||!KEY.test(value.activeGenesisSha256)
    ||typeof value.deletedGenesisSha256!=="string"||!KEY.test(value.deletedGenesisSha256))return false;
  return value.purpose==="registry-read"||(nonnil(value.subject)&&nonnil(value.deletionId)&&typeof value.lifecycleEpoch==="string"
    &&/^[1-9][0-9]{0,19}$/.test(value.lifecycleEpoch)&&BigInt(value.lifecycleEpoch)<=(1n<<64n)-1n);
}
const nonnil = (s: unknown): s is string => typeof s === "string" && UUID.test(s) && s !== "00000000-0000-0000-0000-000000000000";
function identityValid(value: PitrIdentity): boolean {
  return value !== null && typeof value === "object" && Object.keys(value).length === IDENTITY_KEYS.length
    && IDENTITY_KEYS.every(k => Object.hasOwn(value, k)) && nonnil(value.collection) && nonnil(value.device)
    && ["desktop", "mobile", "app-runtime", "cli", "hosted", "escrow"].includes(value.kind)
    && typeof value.signPublicKey === "string" && KEY.test(value.signPublicKey)
    && typeof value.genesisSha256 === "string" && KEY.test(value.genesisSha256)
    && typeof value.policyKeyId === "string" && /^[0-9a-f]{32}$/.test(value.policyKeyId);
}

function grantIdentityValid(value: PitrAppGrantIdentity): boolean {
  return value !== null && typeof value === "object" && Object.keys(value).length === GRANT_KEYS.length
    && GRANT_KEYS.every(k => Object.hasOwn(value,k)) && value.principal === "app-grant"
    && nonnil(value.collection) && nonnil(value.grant) && typeof value.clientPublicKey === "string"
    && KEY.test(value.clientPublicKey) && value.clientPublicKey !== "0".repeat(64)
    && typeof value.genesisSha256 === "string" && KEY.test(value.genesisSha256)
    && typeof value.policyKeyId === "string" && /^[0-9a-f]{32}$/.test(value.policyKeyId);
}

function cpGenesisIdentityValid(value: PitrCpGenesisIdentity): boolean {
  return value !== null && typeof value === "object" && Object.keys(value).length === CP_GENESIS_KEYS.length
    && CP_GENESIS_KEYS.every(k => Object.hasOwn(value,k)) && value.principal === "control-plane"
    && value.purpose === "pending-original-genesis" && nonnil(value.collection)
    && typeof value.genesisSha256 === "string" && KEY.test(value.genesisSha256)
    && typeof value.transportPublicKey === "string" && KEY.test(value.transportPublicKey) && value.transportPublicKey !== "0".repeat(64)
    && typeof value.issuerKeyId === "string" && /^[0-9a-f]{32}$/.test(value.issuerKeyId)
    && typeof value.policyKeyId === "string" && /^[0-9a-f]{32}$/.test(value.policyKeyId);
}

export type ControlErrorCode = "unavailable" | "refused" | "not_standard" | "not_found" | "invalid";

export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode, message: string) {
    super(message);
  }
}

export interface OriginalGenesis {
  seq: 1;
  /** Complete ORIGINAL signed CBOR bytes, never a log-discovered replacement. */
  item: Uint8Array;
  /** Plain SHA256 checksum only; native derives its own domain-separated pin. */
  hash: Uint8Array;
}

export interface ServiceDeviceRecord {
  kind: "hosted" | "escrow";
  deviceId: string;
  signPk: Uint8Array;
  kemPk: Uint8Array;
  noisePk: Uint8Array;
  /** The MDBK envelope, opaque here. */
  wrappedKeys: Uint8Array;
  kmsKeyArn: string;
  genesis: OriginalGenesis;
}

export interface LogToken {
  token: string;
  expiresAt: number;
}

const fromHex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

function fromBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  try {
    const binary = atob(s);
    return btoa(binary) === s ? Uint8Array.from(binary, (c) => c.charCodeAt(0)) : null;
  } catch {
    return null;
  }
}

function statusError(status: number): ControlError {
  if (status === 409) return new ControlError("not_standard", "the collection is not a current cloud copy");
  if (status === 404) return new ControlError("not_found", "no such service device");
  if (status >= 500) return new ControlError("unavailable", `control plane answered ${status}`);
  return new ControlError("refused", `control plane answered ${status}`);
}

/** Fixed diagnostic vocabulary only: never expose a fetch exception's URL,
 * credentials, response content or arbitrary message to callers/logs. */
function fetchFailure(cause: unknown, signal: AbortSignal): string {
  if (typeof AbortSignal.any !== "function") return "abort_any_unavailable";
  if (typeof AbortSignal.timeout !== "function") return "abort_timeout_unavailable";
  if (signal.aborted) return "caller_aborted";
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return "timeout";
    if (cause.name === "AbortError") return "aborted";
    if (cause.message.includes("different request") || cause.message.includes("I/O on behalf")) return "io_context";
    if (cause.message.includes("signal") && cause.message.includes("AbortSignal")) return "signal_type";
    if (cause.name === "TypeError") return "type_error";
  }
  return "network";
}

export class ControlClient {
  readonly #base: string;
  readonly #cppOrigin: string | null;
  private readonly token: string;
  private readonly tokens = new Map<string, LogToken>();
  private readonly kind: "hosted" | "escrow";
  private readonly pitr: { binding: PitrBinding; token: string } | undefined;

  constructor(
    config: { url: string; token: string; kind?: "hosted" | "escrow";
      pitr?: { binding: PitrBinding; token: string } },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(config.url);
    if (url.protocol !== "https:") throw new Error("the control plane URL must use https");
    if (config.token.length < 32) throw new Error("the control plane token must be at least 32 characters");
    this.#base = url.toString().replace(/\/+$/, "");
    // Immutable configuration DATA only. Actual provenance comes separately
    // from productionParts' private, compiled-release-verified object brand.
    this.#cppOrigin = (config.kind ?? "hosted") === "hosted" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash && this.#base === url.origin
      && url.origin.length <= 255 && /^[\x21-\x7e]+$/.test(url.origin) ? url.origin : null;
    this.token = config.token;
    this.kind = config.kind ?? "hosted";
    if (config.pitr !== undefined) {
      if (!config.pitr || typeof config.pitr !== "object" || Object.keys(config.pitr).length !== 2
          || !Object.hasOwn(config.pitr, "binding") || !Object.hasOwn(config.pitr, "token")) throw new ControlError("invalid", "pitr_control_configuration");
      const binding = parsePitrBinding(JSON.stringify(config.pitr.binding));
      if (this.#base !== "https://connect-lab.mdbase.dev" || !binding
          || typeof config.pitr.token !== "string" || !/^[!-~]{32,256}$/.test(config.pitr.token)
          || config.pitr.token === this.token) throw new ControlError("invalid", "pitr_control_configuration");
      this.pitr = Object.freeze({ binding, token: config.pitr.token });
    }
  }

  /** Configuration DATA, never an admission/provenance result or secret getter. */
  cppClaimOriginData(): string | null { return this.#cppOrigin; }

  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown }, limit: number,
    signal: AbortSignal, current = false, timeoutMs = current ? CURRENT_TIMEOUT_MS : TIMEOUT_MS): Promise<unknown> {
    const abort = new AbortController();
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let rejectDeadline: (e: ControlError) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const stop = () => {
      closed = true; abort.abort();
      rejectDeadline(new ControlError("unavailable", "control plane current request closed"));
    };
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, timeoutMs);
    try {
      if (signal.aborted) throw new ControlError("unavailable", "control plane unreachable (caller_aborted)");
      try {
        // Free callable: Workers native fetch rejects an object receiver.
        const fetchImpl = this.fetchImpl;
        response = await bounded(fetchImpl(`${this.#base}${path}`, {
          method: init.method,
          headers: { authorization: `Bearer ${current ? this.pitr!.token : this.token}`,
            ...(init.body ? { "content-type": "application/json" } : {}) },
          body: init.body ? JSON.stringify(init.body) : undefined,
          redirect: "manual", cache: "no-store",
          signal: AbortSignal.any([signal, abort.signal, AbortSignal.timeout(timeoutMs)]),
        }).then(async result => {
          if (!closed) return result;
          try { if (result.body) await bounded(result.body.cancel()); } catch { /* Best-effort late-body cleanup. */ }
          throw new ControlError("unavailable", "control plane current request closed");
        }));
      } catch (cause) {
        throw new ControlError("unavailable", `control plane unreachable (${fetchFailure(cause, signal)})`);
      }
      if (!response) throw new ControlError("unavailable", "control plane response unavailable");
      if ((response.type as string) === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new ControlError("refused", "control plane redirected; not followed");
      }
      if (!response.ok) throw statusError(response.status);
      reader = response.body?.getReader();
      const bytes = new Uint8Array(limit);
      let length = 0;
      for (let reads = 0; reads < MAX_READS; reads++) {
        const next = reader ? await bounded(reader.read()) : { done: true as const, value: undefined };
        if (next.done) { complete = true; break; }
        if (next.value.byteLength > limit - length) throw new ControlError("invalid", "control plane answer too large");
        bytes.set(next.value, length); length += next.value.byteLength;
      }
      if (!complete || closed || signal.aborted) throw new ControlError("unavailable", "control plane current request closed");
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)));
      } catch { throw new ControlError("invalid", "control plane answer is not JSON"); }
    } catch (cause) {
      if (cause instanceof ControlError) throw cause;
      throw new ControlError("unavailable", "control plane response unavailable");
    } finally {
      if (reader) {
        if (!complete) { try { await bounded(reader.cancel()); } catch { /* Cleanup cannot extend deadline. */ } }
        try { reader.releaseLock(); } catch { /* Closed. */ }
      } else if (response?.body) { try { await bounded(response.body.cancel()); } catch { /* Closed. */ } }
      clearTimeout(timer!); signal.removeEventListener("abort", stop); abort.abort();
    }
  }

  /** One request, no nonce renewal/replay/redirect, only the existing hosted
   * role credential. Native supplies the collection/device; this is transport
   * DATA and does not establish actual factory/native/physical provenance. */
  async migrationClaimChallenge(collection: string, device: string, signal: AbortSignal): Promise<Uint8Array> {
    this.requireCppSubject(collection, device);
    const r = await this.call(`/internal/v1/next/migration/collections/${collection}/claim/challenge`,
      { method: "POST", body: { device_id: device } }, 1024, signal, false, CURRENT_TIMEOUT_MS);
    if (!cppObject(r, ["challenge"]) || typeof r.challenge !== "string" || !CPP_HEX32.test(r.challenge) || signal.aborted)
      throw new ControlError("invalid", "migration_claim_challenge_invalid");
    return fromHex(r.challenge);
  }

  /** One fresh uncached read. Caller owns post-await native/physical/pending
   * checks and compares this DATA to its accepted originals, not JS flags. */
  async migrationClaimRead(collection: string, proof: MigrationClaimReadProof, signal: AbortSignal): Promise<MigrationClaimData> {
    if (!cppObject(proof, ["device_id", "challenge", "sig"]) || !cppUuid(proof.device_id)
      || typeof proof.challenge !== "string" || !CPP_HEX32.test(proof.challenge)
      || typeof proof.sig !== "string" || !CPP_HEX64.test(proof.sig)) throw new ControlError("invalid", "migration_claim_proof_invalid");
    this.requireCppSubject(collection, proof.device_id);
    const body = { device_id: proof.device_id, challenge: proof.challenge, sig: proof.sig };
    const r = await this.call(`/internal/v1/next/migration/collections/${collection}/claim/read`,
      { method: "POST", body }, MAX_CURRENT_BYTES, signal, false, CURRENT_TIMEOUT_MS);
    if (!cppObject(r, ["schema", "collection_id", "owner_account", "started_us", "target"])
      || r.schema !== "mdbase-migration-claim/1" || r.collection_id !== collection || !cppUuid(r.owner_account)
      || typeof r.started_us !== "string" || !/^[1-9][0-9]{0,23}(?![\s\S])/.test(r.started_us)
      || !cppObject(r.target, ["runtime", "root_key_id", "hosted"]) || r.target.runtime !== "shadow"
      || typeof r.target.root_key_id !== "string" || !/^[0-9a-f]{32}(?![\s\S])/.test(r.target.root_key_id)
      || !cppObject(r.target.hosted, ["device_id", "sign_pk", "kem_pk", "noise_pk"])
      || r.target.hosted.device_id !== body.device_id
      || ![r.target.hosted.sign_pk, r.target.hosted.kem_pk, r.target.hosted.noise_pk].every(k => typeof k === "string" && CPP_HEX32.test(k) && k !== "0".repeat(64))
      || signal.aborted) throw new ControlError("invalid", "migration_claim_data_invalid");
    // Construct only the bounded known fields; nested response metadata never
    // grants a reusable permission and cannot smuggle a custody envelope.
    return { schema: "mdbase-migration-claim/1", collection_id: collection, owner_account: r.owner_account,
      started_us: r.started_us, target: { runtime: "shadow", root_key_id: r.target.root_key_id,
        hosted: { device_id: body.device_id, sign_pk: r.target.hosted.sign_pk as string,
          kem_pk: r.target.hosted.kem_pk as string, noise_pk: r.target.hosted.noise_pk as string } } };
  }

  private requireCppSubject(collection: string, device: string): void {
    if (this.kind !== "hosted" || !this.#cppOrigin || !cppUuid(collection) || !cppUuid(device)
      || !/^[a-z0-9.-]+$/.test(new URL(this.#cppOrigin).hostname)) throw new ControlError("invalid", "migration_claim_subject_invalid");
  }

  /** Fresh point check only: no cached response or returned reusable permit.
   * Caller repeats before keys/custody/serving/final effects; phase is independent. */
  async assertPitrCurrent(identity: PitrIdentity, signal: AbortSignal): Promise<void> {
    if (!this.pitr || !identityValid(identity)
        || (identity.collection !== this.pitr.binding.active && identity.collection !== this.pitr.binding.deleted)) {
      throw new ControlError("invalid", "pitr_current_identity");
    }
    const snapshot = { ...identity };
    const body = { run: PITR_RUN, ...snapshot };
    const r = await this.call("/internal/v1/next/lab-pitr/current", { method: "POST", body }, MAX_CURRENT_BYTES, signal, true) as Record<string, unknown>;
    const now = this.now();
    if (!identityValid(identity) || !r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 9
        || r.run !== PITR_RUN || r.current !== true || typeof r.checkedAt !== "number" || !Number.isSafeInteger(r.checkedAt)
        || !Number.isSafeInteger(now) || r.checkedAt < 0 || r.checkedAt > now || now - r.checkedAt >= CURRENT_TIMEOUT_MS
        || !IDENTITY_KEYS.every(k => Object.hasOwn(r,k) && r[k] === snapshot[k] && identity[k] === snapshot[k])
        || signal.aborted) throw new ControlError("unavailable", "pitr_current_not_established");
  }

  /** Separate uncached app-grant observation. Never coerce this principal to a
   * device probe or return a reusable serving permit. Same bounded current I/O. */
  async assertPitrCurrentAppGrant(identity: PitrAppGrantIdentity, signal: AbortSignal): Promise<void> {
    if (!this.pitr || !grantIdentityValid(identity)
        || (identity.collection !== this.pitr.binding.active && identity.collection !== this.pitr.binding.deleted)) {
      throw new ControlError("invalid", "pitr_current_identity");
    }
    const snapshot = { ...identity };
    const body = { run: PITR_RUN, ...snapshot };
    const r = await this.call("/internal/v1/next/lab-pitr/current-app-grant", { method: "POST", body }, MAX_CURRENT_BYTES, signal, true) as Record<string, unknown>;
    const now = this.now();
    if (!grantIdentityValid(identity) || !r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 9
        || r.run !== PITR_RUN || r.current !== true || typeof r.checkedAt !== "number" || !Number.isSafeInteger(r.checkedAt)
        || !Number.isSafeInteger(now) || r.checkedAt < 0 || r.checkedAt > now || now - r.checkedAt >= CURRENT_TIMEOUT_MS
        || !GRANT_KEYS.every(k => Object.hasOwn(r,k) && r[k] === snapshot[k] && identity[k] === snapshot[k])
        || signal.aborted) throw new ControlError("unavailable", "pitr_current_not_established");
  }

  /** Original CP-only pending-genesis point. Never relabel device/app callers,
   * create a permit, or use this observation as nil/serving authority. */
  async assertPitrCurrentCpGenesis(identity: PitrCpGenesisIdentity, signal: AbortSignal): Promise<void> {
    if (!this.pitr || !cpGenesisIdentityValid(identity)
        || (identity.collection !== this.pitr.binding.active && identity.collection !== this.pitr.binding.deleted)) {
      throw new ControlError("invalid", "pitr_current_identity");
    }
    const snapshot = { ...identity };
    const body = { run: PITR_RUN, ...snapshot };
    const r = await this.call("/internal/v1/next/lab-pitr/current-cp-genesis", { method: "POST", body }, MAX_CURRENT_BYTES, signal, true) as Record<string, unknown>;
    const now = this.now();
    if (!cpGenesisIdentityValid(identity) || !r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 10
        || r.run !== PITR_RUN || r.current !== true || typeof r.checkedAt !== "number" || !Number.isSafeInteger(r.checkedAt)
        || !Number.isSafeInteger(now) || r.checkedAt < 0 || r.checkedAt > now || now - r.checkedAt >= CURRENT_TIMEOUT_MS
        || !CP_GENESIS_KEYS.every(k => Object.hasOwn(r,k) && r[k] === snapshot[k] && identity[k] === snapshot[k])
        || signal.aborted) throw new ControlError("unavailable", "pitr_current_not_established");
  }

  /** All new CP purpose points remain void/uncached metadata, not effect leases. */
  private async assertPitrCurrentCpPoint(identity:CpPointIdentity,purpose:CpPointIdentity["purpose"],signal:AbortSignal):Promise<void>{
    if(!this.pitr||!cpPointIdentityValid(identity)||identity.purpose!==purpose
      ||(identity.purpose==="collection"&&identity.collection!==this.pitr.binding.active&&identity.collection!==this.pitr.binding.deleted)
      ||((identity.purpose==="deletion-record"||identity.purpose==="deletion-peek")&&identity.subject!==this.pitr.binding.active&&identity.subject!==this.pitr.binding.deleted))
      throw new ControlError("invalid","pitr_current_identity");
    const snapshot={...identity};
    const path=purpose==="collection"?"current-cp-collection":purpose==="deletion-peek"?"current-cp-nil-peek":purpose==="registry-read"?"current-cp-nil-read":"current-cp-nil-record";
    const r=await this.call(`/internal/v1/next/lab-pitr/${path}`,{method:"POST",body:{run:PITR_RUN,...snapshot}},MAX_CURRENT_BYTES,signal,true) as Record<string,unknown>;
    const now=this.now();
    if(!cpPointIdentityValid(identity)||!r||typeof r!=="object"||Array.isArray(r)||Object.keys(r).length!==Object.keys(snapshot).length+3
      ||r.run!==PITR_RUN||r.current!==true||typeof r.checkedAt!=="number"||!Number.isSafeInteger(r.checkedAt)||!Number.isSafeInteger(now)
      ||r.checkedAt<0||r.checkedAt>now||now-r.checkedAt>=CURRENT_TIMEOUT_MS||signal.aborted
      ||!Object.entries(snapshot).every(([k,v])=>Object.hasOwn(r,k)&&r[k]===v&&Reflect.get(identity,k)===v))
      throw new ControlError("unavailable","pitr_current_not_established");
  }
  async assertPitrCurrentCpCollection(identity:PitrCpCollectionIdentity,signal:AbortSignal):Promise<void>{
    await this.assertPitrCurrentCpPoint(identity,"collection",signal);
  }
  async assertPitrCurrentCpNilPeek(identity:PitrCpNilPeekIdentity,signal:AbortSignal):Promise<void>{
    await this.assertPitrCurrentCpPoint(identity,"deletion-peek",signal);
  }
  async assertPitrCurrentCpNilRead(identity:PitrCpNilReadIdentity,signal:AbortSignal):Promise<void>{
    await this.assertPitrCurrentCpPoint(identity,"registry-read",signal);
  }
  async assertPitrCurrentCpNilRecord(identity:PitrCpNilRecordIdentity,signal:AbortSignal):Promise<void>{
    await this.assertPitrCurrentCpPoint(identity,"deletion-record",signal);
  }

  /** This collection's service-device record of this deployment's kind. */
  async serviceDevice(collection: string, signal: AbortSignal): Promise<ServiceDeviceRecord> {
    if (!UUID.test(collection)) throw new ControlError("invalid", "collection");
    const r = (await this.call(`/internal/v1/next/collections/${collection}/service-devices/${this.kind}`, { method: "GET" }, MAX_RECORD_BYTES, signal)) as Record<string, unknown>;
    const ok = r && typeof r === "object" && Object.keys(r).length === 8
      && r.kind === this.kind && typeof r.device_id === "string" && UUID.test(r.device_id)
      && [r.sign_pk, r.kem_pk, r.noise_pk].every((k) => typeof k === "string" && KEY.test(k))
      && typeof r.wrapped_keys === "string" && typeof r.kms_key_arn === "string" && /^arn:[!-~]{1,2044}$/.test(r.kms_key_arn);
    const wrapped = ok ? fromBase64(r.wrapped_keys as string) : null;
    const g = ok ? r.genesis as Record<string, unknown> | undefined : undefined;
    const genesisOk = g && typeof g === "object" && !Array.isArray(g) && Object.keys(g).length === 3
      && g.seq === 1 && typeof g.item === "string" && g.item.length <= 4 * Math.ceil((64 << 10) / 3)
      && typeof g.hash === "string" && KEY.test(g.hash);
    const original = genesisOk ? fromBase64(g.item as string) : null;
    if (!ok || !wrapped || wrapped.length === 0 || wrapped.length > MAX_WRAPPED_BYTES
        || !genesisOk || !original || !original.length || original.length > 64 << 10) {
      throw new ControlError("invalid", "malformed service device record");
    }
    return {
      kind: this.kind,
      deviceId: r.device_id as string,
      signPk: fromHex(r.sign_pk as string),
      kemPk: fromHex(r.kem_pk as string),
      noisePk: fromHex(r.noise_pk as string),
      wrappedKeys: wrapped,
      kmsKeyArn: r.kms_key_arn as string,
      genesis: { seq: 1, item: original, hash: fromHex(g.hash as string) },
    };
  }

  /** A role-0 log token for `device` in `collection`, from cache while it has a minute left. */
  async logToken(device: string, collection: string, signal: AbortSignal): Promise<LogToken> {
    if (!UUID.test(device) || !UUID.test(collection)) throw new ControlError("invalid", "device or collection");
    const key = `${device}/${collection}`;
    const now = this.now();
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached;
    this.tokens.delete(key);
    const r = (await this.call(`/internal/v1/next/service-devices/${device}/log-token`, { method: "POST", body: { collection } }, MAX_TOKEN_BYTES, signal)) as Record<string, unknown>;
    const ok = r && typeof r === "object" && typeof r.token === "string" && /^[0-9a-f]+\.[0-9a-f]{128}$/.test(r.token)
      && typeof r.expires_at === "number" && Number.isSafeInteger(r.expires_at)
      && r.expires_at > now + REFRESH_MARGIN_MS && r.expires_at <= now + TOKEN_LIFETIME_MS + REFRESH_MARGIN_MS;
    if (!ok) throw new ControlError("invalid", "malformed log token");
    const token = { token: r.token as string, expiresAt: r.expires_at as number };
    this.tokens.set(key, token);
    return token;
  }

  /** Forget cached tokens (on revocation, a collection leaving sync, or a refused token). */
  forget(collection?: string): void {
    if (!collection) return this.tokens.clear();
    for (const key of [...this.tokens.keys()]) if (key.endsWith(`/${collection}`)) this.tokens.delete(key);
  }
}

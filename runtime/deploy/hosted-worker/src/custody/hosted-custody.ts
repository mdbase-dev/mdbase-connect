/** Hosted-only, one-collection custody. No collection epoch export or Ready setter.
 * Control's record is untrusted identity data, not enrollment/admission proof.
 * Inject the core's ControlClient and Rust/WASM devicePublicKeys derivation.
 */
import { configuredEnvelope } from "./envelope.ts";
import { localKeyReference } from "./local-kms.ts";
import { LogTokenCache } from "./log-token-cache.ts";
import type { OriginalGenesis } from "../control.ts";

export type VerifyOriginalGenesis = (collection: string, pins: Uint8Array, original: Uint8Array, hash: Uint8Array) => boolean;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const TOKEN_MARGIN = 60_000;
const TOKEN_LIFETIME = 15 * 60_000;
const MAX_TOKEN_CHARS = 8192;
/** Calls that may wait behind the in-flight one; beyond this the custody refuses. */
const MAX_WAITING = 16;

/** The control plane's own verdicts that the collection has no current service
 * device: 404 (record deleted) and 409 (not a current cloud copy). Duck-typed on
 * `ControlError.code` so custody ports need no value import of the client. */
export function isControlGone(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "not_found" || code === "not_standard";
}

/** The CP says this deployment does not serve the collection (403): routed to
 * another deployment. Asking again on a timer cannot change that; a CP
 * activation of this deployment can. */
export function isControlNotOwned(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "wrong_scope";
}

export interface DevicePublicKeys {
  signPk: Uint8Array;
  kemPk: Uint8Array;
  noisePk: Uint8Array;
}
export interface HostedDeviceRecord extends DevicePublicKeys {
  kind: "hosted";
  deviceId: string;
  wrappedKeys: Uint8Array;
  kmsKeyArn: string;
  genesis: OriginalGenesis;
}
export interface HostedControlPort {
  serviceDevice(collection: string, signal: AbortSignal): Promise<HostedDeviceRecord>;
  logToken(device: string, collection: string, signal: AbortSignal): Promise<{ token: string; expiresAt: number }>;
  forget(collection: string): void;
}
export interface DeviceSecretUnwrapper {
  unwrapDeviceKeys(collection: string, device: string, envelope: Uint8Array, reportedArn: string, signal: AbortSignal): Promise<Uint8Array>;
}
export interface HostedCustodyConfig {
  collection: string;
  replicaId: string;
  keyArn: string;
  /** Independently verified/pinned configuration, NEVER roots from the CP response. */
  roots: readonly Uint8Array[];
  /** Normalized public pins from bundled shared signed environment asset ONLY. */
  policyPins: Uint8Array;
  /** Persisted deployment-local key trust only. A service device has no SAS
   * signers; [] is valid and never populated from a CP record. */
  signers: readonly string[];
  /** Opt-in from literal Worker LAB=1 only; RAM/private JSON diagnostics, not Error properties. */
  labRawErrors?: boolean;
}
export interface HostedOpenKeys {
  deviceId: string;
  replicaId: string;
  signSk: Uint8Array;
  kemSk: Uint8Array;
  /** Trusted Noise adapter handoff only; never serialize or put in attachments. */
  noiseSk: Uint8Array;
  publicKeys: DevicePublicKeys;
  roots: Uint8Array[];
  signers: string[];
  policyPins: Uint8Array;
  originalGenesis: Uint8Array;
  genesisSha256: Uint8Array;
  zeroize(): void;
}

type CustodyFailureCall = "control_service_device_first" | "control_service_device_recheck" | "kms_unwrap" | "control_log_token" | "record_validate" | "derive" | "other";
export interface LabCustodySubCause { call: CustodyFailureCall; name: string | null; message: string | null }
// Fresh collapsed Error keys isolate calls; no cause/custom Error property or persistence.
const labCauses = new WeakMap<object, LabCustodySubCause>();
export function labCustodySubCause(error: unknown): LabCustodySubCause | undefined {
  return error !== null && typeof error === "object" ? labCauses.get(error) : undefined;
}
function boundedErrorText(error: unknown, key: "name" | "message", limit: number): string | null {
  try {
    const value = key === "message" && typeof error === "string" ? error
      : error !== null && typeof error === "object" ? Reflect.get(error, key) : undefined;
    if (typeof value !== "string") return null;
    return new TextDecoder().decode(new TextEncoder().encode(value.slice(0, limit)).subarray(0, limit), { stream: true });
  } catch { return null; }
}
function fail(code: string, details?: { call: CustodyFailureCall; error: unknown }): never {
  const failure = new Error(code);
  if (details) labCauses.set(failure, Object.freeze({ call: details.call,
    name: boundedErrorText(details.error, "name", 128), message: boundedErrorText(details.error, "message", 4096) }));
  throw failure;
}
function uuid(s: string): boolean { return UUID.test(s) && s !== NIL; }
/** Shared deployment-config shape gate; empty external signer trust is valid. */
export function validHostedSigners(signers: readonly string[]): boolean {
  return Array.isArray(signers) && signers.length <= 16 && signers.every(uuid);
}
function key(k: Uint8Array): boolean { return k instanceof Uint8Array && k.length === 32 && k.some(b => b !== 0); }
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function publicEqual(a: DevicePublicKeys, b: DevicePublicKeys): boolean {
  return same(a.signPk, b.signPk) && same(a.kemPk, b.kemPk) && same(a.noisePk, b.noisePk);
}
function publicCopy(p: DevicePublicKeys): DevicePublicKeys {
  return { signPk: p.signPk.slice(), kemPk: p.kemPk.slice(), noisePk: p.noisePk.slice() };
}

export class HostedCustody {
  private readonly config: HostedCustodyConfig;
  private readonly control: HostedControlPort;
  private readonly kms: DeviceSecretUnwrapper;
  private readonly derive: (secret: Uint8Array) => DevicePublicKeys | null;
  private readonly now: () => number;
  private readonly verifyOriginal: VerifyOriginalGenesis;
  /** Tail of the one-call-at-a-time chain; later calls wait for it, bounded. */
  private queue: Promise<void> = Promise.resolve();
  /** The in-flight call plus those waiting for it. */
  private queued = 0;
  private closed = false;
  private revision = 0;
  private lease: HostedOpenKeys | null = null;
  private readonly terminal = new AbortController();
  private pendingSecret: Uint8Array | null = null;
  /** Public immutable winner, not a permission snapshot. */
  private bound: HostedDeviceRecord | null = null;
  /** The last minted log token, tagged with the revision it was minted under. */
  private readonly tokens: LogTokenCache;

  constructor(config: HostedCustodyConfig, control: HostedControlPort, kms: DeviceSecretUnwrapper,
    derive: (secret: Uint8Array) => DevicePublicKeys | null, verifyOriginal: VerifyOriginalGenesis, now: () => number = Date.now) {
    if (!uuid(config.collection) || !uuid(config.replicaId) ||
        (!/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]+$/.test(config.keyArn) && !localKeyReference(config.keyArn)) || config.keyArn.length > 2048 ||
        config.roots.length < 1 || config.roots.length > 64 || !config.roots.every(key) ||
        !(config.policyPins instanceof Uint8Array) || !config.policyPins.length || config.policyPins.length > (64 << 10) ||
        typeof verifyOriginal !== "function" ||
        !validHostedSigners(config.signers)) fail("custody_invalid_config");
    this.config = { ...config, roots: config.roots.map(k => new Uint8Array(k)), policyPins: new Uint8Array(config.policyPins), signers: [...config.signers] };
    this.control = control;
    this.kms = kms;
    this.derive = derive;
    this.verifyOriginal = verifyOriginal;
    this.now = now;
    this.tokens = new LogTokenCache(now);
  }

  /** One scoped call at a time per instance. A later call waits for the earlier
   * one (bounded by its own signal and MAX_WAITING) instead of being refused: a
   * refusal cost the caller retry backoff on every overlapping log-token fetch.
   * Returns the revision and the release that hands the custody to the next call. */
  private async enter(collection: string, signal: AbortSignal): Promise<{ revision: number; release: () => void }> {
    if (this.closed || collection !== this.config.collection || this.queued > MAX_WAITING) fail("custody_unavailable");
    if (signal.aborted) fail("custody_aborted");
    const prior = this.queue;
    let handOn!: () => void;
    const mine = new Promise<void>(resolve => { handOn = resolve; });
    this.queue = prior.then(() => mine);
    this.queued++;
    let released = false;
    const release = () => { if (!released) { released = true; this.queued--; handOn(); } };
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("custody_aborted"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        prior.then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
    } catch {
      // Leaving the chain: callers behind still wait for `prior` via `mine`.
      release();
      fail("custody_aborted");
    }
    if (this.closed || signal.aborted) { release(); fail("custody_aborted"); }
    return { revision: this.revision, release };
  }
  private current(revision: number, signal: AbortSignal): void {
    if (this.closed || revision !== this.revision || signal.aborted) fail("custody_aborted");
  }
  private record(r: HostedDeviceRecord): HostedDeviceRecord {
    if (!r || r.kind !== "hosted" || !uuid(r.deviceId) || !key(r.signPk) || !key(r.kemPk) || !key(r.noisePk) ||
        r.kmsKeyArn !== this.config.keyArn || !(r.wrappedKeys instanceof Uint8Array)) fail("custody_invalid_record");
    // MDBK exact lengths/ref authority before any asynchronous unwrap.
    configuredEnvelope(r.wrappedKeys, [this.config.keyArn]);
    const g = r.genesis;
    if (!g || g.seq !== 1 || !(g.item instanceof Uint8Array) || !g.item.length || g.item.length > (64 << 10)
        || !(g.hash instanceof Uint8Array) || g.hash.length !== 32) fail("custody_invalid_record");
    const copy = { ...r, ...publicCopy(r), wrappedKeys: new Uint8Array(r.wrappedKeys),
      genesis: { seq: 1 as const, item: new Uint8Array(g.item), hash: new Uint8Array(g.hash) } };
    // PUBLIC trust check before EVERY unwrap/token/secret-use path, including
    // rereads. Authenticated CP eligibility is independent current permission.
    if (!this.verifyOriginal(this.config.collection, this.config.policyPins, copy.genesis.item, copy.genesis.hash)) fail("custody_invalid_record");
    return copy;
  }
  private unchanged(a: HostedDeviceRecord, b: HostedDeviceRecord): void {
    if (a.deviceId !== b.deviceId || a.kmsKeyArn !== b.kmsKeyArn || !publicEqual(a, b) ||
        !same(a.wrappedKeys, b.wrappedKeys) || !same(a.genesis.item, b.genesis.item)
        || !same(a.genesis.hash, b.genesis.hash)) fail("custody_record_changed");
  }
  private forget(): void { try { this.control.forget(this.config.collection); } catch { /* Never expose port errors. */ } }

  /** Open before final Ready, but only configured hosted identity; engine stays app-Deny
   * until authenticated enrollment/key handling and its live observer qualify it.
   * At most one outstanding key lease and one in-flight port call per instance.
   */
  async openSealer(collection: string, parentSignal: AbortSignal): Promise<HostedOpenKeys> {
    if (this.lease) fail("custody_unavailable");
    const signal = AbortSignal.any([parentSignal, this.terminal.signal]);
    const { revision, release } = await this.enter(collection, signal);
    // The lease may have been handed out while this call waited.
    if (this.lease) { release(); fail("custody_unavailable"); }
    let secret: Uint8Array | undefined;
    let lease: HostedOpenKeys | undefined;
    let call: CustodyFailureCall = "other";
    try {
      call = "control_service_device_first";
      const firstRecord = await this.control.serviceDevice(collection, signal);
      call = "record_validate";
      const first = this.record(firstRecord);
      this.current(revision, signal);
      if (this.bound) this.unchanged(this.bound, first);
      call = "kms_unwrap";
      secret = await this.kms.unwrapDeviceKeys(collection, first.deviceId, first.wrappedKeys, first.kmsKeyArn, signal);
      call = "record_validate";
      if (!(secret instanceof Uint8Array) || secret.length !== 96) fail("custody_secret_invalid");
      this.pendingSecret = secret;
      this.current(revision, signal);
      call = "derive";
      const publicKeys = this.derive(secret);
      if (!publicKeys || !key(publicKeys.signPk) || !key(publicKeys.kemPk) || !key(publicKeys.noisePk) ||
          !publicEqual(publicKeys, first)) fail("custody_identity_mismatch");
      // Re-read eligibility and the immutable winner after KMS I/O; no identity swap.
      call = "control_service_device_recheck";
      const lastRecord = await this.control.serviceDevice(collection, signal);
      call = "record_validate";
      const last = this.record(lastRecord);
      this.current(revision, signal);
      this.unchanged(first, last);
      lease = {
        deviceId: first.deviceId, replicaId: this.config.replicaId,
        signSk: secret.slice(0, 32), kemSk: secret.slice(32, 64), noiseSk: secret.slice(64, 96),
        publicKeys: publicCopy(publicKeys), roots: this.config.roots.map(k => k.slice()), signers: [...this.config.signers],
        policyPins: new Uint8Array(this.config.policyPins), originalGenesis: new Uint8Array(first.genesis.item), genesisSha256: new Uint8Array(first.genesis.hash),
        zeroize: () => {
          lease!.signSk.fill(0); lease!.kemSk.fill(0); lease!.noiseSk.fill(0);
          if (this.lease === lease) this.lease = null;
        },
      };
      this.bound = first;
      this.lease = lease;
      return lease;
    } catch (error) {
      lease?.zeroize();
      this.tokens.drop();
      this.forget();
      if (error instanceof Error && ["custody_identity_mismatch", "custody_record_changed", "custody_secret_invalid", "custody_invalid_record"].includes(error.message)) throw error;
      // A verdict, not an outage: this deployment's KMS does not serve the collection.
      if (error instanceof Error && error.message === "kms_collection_not_allowed") fail("custody_collection_not_allowed");
      // A verdict too: the CP holds no current service device (deleted / left sync).
      if (isControlGone(error) && !signal.aborted && !this.closed && revision === this.revision) fail("custody_collection_gone");
      if (isControlNotOwned(error) && !signal.aborted && !this.closed && revision === this.revision) fail("custody_collection_not_allowed");
      return fail(signal.aborted || this.closed || revision !== this.revision ? "custody_aborted" : "custody_unavailable",
        this.config.labRawErrors === true ? { call, error } : undefined);
    } finally {
      if (secret instanceof Uint8Array) secret.fill(0);
      this.pendingSecret = null;
      release();
    }
  }

  /** The minted token is held (`LogTokenCache`) and reused while it has more than
   * a minute left, with no CP call: no record reads on a hit. A miss reads the
   * record, mints, and rechecks the record as before. The CP stays issuer and
   * eligibility source: a hit skips its eligibility read for at most the token's
   * lifetime (<= 16 min), and the held token is dropped on any CP refusal or
   * verdict, `close()`, a revision change and `invalidateLogToken()` (engine
   * reset, CP activation, log-service 401/403). The ControlClient's own cache is
   * still forgotten after each mint, so a miss always reaches the CP.
   */
  async logToken(collection: string, parentSignal: AbortSignal): Promise<string> {
    const signal = AbortSignal.any([parentSignal, this.terminal.signal]);
    const held = this.heldToken(collection, signal);
    if (held) return held;
    const { revision, release } = await this.enter(collection, signal);
    // The call ahead of this one may have just minted a token.
    const minted = this.heldToken(collection, signal);
    if (minted) { release(); return minted; }
    const started = this.now();
    let call: CustodyFailureCall = "other";
    try {
      call = "control_service_device_first";
      const firstRecord = await this.control.serviceDevice(collection, signal);
      call = "record_validate";
      const first = this.record(firstRecord);
      this.current(revision, signal);
      if (this.bound) this.unchanged(this.bound, first);
      call = "control_log_token";
      const result = await this.control.logToken(first.deviceId, collection, signal);
      call = "record_validate";
      this.current(revision, signal);
      const now = this.now();
      if (!Number.isSafeInteger(now) || !result || typeof result.token !== "string" || result.token.length > MAX_TOKEN_CHARS ||
          !/^[0-9a-f]+\.[0-9a-f]{128}$/.test(result.token) || !Number.isSafeInteger(result.expiresAt) ||
          result.expiresAt <= now + TOKEN_MARGIN || result.expiresAt > now + TOKEN_LIFETIME + TOKEN_MARGIN) fail("custody_token_invalid");
      call = "control_service_device_recheck";
      const lastRecord = await this.control.serviceDevice(collection, signal);
      call = "record_validate";
      const last = this.record(lastRecord);
      this.current(revision, signal);
      this.unchanged(first, last);
      const completed = this.now();
      if (!Number.isSafeInteger(completed) || result.expiresAt <= completed + TOKEN_MARGIN) fail("custody_token_invalid");
      this.tokens.put(result.token, result.expiresAt, started, revision);
      return result.token;
    } catch (error) {
      this.tokens.drop();
      if (isControlGone(error) && !signal.aborted && !this.closed && revision === this.revision) fail("custody_collection_gone");
      if (isControlNotOwned(error) && !signal.aborted && !this.closed && revision === this.revision) fail("custody_collection_not_allowed");
      return fail(signal.aborted || this.closed || revision !== this.revision ? "custody_aborted" : "custody_unavailable",
        this.config.labRawErrors === true ? { call, error } : undefined);
    } finally { this.forget(); release(); }
  }

  private heldToken(collection: string, signal: AbortSignal): string | null {
    if (this.closed || collection !== this.config.collection || signal.aborted) return null;
    return this.tokens.get(this.revision);
  }

  /** Drop the held log token: the next `logToken` reads the record and mints. */
  invalidateLogToken(): void { this.tokens.drop(); }

  /** Invalidate all pending handoffs on wake replacement/revocation/terminal close. */
  close(): void {
    this.closed = true; this.revision++; this.terminal.abort(); this.tokens.drop();
    this.pendingSecret?.fill(0); this.lease?.zeroize(); this.forget();
  }
}

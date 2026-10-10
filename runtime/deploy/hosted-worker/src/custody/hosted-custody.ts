/** Hosted-only, one-collection custody. No collection epoch export or Ready setter.
 * Control's record is untrusted identity data, not enrollment/admission proof.
 * Inject the core's ControlClient and Rust/WASM devicePublicKeys derivation.
 */
import { configuredEnvelope } from "./envelope.ts";
import type { OriginalGenesis } from "../control.ts";

export type VerifyOriginalGenesis = (collection: string, pins: Uint8Array, original: Uint8Array, hash: Uint8Array) => boolean;

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const TOKEN_MARGIN = 60_000;
const TOKEN_LIFETIME = 15 * 60_000;
const MAX_TOKEN_CHARS = 8192;

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
  signers: readonly string[];
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

function fail(code: string): never { throw new Error(code); }
function uuid(s: string): boolean { return UUID.test(s) && s !== NIL; }
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
  private active = false;
  private closed = false;
  private revision = 0;
  private lease: HostedOpenKeys | null = null;
  private readonly terminal = new AbortController();
  private pendingSecret: Uint8Array | null = null;
  /** Public immutable winner, not a permission snapshot. */
  private bound: HostedDeviceRecord | null = null;

  constructor(config: HostedCustodyConfig, control: HostedControlPort, kms: DeviceSecretUnwrapper,
    derive: (secret: Uint8Array) => DevicePublicKeys | null, verifyOriginal: VerifyOriginalGenesis, now: () => number = Date.now) {
    if (!uuid(config.collection) || !uuid(config.replicaId) ||
        !/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]+$/.test(config.keyArn) || config.keyArn.length > 2048 ||
        config.roots.length < 1 || config.roots.length > 64 || !config.roots.every(key) ||
        !(config.policyPins instanceof Uint8Array) || !config.policyPins.length || config.policyPins.length > (64 << 10) ||
        typeof verifyOriginal !== "function" ||
        config.signers.length < 1 || config.signers.length > 16 || !config.signers.every(uuid)) fail("custody_invalid_config");
    this.config = { ...config, roots: config.roots.map(k => new Uint8Array(k)), policyPins: new Uint8Array(config.policyPins), signers: [...config.signers] };
    this.control = control;
    this.kms = kms;
    this.derive = derive;
    this.verifyOriginal = verifyOriginal;
    this.now = now;
  }

  private enter(collection: string, signal: AbortSignal): number {
    if (this.closed || collection !== this.config.collection || this.active) fail("custody_unavailable");
    if (signal.aborted) fail("custody_aborted");
    this.active = true;
    return this.revision;
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
    const revision = this.enter(collection, signal);
    let secret: Uint8Array | undefined;
    let lease: HostedOpenKeys | undefined;
    try {
      const first = this.record(await this.control.serviceDevice(collection, signal));
      this.current(revision, signal);
      if (this.bound) this.unchanged(this.bound, first);
      secret = await this.kms.unwrapDeviceKeys(collection, first.deviceId, first.wrappedKeys, first.kmsKeyArn, signal);
      if (!(secret instanceof Uint8Array) || secret.length !== 96) fail("custody_secret_invalid");
      this.pendingSecret = secret;
      this.current(revision, signal);
      const publicKeys = this.derive(secret);
      if (!publicKeys || !key(publicKeys.signPk) || !key(publicKeys.kemPk) || !key(publicKeys.noisePk) ||
          !publicEqual(publicKeys, first)) fail("custody_identity_mismatch");
      // Re-read eligibility and the immutable winner after KMS I/O; no identity swap.
      const last = this.record(await this.control.serviceDevice(collection, signal));
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
      this.forget();
      if (error instanceof Error && ["custody_identity_mismatch", "custody_record_changed", "custody_secret_invalid", "custody_invalid_record"].includes(error.message)) throw error;
      return fail(signal.aborted || this.closed || revision !== this.revision ? "custody_aborted" : "custody_unavailable");
    } finally {
      if (secret instanceof Uint8Array) secret.fill(0);
      this.pendingSecret = null;
      this.active = false;
    }
  }

  /** No adapter token cache. Forget the ControlClient cache after each call, keeping
   * this one-collection port bounded; CP remains issuer/current eligibility source.
   */
  async logToken(collection: string, parentSignal: AbortSignal): Promise<string> {
    const signal = AbortSignal.any([parentSignal, this.terminal.signal]);
    const revision = this.enter(collection, signal);
    try {
      const first = this.record(await this.control.serviceDevice(collection, signal));
      this.current(revision, signal);
      if (this.bound) this.unchanged(this.bound, first);
      const result = await this.control.logToken(first.deviceId, collection, signal);
      this.current(revision, signal);
      const now = this.now();
      if (!Number.isSafeInteger(now) || !result || typeof result.token !== "string" || result.token.length > MAX_TOKEN_CHARS ||
          !/^[0-9a-f]+\.[0-9a-f]{128}$/.test(result.token) || !Number.isSafeInteger(result.expiresAt) ||
          result.expiresAt <= now + TOKEN_MARGIN || result.expiresAt > now + TOKEN_LIFETIME + TOKEN_MARGIN) fail("custody_token_invalid");
      const last = this.record(await this.control.serviceDevice(collection, signal));
      this.current(revision, signal);
      this.unchanged(first, last);
      const completed = this.now();
      if (!Number.isSafeInteger(completed) || result.expiresAt <= completed + TOKEN_MARGIN) fail("custody_token_invalid");
      return result.token;
    } catch {
      return fail(signal.aborted || this.closed || revision !== this.revision ? "custody_aborted" : "custody_unavailable");
    } finally { this.forget(); this.active = false; }
  }

  /** Invalidate all pending handoffs on wake replacement/revocation/terminal close. */
  close(): void {
    this.closed = true; this.revision++; this.terminal.abort();
    this.pendingSecret?.fill(0); this.lease?.zeroize(); this.forget();
  }
}

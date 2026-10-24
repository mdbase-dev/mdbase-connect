/** Consumes ONLY a trusted live Rust/WASM observer bridge. These structural types
 * are not wire inputs, constructors for cryptographic proof, or cached permits.
 * The core must call recheck synchronously immediately before effects/emission,
 * after every await. An awaited check() alone cannot make that boundary atomic.
 */
export type AdmissionOp = "hello" | "call" | "output" | "ack" | "wake";
export interface AdmissionContext {
  collection: string;
  op: AdmissionOp;
  grant?: string;
  /** Authenticated Noise static identity, not a public key from request JSON. */
  clientPk?: Uint8Array;
}
export interface PublicIdentity { signPk: Uint8Array; kemPk: Uint8Array; noisePk: Uint8Array }
export interface LiveHostedEvidence extends PublicIdentity {
  kind: "verified";
  collection: string;
  device: string;
  wake: bigint;
  generation: bigint;
  epoch: bigint;
  applied: {seq: bigint; chain: Uint8Array};
  authenticated: {seq: bigint; chain: Uint8Array};
  rootId: string;
  rootPk: Uint8Array;
  controlChain: Uint8Array;
  keyDeliveryDevice: string;
  keyDeliverySeq: bigint;
}
export interface LiveAdmissionSource {
  /** Pure readonly getter: ONLY verified_hosted_admission, never bootstrap
   * Eligible/raw policy/status. Must not pump or change state. */
  observe(): LiveHostedEvidence | null;
  /** Pure readonly current host wake, independently scoped to this instance. */
  wake(): bigint;
  /** Checks actual separately held/derived host Noise custody against this tuple. */
  noiseMatches(publicKey: Uint8Array): boolean;
  /** Live verified per-app authorization/bound Noise identity. Core's method/path/
   * record-specific authorization is still required for each actual operation. */
  authorizeApp(ctx: AdmissionContext): boolean;
}
export interface LiveAdmissionConfig extends PublicIdentity {
  collection: string;
  device: string;
  /** Independently verified trust configuration, not observer-selected roots. */
  roots: readonly {id: string; pk: Uint8Array}[];
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const U64 = (1n << 64n) - 1n;
const OPS: readonly string[] = ["hello", "call", "output", "ack", "wake"];
const uuid = (s: string) => UUID.test(s) && s !== NIL;
const key = (b: Uint8Array) => b instanceof Uint8Array && b.length === 32 && b.some(x => x !== 0);
const u64 = (n: bigint) => typeof n === "bigint" && n >= 0n && n <= U64;
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export const DENY_LIVE_SOURCE: LiveAdmissionSource = {
  observe: () => null, wake: () => 0n, noiseMatches: () => false, authorizeApp: () => false,
};

export class LiveAdmission {
  private readonly config: LiveAdmissionConfig;
  private readonly source: LiveAdmissionSource;
  constructor(config: LiveAdmissionConfig, source: LiveAdmissionSource = DENY_LIVE_SOURCE) {
    if (!uuid(config.collection) || !uuid(config.device) || !key(config.signPk) || !key(config.kemPk) || !key(config.noisePk) ||
        config.roots.length < 1 || config.roots.length > 8 || !config.roots.every(r => uuid(r.id) && key(r.pk))) throw new Error("admission_invalid_config");
    this.config = {...config, signPk: config.signPk.slice(), kemPk: config.kemPk.slice(), noisePk: config.noisePk.slice(),
      roots: config.roots.map(r => ({id: r.id, pk: r.pk.slice()}))};
    this.source = source;
  }
  private valid(e: LiveHostedEvidence | null): e is LiveHostedEvidence {
    const c = this.config;
    return !!e && e.kind === "verified" && e.collection === c.collection && e.device === c.device &&
      equal(e.signPk, c.signPk) && equal(e.kemPk, c.kemPk) && equal(e.noisePk, c.noisePk) &&
      u64(e.wake) && e.wake > 0n && u64(e.generation) &&
      u64(e.epoch) && e.epoch > 0n && u64(e.applied.seq) && u64(e.authenticated.seq) &&
      e.applied.seq >= e.authenticated.seq && key(e.applied.chain) && key(e.authenticated.chain) &&
      (e.applied.seq !== e.authenticated.seq || equal(e.applied.chain, e.authenticated.chain)) &&
      key(e.controlChain) && c.roots.some(r => r.id === e.rootId && equal(r.pk, e.rootPk)) &&
      uuid(e.keyDeliveryDevice) && u64(e.keyDeliverySeq) && e.keyDeliverySeq > 0n && e.keyDeliverySeq <= e.applied.seq;
  }
  private same(a: LiveHostedEvidence, b: LiveHostedEvidence): boolean {
    return a.wake === b.wake && a.generation === b.generation && a.epoch === b.epoch &&
      a.applied.seq === b.applied.seq && equal(a.applied.chain, b.applied.chain) &&
      a.authenticated.seq === b.authenticated.seq && equal(a.authenticated.chain, b.authenticated.chain) &&
      a.rootId === b.rootId && equal(a.rootPk, b.rootPk) && equal(a.controlChain, b.controlChain) &&
      a.keyDeliveryDevice === b.keyDeliveryDevice && a.keyDeliverySeq === b.keyDeliverySeq;
  }
  /** Final synchronous check. No stored allow/snapshot; caller emits without await. */
  recheck(ctx: AdmissionContext): "allow" | "deny" {
    try {
      if (ctx.collection !== this.config.collection || !OPS.includes(ctx.op)) return "deny";
      const observed = this.source.observe();
      if (!this.valid(observed)) return "deny";
      // Bounded per-call public context copy, not a cached allow. Do not alias a
      // bridge's mutable view across authorization callbacks.
      const first: LiveHostedEvidence = {...observed,
        signPk: observed.signPk.slice(), kemPk: observed.kemPk.slice(), noisePk: observed.noisePk.slice(),
        rootPk: observed.rootPk.slice(), controlChain: observed.controlChain.slice(),
        applied: {...observed.applied, chain: observed.applied.chain.slice()},
        authenticated: {...observed.authenticated, chain: observed.authenticated.chain.slice()}};
      if (first.wake !== this.source.wake() || !this.source.noiseMatches(first.noisePk)) return "deny";
      if (ctx.op !== "wake" && (!ctx.grant || !uuid(ctx.grant) || !key(ctx.clientPk!) || !this.source.authorizeApp(ctx))) return "deny";
      if (!this.source.noiseMatches(first.noisePk)) return "deny";
      // ALL authorization/Noise callbacks finish before final readonly sampling.
      // No callback can replace the wake after we sampled it for the verdict.
      const last = this.source.observe();
      const wake = this.source.wake();
      return this.valid(last) && last.wake === wake && this.same(first, last) ? "allow" : "deny";
    } catch { return "deny"; }
  }
  /** Structural compatibility with the old async Admission seam, NOT a permit. */
  async check(ctx: AdmissionContext): Promise<"allow" | "deny"> { return this.recheck(ctx); }
}

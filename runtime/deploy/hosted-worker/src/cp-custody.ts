/**
 * LAB custody over the control plane's service-device records, through the
 * core's ControlClient: the deployment reads its own kind's record for a
 * collection, opens the wrapped keys with the LAB custody stub, and mints its log
 * token through the control plane. Production hosted uses HostedCustody + KMS
 * (src/custody/) instead. The
 * control plane answers only for a current cloud copy, so a collection that leaves
 * sync stops opening. Public original genesis verifies against the bundled shared
 * signed-release pins BEFORE unwrap; roots are never learned from the reply.
 */
import type { Custody, OpenKeys } from "./seams.js";
import type { ServiceDeviceRecord } from "./control.ts";
import { isControlGone, type VerifyOriginalGenesis } from "./custody/hosted-custody.ts";
import { LogTokenCache } from "./custody/log-token-cache.ts";
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const unchanged = (a: ServiceDeviceRecord, b: ServiceDeviceRecord) =>
  a.kind === b.kind && a.deviceId === b.deviceId && a.kmsKeyArn === b.kmsKeyArn
  && same(a.signPk, b.signPk) && same(a.kemPk, b.kemPk) && same(a.noisePk, b.noisePk)
  && same(a.wrappedKeys, b.wrappedKeys) && same(a.genesis.item, b.genesis.item) && same(a.genesis.hash, b.genesis.hash);

/** CP 404/409: no current service device (deleted, left sync). A lasting verdict
 * the alarm loop must not retry on a timer; every other refusal passes as is. */
const verdict = (error: unknown): never => { throw isControlGone(error) ? new Error("custody_collection_gone") : error; };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** A verified record serves log-token requests this long before it is read
 * again. Every log round asks for a token: reading the record twice per round
 * from every collection's actor exhausted the control plane's rate limit (429),
 * which in turn held back activations and key grants. A collection that leaves
 * sync still stops opening within this window. */
const RECORD_TTL_MS = 60_000;
const RECORD_CACHE = 256;

export interface CpCustodyConfig {
  kind: "hosted" | "escrow";
  /** The control-plane client for this kind (no redirects, bounded, abortable). */
  control: {
    serviceDevice(collection: string, signal: AbortSignal): Promise<ServiceDeviceRecord>;
    /** `expiresAt` (ms) lets custody hold the token; without it every round mints. */
    logToken(device: string, collection: string, signal: AbortSignal): Promise<{ token: string; expiresAt?: number }>;
    /** Forget the client's own token cache for `collection`, when it has one. */
    forget?(collection: string): void;
  };
  /** Bundled shared signed release ONLY, never runtime/CP/log/SQL authority. */
  roots: readonly Uint8Array[];
  policyPins: Uint8Array;
  verifyOriginal: VerifyOriginalGenesis;
  /** Opens a record's envelope for exactly (kind, collection, device): LAB the
   * custody stub, production KMS. */
  unwrap: (
    kind: "hosted" | "escrow", collection: string, device: string, envelope: Uint8Array, signal: AbortSignal,
  ) => Promise<Uint8Array>;
  /** Public keys from the 96-byte secret (the engine's derivation), or null. */
  derive?: (secret: Uint8Array) => { signPk: Uint8Array; kemPk: Uint8Array; noisePk: Uint8Array } | null;
}

export function cpCustody(c: CpCustodyConfig): Custody {
  if (!(c.policyPins instanceof Uint8Array) || !c.policyPins.length || c.policyPins.length > (64 << 10)
      || c.roots.length < 1 || c.roots.length > 64 || c.roots.some(k => !(k instanceof Uint8Array) || k.length !== 32)
      || typeof c.verifyOriginal !== "function") throw new Error("custody_unavailable");
  c = { ...c, policyPins: new Uint8Array(c.policyPins), roots: c.roots.map(pk => new Uint8Array(pk)) };
  const record = async (collection: string, signal: AbortSignal) => {
    if (!UUID.test(collection)) throw new Error("custody_unavailable");
    const r = await c.control.serviceDevice(collection, signal).catch(verdict);
    if (r?.kind !== c.kind || !UUID.test(r.deviceId ?? "")
        || [r.signPk, r.kemPk, r.noisePk].some(k => !(k instanceof Uint8Array) || k.length !== 32 || !k.some(b => b !== 0))
        || !(r.wrappedKeys instanceof Uint8Array) || !r.wrappedKeys.length || r.wrappedKeys.length > (64 << 10)) throw new Error("custody_unavailable");
    if (!r.genesis || r.genesis.seq !== 1 || !(r.genesis.item instanceof Uint8Array)
        || !r.genesis.item.length || r.genesis.item.length > (64 << 10)
        || !(r.genesis.hash instanceof Uint8Array) || r.genesis.hash.length !== 32) throw new Error("custody_unavailable");
    const copy = { ...r, signPk: new Uint8Array(r.signPk), kemPk: new Uint8Array(r.kemPk), noisePk: new Uint8Array(r.noisePk),
      wrappedKeys: new Uint8Array(r.wrappedKeys), genesis: { seq: 1 as const, item: new Uint8Array(r.genesis.item), hash: new Uint8Array(r.genesis.hash) } };
    if (!c.verifyOriginal(collection, c.policyPins, copy.genesis.item, copy.genesis.hash)) throw new Error("custody_unavailable");
    return copy;
  };
  const verified = new Map<string, { record: Awaited<ReturnType<typeof record>>; at: number }>();
  const remember = (collection: string, r: Awaited<ReturnType<typeof record>>) => {
    verified.delete(collection);
    if (verified.size >= RECORD_CACHE) verified.delete(verified.keys().next().value!);
    verified.set(collection, { record: r, at: Date.now() });
  };
  const recent = (collection: string) => {
    const hit = verified.get(collection);
    if (!hit) return null;
    const age = Date.now() - hit.at;
    if (age >= 0 && age < RECORD_TTL_MS) return hit.record;
    verified.delete(collection);
    return null;
  };
  /** Held log tokens (see `LogTokenCache`), one per collection; a hit makes no CP call. */
  const tokens = new Map<string, LogTokenCache>();
  const dropToken = (collection: string) => {
    tokens.delete(collection);
    try { c.control.forget?.(collection); } catch { /* Never expose port errors. */ }
  };
  return {
    // The next token reads (and rechecks) the record too.
    invalidateLogToken: (collection) => { dropToken(collection); verified.delete(collection); },
    async openSealer(collection, signal): Promise<OpenKeys> {
      const r = await record(collection, signal);
      signal.throwIfAborted();
      const secret = await c.unwrap(c.kind, collection, r.deviceId, r.wrappedKeys, signal);
      try {
        // Aborted while unwrapping: the secret is wiped (finally), never handed out.
        signal.throwIfAborted();
        if (secret.length !== 96) throw new Error("custody_unavailable");
        const publicKeys = c.derive?.(secret) ?? undefined;
        if (!publicKeys || !same(publicKeys.signPk, r.signPk) || !same(publicKeys.kemPk, r.kemPk) || !same(publicKeys.noisePk, r.noisePk)) throw new Error("custody_unavailable");
        const last = await record(collection, signal);
        signal.throwIfAborted();
        if (!unchanged(r, last)) throw new Error("custody_unavailable");
        remember(collection, last);
        const keys: OpenKeys = {
          deviceId: r.deviceId,
          // One replica per service device and collection.
          replicaId: r.deviceId,
          signSk: secret.slice(0, 32),
          kemSk: secret.slice(32, 64),
          noiseSk: secret.slice(64, 96),
          ...(publicKeys ? { publicKeys } : {}),
          roots: c.roots.map(pk => new Uint8Array(pk)),
          signers: [],
          policyPins: new Uint8Array(c.policyPins), originalGenesis: new Uint8Array(r.genesis.item), genesisSha256: new Uint8Array(r.genesis.hash),
          zeroize() {
            keys.signSk.fill(0);
            keys.kemSk.fill(0);
            keys.noiseSk?.fill(0);
          },
        };
        return keys;
      } finally {
        secret.fill(0);
      }
    },
    async logToken(collection, signal): Promise<string> {
      signal.throwIfAborted();
      const held = tokens.get(collection)?.get(collection);
      if (held) return held;
      try {
        const started = Date.now();
        const cached = recent(collection);
        const r = cached ?? await record(collection, signal);
        signal.throwIfAborted();
        const t = await c.control.logToken(r.deviceId, collection, signal).catch(verdict);
        signal.throwIfAborted();
        if (!cached) {
          const last = await record(collection, signal);
          signal.throwIfAborted();
          if (!unchanged(r, last)) throw new Error("custody_unavailable");
          remember(collection, last);
        }
        if (typeof t?.token !== "string" || !t.token) throw new Error("custody_unavailable");
        if (typeof t.expiresAt === "number") {
          const cache = new LogTokenCache();
          cache.put(t.token, t.expiresAt, started, collection);
          tokens.delete(collection);
          if (tokens.size >= RECORD_CACHE) tokens.delete(tokens.keys().next().value!);
          tokens.set(collection, cache);
        }
        return t.token;
      } catch (error) {
        dropToken(collection);
        verified.delete(collection);
        throw error;
      }
    },
  };
}

/** Fixture custody for its listed collections, the control plane's records otherwise. */
export function combinedCustody(fixture: Custody, fixtureHas: (collection: string) => boolean, cp: Custody | null): Custody {
  return {
    openSealer: (collection, signal) => (fixtureHas(collection) || !cp ? fixture : cp).openSealer(collection, signal),
    logToken: (collection, signal) => (fixtureHas(collection) || !cp ? fixture : cp).logToken(collection, signal),
    invalidateLogToken: (collection) => (fixtureHas(collection) || !cp ? fixture : cp).invalidateLogToken?.(collection),
  };
}

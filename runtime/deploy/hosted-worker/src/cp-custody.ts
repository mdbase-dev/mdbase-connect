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
import type { VerifyOriginalGenesis } from "./custody/hosted-custody.ts";
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const unchanged = (a: ServiceDeviceRecord, b: ServiceDeviceRecord) =>
  a.kind === b.kind && a.deviceId === b.deviceId && a.kmsKeyArn === b.kmsKeyArn
  && same(a.signPk, b.signPk) && same(a.kemPk, b.kemPk) && same(a.noisePk, b.noisePk)
  && same(a.wrappedKeys, b.wrappedKeys) && same(a.genesis.item, b.genesis.item) && same(a.genesis.hash, b.genesis.hash);

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export interface CpCustodyConfig {
  kind: "hosted" | "escrow";
  /** The control-plane client for this kind (no redirects, bounded, abortable). */
  control: {
    serviceDevice(collection: string, signal: AbortSignal): Promise<ServiceDeviceRecord>;
    logToken(device: string, collection: string, signal: AbortSignal): Promise<{ token: string }>;
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
    const r = await c.control.serviceDevice(collection, signal);
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
  return {
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
      const r = await record(collection, signal);
      signal.throwIfAborted();
      const t = await c.control.logToken(r.deviceId, collection, signal);
      signal.throwIfAborted();
      const last = await record(collection, signal);
      signal.throwIfAborted();
      if (!unchanged(r, last)) throw new Error("custody_unavailable");
      if (typeof t?.token !== "string" || !t.token) throw new Error("custody_unavailable");
      return t.token;
    },
  };
}

/** Fixture custody for its listed collections, the control plane's records otherwise. */
export function combinedCustody(fixture: Custody, fixtureHas: (collection: string) => boolean, cp: Custody | null): Custody {
  return {
    openSealer: (collection, signal) => (fixtureHas(collection) || !cp ? fixture : cp).openSealer(collection, signal),
    logToken: (collection, signal) => (fixtureHas(collection) || !cp ? fixture : cp).logToken(collection, signal),
  };
}

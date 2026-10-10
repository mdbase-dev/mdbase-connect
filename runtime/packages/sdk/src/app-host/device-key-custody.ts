/** First-party original sign/KEM custody. No plaintext export, generic signing,
 * collection SQL, KEK generation, identity replacement or recovery/reset API. */
import { decode, encode, type CborValue } from "../cbor.js";
import { uuidToBytes } from "../codec.js";
import type { AppDeviceIdentityPin, AppNoiseCustodyResult, AppWasmRuntime } from "./wasm-runtime.js";

export interface AppDeviceKeyCustodyPin extends AppDeviceIdentityPin {
  readonly accountId: string;
  /** Trusted owned-host lifecycle callback, NOT a UI readiness flag. Must bind
   * the actual installation lease acquired BEFORE unwrap/native device open.
   * It stays false once closing; failed termination does not release leases. */
  installationOwned(): boolean;
}
export interface AppDeviceKeyProtectedStore {
  /** Bounded opaque ciphertext only; writes consume/copy before resolving. */
  read(namespace: string, options: { signal: AbortSignal }): Promise<Uint8Array | null>;
  /** Atomic create-only CAS. False preserves existing identity; a possibly
   * committed/lost-reply write THROWS. No overwrite/delete/retry operation. */
  create(namespace: string, encrypted: Uint8Array, options: { signal: AbortSignal }): Promise<boolean>;
}
export interface AppOpenOriginalDeviceOptions {
  readonly signal: AbortSignal;
  /** Explicit authenticated installation decision, never inferred from null. */
  readonly mode: "fresh" | "existing";
  readonly noise: { readonly mode: "fresh" } | { readonly mode: "existing"; readonly envelope: Uint8Array };
}
const fail = () => new Error("app device key custody unavailable; preserve storage and reopen");
/** The authenticating host supplies its EXISTING persistent nonextractable KEK;
 * this class never creates a substitute. Nonextractable keys/Workers do not
 * isolate from same-origin XSS, and ciphertext/CAS are not durability proofs.
 * One invocation ever per vault/module lifetime, including failed attempts. */
export class AppWebDeviceKeyCustody {
  private readonly scope: Readonly<{ accountId: string; connectorId: string; deviceId: string; installationId: string }>;
  private readonly namespace: string;
  private readonly aad: Uint8Array;
  private readonly current: AppDeviceKeyCustodyPin["isCurrent"];
  private readonly owned: AppDeviceKeyCustodyPin["installationOwned"];
  private attempted = false;
  constructor(private readonly pin: AppDeviceKeyCustodyPin, private readonly key: CryptoKey, private readonly store: AppDeviceKeyProtectedStore) {
    try {
      this.scope = Object.freeze({ accountId: pin.accountId, connectorId: pin.connectorId, deviceId: pin.deviceId, installationId: pin.installationId });
      this.current = pin.isCurrent; this.owned = pin.installationOwned;
      const ids = [this.scope.accountId, this.scope.connectorId, this.scope.deviceId, this.scope.installationId].map(uuidToBytes);
      if (ids.some(b => b.every(v => v === 0)) || key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM" || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) throw fail();
      this.namespace = `mdbase.app-device-keys.v1:${ids.map(b => Array.from(b, v => v.toString(16).padStart(2,"0")).join("")).join(":")}`;
      this.aad = encode(["mdbase/v1/app-device-keys-platform", ...ids]);
      this.check(new AbortController().signal);
    } catch { throw fail(); }
  }
  private check(signal: AbortSignal): void {
    try {
      if (signal.aborted || this.pin.isCurrent !== this.current || this.pin.installationOwned !== this.owned || this.current.call(this.pin) !== true || this.owned.call(this.pin) !== true ||
          this.pin.accountId !== this.scope.accountId || this.pin.connectorId !== this.scope.connectorId || this.pin.deviceId !== this.scope.deviceId || this.pin.installationId !== this.scope.installationId) throw fail();
    } catch { throw fail(); }
  }
  /** Unwrap only while installation ownership is current, hand original loans
   * synchronously to native openDeviceConsuming exactly once, wipe all JS loans.
   * Persist fresh encrypted keys BEFORE native open or any enrol request. */
  async openNativeDevice(runtime: Pick<AppWasmRuntime, "openDeviceConsuming" | "retireLog">, options: AppOpenOriginalDeviceOptions): Promise<AppNoiseCustodyResult> {
    let plain: Uint8Array<ArrayBuffer> | null = null, cipher: Uint8Array | null = null, attemptedNative = false;
    try {
      if (this.attempted) throw fail(); this.attempted = true;
      const signal = options.signal, mode = options.mode;
      this.check(signal);
      if (!(["fresh", "existing"] as const).includes(mode) || options.noise.mode !== mode) throw fail();
      if (options.noise.mode === "existing" && !(options.noise.envelope instanceof Uint8Array)) throw fail();
      const noise = options.noise.mode === "fresh" ? { mode: "fresh" as const } : { mode: "existing" as const, envelope: new Uint8Array(options.noise.envelope) };
      if (noise.mode === "existing" && (!noise.envelope.length || noise.envelope.length > 1024)) throw fail();
      const borrowed = await this.store.read(this.namespace, { signal }); this.check(signal);
      if (mode === "fresh") {
        if (borrowed !== null) throw fail();
        plain = globalThis.crypto.getRandomValues(new Uint8Array(64));
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const body = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array(this.aad), tagLength: 128 }, this.key, plain)); this.check(signal);
        cipher = encode(new Map<number,CborValue>([[0,1],[1,iv],[2,body]]));
        if (await this.store.create(this.namespace, cipher, { signal }) !== true) throw fail(); this.check(signal);
      } else {
        if (!(borrowed instanceof Uint8Array) || borrowed.length === 0 || borrowed.length > 256) throw fail();
        cipher = new Uint8Array(borrowed);
        const value = decode(cipher);
        if (!(value instanceof Map)) throw fail();
        const record = value as Map<CborValue,CborValue>;
        if (record.size !== 3 || record.get(0) !== 1) throw fail();
        const iv = record.get(1), body = record.get(2);
        if (!(iv instanceof Uint8Array) || iv.length !== 12 || !(body instanceof Uint8Array) || body.length !== 80) throw fail();
        plain = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv), additionalData: new Uint8Array(this.aad), tagLength: 128 }, this.key, new Uint8Array(body))); this.check(signal);
        if (plain.length !== 64) throw fail();
      }
      this.check(signal);
      const nativePin: AppDeviceIdentityPin = Object.freeze({ connectorId: this.scope.connectorId, deviceId: this.scope.deviceId, installationId: this.scope.installationId,
        isCurrent: () => { try { this.check(signal); return true; } catch { return false; } } });
      attemptedNative = true;
      const result = runtime.openDeviceConsuming({ pin: nativePin, signSecretKey: plain.subarray(0,32), kemSecretKey: plain.subarray(32), opened: noise });
      this.check(signal); return result;
    } catch { if (attemptedNative) { try { runtime.retireLog(); } catch { /* host must still terminate before unlocking */ } } throw fail(); }
    finally { plain?.fill(0); cipher?.fill(0); }
  }
}

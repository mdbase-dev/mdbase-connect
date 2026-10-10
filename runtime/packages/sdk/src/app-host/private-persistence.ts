/** Fixed-purpose PUBLIC bootstrap outcome custody, not account/password/secret
 * custody. Unexported until persistent-platform/restart qualification completes. */
import { decode, encode, type CborValue } from "../cbor.js";
import { uuidToBytes } from "../codec.js";
import { collectionDisplayName } from "./collection-display-name.js";
import type { AppWebNoiseCustody } from "./noise-custody.js";
import type { AppCpPrivateSession, AppPrivateBootstrapMetadata, AppPrivateBootstrapPersistence } from "./private-bootstrap.js";
import type { AppDeviceRegistrationReceipt, AppPrivateEnrolOperationMarker } from "./wasm-runtime.js";

const MAX_PLAIN = 264 * 1024;
export const APP_PRIVATE_BOOTSTRAP_CIPHER_MAX = MAX_PLAIN + 256;
const bad = () => new Error("app private bootstrap custody unavailable; preserve storage and reopen");
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
/** One exclusively owned, exact-scope record; atomic exact-ciphertext CAS.
 * Missing EXISTING records and unknown writes must refuse, not recreate. */
export interface AppPrivateBootstrapProtectedStore {
  read(options: { signal: AbortSignal }): Promise<Uint8Array | null>;
  compareAndSet(expected: Uint8Array | null, encrypted: Uint8Array, options: { signal: AbortSignal }): Promise<boolean>;
}
interface RecordValue { commit: Uint8Array | null; metadata: AppPrivateBootstrapMetadata | null; }

export class AppWebPrivateBootstrapPersistence implements AppPrivateBootstrapPersistence {
  private readonly pins: Readonly<{ accountId: string; connectorId: string; deviceId: string; installationId: string; collection: string; purpose: "create" | "enrol"; cpOrigin: string; logOrigin: string }>;
  private readonly root: Uint8Array;
  private readonly keys: readonly Uint8Array[];
  private readonly aad: Uint8Array;
  private readonly displayName: string | undefined;
  constructor(private readonly source: AppCpPrivateSession, receipt: AppDeviceRegistrationReceipt,
    private readonly key: CryptoKey, private readonly store: AppPrivateBootstrapProtectedStore,
    private readonly noise: Pick<AppWebNoiseCustody, "privateEnrolPending" | "privateEnrolAcknowledged">,
    options: { allowLoopbackHttp?: boolean; displayName?: string } = {}) {
    try {
      const requestedName = options.displayName;
      this.displayName = requestedName === undefined ? undefined : collectionDisplayName(requestedName);
      if (this.displayName !== undefined && source.purpose !== "create") throw bad();
      this.pins = Object.freeze({ accountId: source.accountId, connectorId: source.connectorId, deviceId: source.deviceId,
        installationId: source.installationId, collection: source.collection, purpose: source.purpose, cpOrigin: source.cpOrigin, logOrigin: source.logOrigin });
      const ids = [this.pins.accountId, this.pins.connectorId, this.pins.deviceId, this.pins.installationId, this.pins.collection].map(uuidToBytes);
      if (ids.some(b => b.every(v => v === 0)) || !["create", "enrol"].includes(this.pins.purpose)) throw bad();
      for (const raw of [source.cpOrigin, source.logOrigin]) {
        const u = new URL(raw), loopback = options.allowLoopbackHttp === true && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
        if ((!loopback && u.protocol !== "https:") || u.origin !== raw || u.username || u.password) throw bad();
      }
      if (!(source.rootPublicKey instanceof Uint8Array) || source.rootPublicKey.length !== 32 || source.rootPublicKey.every(v => v === 0)) throw bad();
      this.root = new Uint8Array(source.rootPublicKey);
      this.keys = [receipt.signPublicKey, receipt.kemPublicKey, receipt.noisePublicKey].map(b => {
        if (!(b instanceof Uint8Array) || b.length !== 32 || b.every(v => v === 0)) throw bad(); return new Uint8Array(b);
      });
      this.checkReceipt(receipt);
      if (key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM" || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) throw bad();
      // Separate from Noise platform AAD; no nonce, token, r or secret is stored.
      this.aad = encode(["mdbase/v1/app-private-bootstrap-platform", ...ids, this.pins.purpose, source.cpOrigin, source.logOrigin, this.root]);
      this.check(new AbortController().signal);
    } catch { throw bad(); }
  }
  private check(signal: AbortSignal): void {
    try { if (signal.aborted || this.source.isCurrent() !== true || this.source.approvalMode !== "password-ak1" ||
      !equal(this.source.rootPublicKey, this.root) || Object.entries(this.pins).some(([k, v]) => this.source[k as keyof AppCpPrivateSession] !== v)) throw bad(); }
    catch { throw bad(); }
  }
  private checkReceipt(value: AppDeviceRegistrationReceipt): void {
    if (value.connectorId !== this.pins.connectorId || value.deviceId !== this.pins.deviceId || value.installationId !== this.pins.installationId) throw bad();
    const keys = [value.signPublicKey, value.kemPublicKey, value.noisePublicKey];
    if (keys.some((b, i) => !(b instanceof Uint8Array) || b.length !== 32 || b.every(v => v === 0) || !equal(b, this.keys[i]!))) throw bad();
  }
  private commit(marker: AppPrivateEnrolOperationMarker): Uint8Array {
    this.checkReceipt(marker);
    if (this.pins.purpose !== "enrol" || marker.collection !== this.pins.collection || typeof marker.acknowledged !== "boolean" ||
      !(marker.sasCommitment instanceof Uint8Array) || marker.sasCommitment.length !== 32 || marker.sasCommitment.every(v => v === 0)) throw bad();
    return new Uint8Array(marker.sasCommitment);
  }
  private markerCopy(marker: AppPrivateEnrolOperationMarker, commit: Uint8Array): AppPrivateEnrolOperationMarker {
    return Object.freeze({ connectorId: this.pins.connectorId, deviceId: this.pins.deviceId, installationId: this.pins.installationId,
      collection: this.pins.collection, signPublicKey: new Uint8Array(this.keys[0]!), kemPublicKey: new Uint8Array(this.keys[1]!),
      noisePublicKey: new Uint8Array(this.keys[2]!), sasCommitment: new Uint8Array(commit), acknowledged: marker.acknowledged });
  }
  private copy(metadata: AppPrivateBootstrapMetadata): AppPrivateBootstrapMetadata {
    if (metadata.displayName !== this.displayName || metadata.collection !== this.pins.collection || metadata.deviceId !== this.pins.deviceId || metadata.logOrigin !== this.pins.logOrigin ||
      !(metadata.rootPublicKey instanceof Uint8Array) || !equal(metadata.rootPublicKey, this.root) || !(metadata.genesisItem instanceof Uint8Array) ||
      !metadata.genesisItem.length || metadata.genesisItem.length > 256 * 1024 || !/^sha256:[0-9a-f]{64}$/.test(metadata.expectedGenesis) ||
      metadata.approval !== (this.pins.purpose === "create" ? "creator" : "pending")) throw bad();
    return Object.freeze({ collection: this.pins.collection, deviceId: this.pins.deviceId, logOrigin: this.pins.logOrigin,
      rootPublicKey: new Uint8Array(this.root), genesisItem: new Uint8Array(metadata.genesisItem), expectedGenesis: metadata.expectedGenesis, approval: metadata.approval,
      ...(this.displayName === undefined ? {} : {displayName: this.displayName}) });
  }
  private async hashChecked(metadata: AppPrivateBootstrapMetadata, signal: AbortSignal): Promise<void> {
    const domain = new TextEncoder().encode("mdbase/v1/chain"), bytes = new Uint8Array(1 + domain.length + metadata.genesisItem.length);
    bytes[0] = domain.length; bytes.set(domain, 1); bytes.set(metadata.genesisItem, 1 + domain.length);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); this.check(signal);
    if (metadata.expectedGenesis !== `sha256:${hex(hash)}`) throw bad(); // not native signature verification
  }
  private async read(options: { signal: AbortSignal }): Promise<{ encrypted: Uint8Array; value: RecordValue } | null> {
    let plain: Uint8Array | null = null;
    try {
      this.check(options.signal); const borrowed = await this.store.read(options); this.check(options.signal);
      if (borrowed === null) return null;
      if (!(borrowed instanceof Uint8Array) || !borrowed.length || borrowed.length > APP_PRIVATE_BOOTSTRAP_CIPHER_MAX) throw bad();
      const encrypted = new Uint8Array(borrowed), decodedOuter = decode(encrypted);
      if (!(decodedOuter instanceof Map)) throw bad(); const outer = decodedOuter as Map<CborValue, CborValue>;
      if (outer.size !== 3 || outer.get(0) !== 1) throw bad();
      const iv = outer.get(1), body = outer.get(2);
      if (!(iv instanceof Uint8Array) || iv.length !== 12 || !(body instanceof Uint8Array) || body.length < 16 || body.length > MAX_PLAIN + 16) throw bad();
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv), additionalData: new Uint8Array(this.aad), tagLength: 128 }, this.key, new Uint8Array(body))); this.check(options.signal);
      if (plain.length > MAX_PLAIN) throw bad(); const decodedRecord = decode(plain);
      if (!(decodedRecord instanceof Map)) throw bad(); const record = decodedRecord as Map<CborValue, CborValue>;
      const legacy = record.get(0) === 1 && record.size === 4;
      if (!legacy && !(record.get(0) === 2 && record.size === 5)) throw bad();
      if ((legacy ? null : record.get(4)) !== (this.displayName ?? null)) throw bad();
      const keys = record.get(1); if (!Array.isArray(keys) || keys.length !== 3 || keys.some((b, i) => !(b instanceof Uint8Array) || !equal(b, this.keys[i]!))) throw bad();
      const commit = record.get(2); if (this.pins.purpose === "create" ? commit !== null : !(commit instanceof Uint8Array) || commit.length !== 32 || commit.every(v => v === 0)) throw bad();
      const raw = record.get(3); let metadata: AppPrivateBootstrapMetadata | null = null;
      if (raw !== null) {
        if (!Array.isArray(raw) || raw.length !== 2 || !(raw[0] instanceof Uint8Array) || typeof raw[1] !== "string") throw bad();
        metadata = this.copy({ ...this.pins, rootPublicKey: this.root, genesisItem: raw[0], expectedGenesis: raw[1], approval: this.pins.purpose === "create" ? "creator" : "pending",
          ...(this.displayName === undefined ? {} : {displayName: this.displayName}) });
        await this.hashChecked(metadata, options.signal);
      }
      return { encrypted, value: { commit: commit === null ? null : new Uint8Array(commit as Uint8Array), metadata } };
    } catch { throw bad(); } finally { plain?.fill(0); }
  }
  private async write(value: RecordValue, expected: Uint8Array | null, options: { signal: AbortSignal }): Promise<void> {
    let plain: Uint8Array | null = null, encrypted: Uint8Array | null = null;
    try {
      this.check(options.signal);
      plain = encode(new Map<number, CborValue>([[0, 2], [1, this.keys.map(b => new Uint8Array(b))], [2, value.commit],
        [3, value.metadata === null ? null : [value.metadata.genesisItem, value.metadata.expectedGenesis]], [4, this.displayName ?? null]]));
      if (plain.length > MAX_PLAIN) throw bad(); const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array(this.aad), tagLength: 128 }, this.key, new Uint8Array(plain))); this.check(options.signal);
      encrypted = encode(new Map<number, CborValue>([[0, 1], [1, iv], [2, body]]));
      const stored = await this.store.compareAndSet(expected, encrypted, options); this.check(options.signal);
      if (stored !== true) throw bad(); // unknown/applied-then-thrown remains preserved; no retry/undo
    } catch { throw bad(); } finally { plain?.fill(0); encrypted?.fill(0); }
  }
  async pendingCreate(scope: AppDeviceRegistrationReceipt & { readonly collection: string; readonly displayName?: string }, options: { signal: AbortSignal }): Promise<void> {
    this.check(options.signal); this.checkReceipt(scope);
    if (this.pins.purpose !== "create" || scope.collection !== this.pins.collection || scope.displayName !== this.displayName) throw bad();
    const existing = await this.read(options); this.check(options.signal); if (existing) return;
    await this.write({ commit: null, metadata: null }, null, options);
  }
  async privateEnrolPending(marker: AppPrivateEnrolOperationMarker, options: { signal: AbortSignal }): Promise<void> {
    this.check(options.signal); const commit = this.commit(marker), owned = this.markerCopy(marker, commit); if (owned.acknowledged) throw bad();
    const existing = await this.read(options); this.check(options.signal);
    if (existing && !equal(existing.value.commit!, commit)) throw bad();
    try { await this.noise.privateEnrolPending(owned, options); this.check(options.signal); } catch { throw bad(); }
    if (!existing) await this.write({ commit, metadata: null }, null, options);
  }
  async completed(metadata: AppPrivateBootstrapMetadata, options: { signal: AbortSignal }): Promise<void> {
    this.check(options.signal); const owned = this.copy(metadata); await this.hashChecked(owned, options.signal);
    const existing = await this.read(options); this.check(options.signal); if (!existing) throw bad();
    if (existing.value.metadata) {
      if (!equal(existing.value.metadata.genesisItem, owned.genesisItem) || existing.value.metadata.expectedGenesis !== owned.expectedGenesis) throw bad(); return;
    }
    await this.write({ ...existing.value, metadata: owned }, existing.encrypted, options);
  }
  async privateEnrolAcknowledged(marker: AppPrivateEnrolOperationMarker, options: { signal: AbortSignal }): Promise<void> {
    this.check(options.signal); const commit = this.commit(marker), owned = this.markerCopy(marker, commit);
    const existing = await this.read(options); this.check(options.signal);
    if (!existing?.value.metadata || !equal(existing.value.commit!, commit)) throw bad();
    try { await this.noise.privateEnrolAcknowledged(owned, options); this.check(options.signal); } catch { throw bad(); }
  }
  async restoredCompletion(options: { signal: AbortSignal }): Promise<AppPrivateBootstrapMetadata | null> {
    const existing = await this.read(options); this.check(options.signal); return existing?.value.metadata ? this.copy(existing.value.metadata) : null;
  }
}

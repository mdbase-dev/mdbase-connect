/**
 * Private (E2E) multi-device enrolment with the account key (AK1,
 * account-key bundle design): setup, unlock, change
 * password, recover and strict mode, over two narrow host ports.
 *
 * - {@link AccountKeyControlPort}: the Connect client's authenticated account-key routes
 *   (§5). The host owns the connector bearer, the device identity, challenges and the
 *   device proof signature; the SDK never sees a bearer or signs as the device.
 * - {@link AccountKeyReplicaPort}: the replica's account-key operations (§6) for each
 *   private collection this device has open. The replica derives the recovery device
 *   from `R`, checks the enrolment and appends grants; the SDK never
 *   builds log items.
 *
 * `R` is held only in the {@link AccountSecretStore} (RAM by default; hosts supply the
 * platform keychain, never a file) and wiped from working buffers after each step.
 * Every step re-checks the caller's signal; a committed control-plane write is never
 * reported cancelled.
 */
import {
  AccountKeyError, type Argon2idRunner, type Bundle, type Entropy, checkPassword, checkRecoveryKey, decodeBundle,
  deriveAccountKeyProof, deriveRecoveryDevice, domainHash, encodeBundle, formatRecoveryKey, generateRecoveryKey, inlineArgon2id,
  keyId, openBundle, parseRecoveryKey, platformEntropy, recoverySign, sealBundle, signAccountKeyRewrap, uuidBytes, wipe, wipeRecoveryDevice,
} from "./account-key.js";
import { encode, fromHex, toHex } from "./cbor.js";
import { passwordStrength, type Strength } from "./strength.js";

export interface PrivateAccountRequestOptions {
  signal?: AbortSignal;
}

export type AccountKeyMode = "none" | "password" | "strict";

export interface PrivateAccountStatus {
  mode: AccountKeyMode;
  /** This device holds `R` (set up, unlocked or recovered here, and not locked since). */
  unlocked: boolean;
  /** The control plane's compare-and-set version. */
  version: number;
  /** Strict-only, CP-authoritative completion across all private recovery targets. */
  strictComplete?: boolean;
  /** Strict-only CP missing witnesses; never inferred from locally open collections. */
  pending?: StrictPendingTarget[];
  /** Strict-only: this device still holds R. `status()` is read-only. */
  accountKeyKept?: boolean;
}

export interface StrictPendingTarget {
  collectionId: string;
  deviceId: string;
  /** Log revocation position, or null while it has not yet been appended. */
  revokedAt: number | null;
}

/**
 * The account-key control routes (AK1 §5.2–5.3), implemented by the Connect client for
 * its signed-in account. Each method performs exactly one fixed route with the caller's
 * device proof; responses are returned raw and validated by the SDK. Errors may be any
 * object; the SDK reads `status`, `code`/`problem.code` and `retryAfterMs`/`retry_after`.
 */
export interface AccountKeyControlPort {
  /** The signed-in account (the connector's user), which the bundle is bound to. */
  readonly accountId: string;
  /** Budget-free status; strict includes CP `complete` and `pending` witnesses. */
  status(options: PrivateAccountRequestOptions): Promise<unknown>;
  /** `GET /v1/next/account-key` → `{mode, version, key_id?, bundle?}`: the bundle; rate-limited (10 per hour per account). */
  fetch(options: PrivateAccountRequestOptions): Promise<unknown>;
  /** `PUT /v1/next/account-key` → `{mode: "password", version, key_id}`. `proof_pk`/`proof_sig` are the account key's proof (§5.2). */
  put(
    body: { expected_version: number; key_id: string; bundle: string; proof_pk: string; proof_sig: string },
    options: PrivateAccountRequestOptions,
  ): Promise<unknown>;
  /** Strict response includes `version`, CP `complete`/`pending`, and `revocations`; retries retain version. */
  strict(body: { expected_version: number }, options: PrivateAccountRequestOptions): Promise<unknown>;
  /** A fresh single-use challenge (`POST /v1/next/devices/challenge`, 64 hex) the host will also prove with. */
  challenge(options: PrivateAccountRequestOptions): Promise<unknown>;
  /** `POST /v1/next/collections/:id/private/account-key-device` with the host's proof over the same challenge. */
  enrolRecoveryDevice(
    collectionId: string,
    body: { challenge: string; recovery_device: string; sign_pk: string; kem_pk: string; pop: string },
    options: PrivateAccountRequestOptions,
  ): Promise<unknown>;
  close?(): void;
}

/**
 * The replica side (AK1 §6), per private collection this device has open. Both calls
 * take `R`; the replica derives the collection's recovery device, refuses outside e2e
 * or when the enrolment does not carry the derived keys, and never keeps `R`.
 */
export interface AccountKeyReplicaPort {
  /** Private (e2e) collections of this account that this device has open. */
  privateCollections(options: PrivateAccountRequestOptions): Promise<string[]>;
  /** Setup step 2: check the enrolment and append the editor `key_grant` to the recovery device. */
  keyAccountKeyDevice(collectionId: string, secret: Uint8Array, options: PrivateAccountRequestOptions): Promise<void>;
  /** Unlock step 3: self-grant signed by the recovery device; resolves once this device is keyed. */
  selfGrantWithAccountKey(collectionId: string, secret: Uint8Array, options: PrivateAccountRequestOptions): Promise<void>;
}

/** Where `R` lives between calls: the platform keychain, supplied by the host (never a file). */
export interface AccountSecretStore {
  get(): Promise<Uint8Array | null>;
  set(secret: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/** RAM only, for tests and short-lived tools. Production hosts inject the platform keychain. */
export function memorySecretStore(): AccountSecretStore {
  let held: Uint8Array | null = null;
  return {
    get: async () => (held ? held.slice() : null),
    set: async (s) => {
      if (held) wipe(held);
      held = s.slice();
    },
    clear: async () => {
      if (held) wipe(held);
      held = null;
    },
  };
}

export interface PrivateAccountPorts {
  control: AccountKeyControlPort;
  replica: AccountKeyReplicaPort;
  /** The platform keychain (never a file). `memorySecretStore()` is for tests only. */
  secrets: AccountSecretStore;
  /** Off-thread Argon2id; the default runs on the calling thread. */
  argon2id?: Argon2idRunner;
  entropy?: Entropy;
}

export interface SetupResult {
  /** Shown once; the user saves it. The SDK does not keep the text. */
  recoveryKey: string;
  /** Private collections whose recovery device could not be enrolled or keyed now; retry with `keyCollections`. */
  incomplete?: string[];
}

export interface StrictResult {
  version: number;
  /** Only the CP's explicit true permits local R deletion. */
  complete: boolean;
  pending: StrictPendingTarget[];
  accountKeyKept: boolean;
  /** Recovery devices the control plane queued for revocation; each collection rekeys when a keyed device applies it. */
  revocations: { collectionId: string; deviceId: string }[];
  alreadyStrict: boolean;
}

export interface UnlockResult {
  /** Private collections where the self-grant was refused or failed; retry with `unlock` once they are current. */
  incomplete?: string[];
}

interface State {
  mode: AccountKeyMode;
  version: number;
  bundle?: Bundle;
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX_BUNDLE = /^([0-9a-f]{2}){1,512}$/;
const bad = (reason: string) => new AccountKeyError("internal", "Invalid control-plane account-key response.", { reason });
const unavailable = (reason: string, retryAfterMs?: number) =>
  new AccountKeyError("unavailable", "The account key service refused or was unreachable.", retryAfterMs === undefined ? { reason } : { reason, retryAfterMs });

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("not_object");
  return v as Record<string, unknown>;
}
const version = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw bad("version");
  return v as number;
};

/** Validate the entire CP completion answer before permitting any key deletion. */
function strictCompletion(r: Record<string, unknown>): { complete: boolean; pending: StrictPendingTarget[] } {
  if (typeof r.complete !== "boolean" || !Array.isArray(r.pending) || r.pending.length > 1024) throw bad("strict_completion");
  const seen = new Set<string>();
  const pending = r.pending.map((x) => {
    const o = object(x);
    if (typeof o.collection_id !== "string" || typeof o.device_id !== "string"
      || (o.revoked_at !== null && (!Number.isSafeInteger(o.revoked_at) || (o.revoked_at as number) < 0))) throw bad("strict_pending");
    uuidBytes(o.collection_id);
    uuidBytes(o.device_id);
    const id = `${o.collection_id.toLowerCase()}/${o.device_id.toLowerCase()}`;
    if (seen.has(id)) throw bad("strict_pending");
    seen.add(id);
    return { collectionId: o.collection_id, deviceId: o.device_id, revokedAt: o.revoked_at as number | null };
  });
  if (r.complete && pending.length !== 0) throw bad("strict_completion");
  return { complete: r.complete, pending };
}

/** Map a port failure to a typed error; never leak a foreign error class. */
function mapPortError(error: unknown): AccountKeyError {
  if (error instanceof AccountKeyError) return error;
  const e = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const problem = (e.problem && typeof e.problem === "object" ? e.problem : {}) as Record<string, unknown>;
  const code = typeof problem.code === "string" ? problem.code : typeof e.code === "string" ? e.code : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  const retryRaw = e.retryAfterMs ?? problem.retryAfterMs ?? (typeof e.retry_after === "number" ? e.retry_after * 1000 : undefined);
  const retryAfterMs = typeof retryRaw === "number" && Number.isFinite(retryRaw) && retryRaw >= 0 ? retryRaw : undefined;
  if (code === "rate_limited" || status === 429) {
    return new AccountKeyError("rate_limited", "Too many account key requests; try again later.", retryAfterMs === undefined ? {} : { retryAfterMs });
  }
  if (code === "version_conflict" || code === "rotate_requires_strict") return new AccountKeyError("conflict", "The account key changed; fetch the current state and retry.", { reason: code });
  if (code === "strict_mode") return new AccountKeyError("strict_mode", "The account is in strict mode.");
  if (code === "account_key_proof_required") return new AccountKeyError("wrong_secret", "The account key held here is not the one registered for this bundle.", { reason: code });
  if (code === "no_account_key") return new AccountKeyError("no_account_key", "The account has no account key.");
  if (code === "cancelled" || (e.name === "AbortError")) return new AccountKeyError("cancelled", "Account key request cancelled.");
  return unavailable(code || (status === undefined ? "port_failure" : `http_${status}`), retryAfterMs);
}

/** Setup, unlock and recovery for private collections (AK1 §7). */
export class PrivateAccount {
  private readonly lifetime = new AbortController();
  private readonly control: AccountKeyControlPort;
  private readonly replica: AccountKeyReplicaPort;
  private readonly secrets: AccountSecretStore;
  private readonly argon2id: Argon2idRunner;
  private readonly entropy: Entropy;
  /** One account-key operation at a time: they all compare-and-set the same version. */
  private busy: Promise<unknown> = Promise.resolve();
  private last: PrivateAccountStatus | null = null;

  constructor(ports: PrivateAccountPorts) {
    this.control = ports.control;
    this.replica = ports.replica;
    if (!ports.secrets) throw new AccountKeyError("internal", "PrivateAccount needs a secret store (the platform keychain).");
    this.secrets = ports.secrets;
    this.argon2id = ports.argon2id ?? inlineArgon2id;
    this.entropy = ports.entropy ?? platformEntropy;
    uuidBytes(this.control.accountId);
  }

  /** Stops this facade. `R` stays in the secret store (the host owns its lifetime). */
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.control.close?.();
  }

  /** Local and synchronous; the server never sees the password. */
  passwordStrength(password: string): Strength {
    return passwordStrength(password);
  }

  /** The account's mode from the status route (no bundle, not on the fetch budget). */
  async status(options: PrivateAccountRequestOptions = {}): Promise<PrivateAccountStatus> {
    return this.serial(options, (signal) => this.readStatus(signal));
  }

  /** The last `status()` answer, without a request; `null` before the first fetch. */
  get lastStatus(): PrivateAccountStatus | null {
    return this.last;
  }

  /** First private collection, device A (§3.1). The recovery key is returned once. */
  async setup(password: string, signal?: AbortSignal): Promise<SetupResult> {
    return this.serial({ signal }, async (s) => {
      const strength = passwordStrength(password);
      checkPassword(password);
      if (!strength.acceptable) throw new AccountKeyError("weak_password", "The password is too weak.", { reason: "strength" });
      const state = await this.fetchState(s);
      if (state.mode === "password") throw new AccountKeyError("already_set_up", "This account already has an account key; unlock it instead.");
      const secret = generateRecoveryKey(this.entropy);
      try {
        const bundle = await sealBundle(secret, password, this.control.accountId, { entropy: this.entropy, argon2id: this.argon2id, signal: s });
        this.check(s);
        await this.putBundle(secret, state.version, bundle, s);
        await this.secrets.set(secret);
        const recoveryKey = formatRecoveryKey(secret);
        const incomplete = await this.keyAll(secret, s);
        return incomplete.length ? { recoveryKey, incomplete } : { recoveryKey };
      } finally {
        wipe(secret);
      }
    });
  }

  /** New device B, same account (§3.2): opens the bundle and self-grants in every private collection. */
  async unlock(secret: { password: string } | { recoveryKey: string }, signal?: AbortSignal): Promise<UnlockResult> {
    return this.serial({ signal }, async (s) => {
      const state = await this.requirePassword(s);
      let r: Uint8Array;
      if ("recoveryKey" in secret) {
        r = parseRecoveryKey(secret.recoveryKey);
        try {
          checkRecoveryKey(r, state.bundle!);
        } catch (e) {
          wipe(r);
          throw e;
        }
      } else {
        r = await openBundle(state.bundle!, secret.password, this.control.accountId, { argon2id: this.argon2id, signal: s });
      }
      try {
        this.check(s);
        await this.secrets.set(r);
        const incomplete = await this.grantAll(r, s);
        return incomplete.length ? { incomplete } : {};
      } finally {
        wipe(r);
      }
    });
  }

  /** Re-wrap the same `R` (same key id); nothing on any log changes. Requires unlocked. */
  async changePassword(newPassword: string, signal?: AbortSignal): Promise<void> {
    return this.serial({ signal }, async (s) => {
      const strength = passwordStrength(newPassword);
      checkPassword(newPassword);
      if (!strength.acceptable) throw new AccountKeyError("weak_password", "The password is too weak.", { reason: "strength" });
      const r = await this.secrets.get();
      if (!r) throw new AccountKeyError("locked", "Unlock the account key on this device first.");
      try {
        const state = await this.requirePassword(s);
        try {
          checkRecoveryKey(r, state.bundle!);
        } catch {
          throw new AccountKeyError("conflict", "The account key on the server is not the one unlocked here; unlock again.", { reason: "key_id_changed" });
        }
        const bundle = await sealBundle(r, newPassword, this.control.accountId, { entropy: this.entropy, argon2id: this.argon2id, signal: s });
        this.check(s);
        await this.putBundle(r, state.version, bundle, s);
      } finally {
        wipe(r);
      }
    });
  }

  /** Forgotten password: the recovery key opens the account, and a new bundle wraps the same `R`. */
  async recover(recoveryKey: string, newPassword: string, signal?: AbortSignal): Promise<UnlockResult> {
    return this.serial({ signal }, async (s) => {
      const strength = passwordStrength(newPassword);
      checkPassword(newPassword);
      if (!strength.acceptable) throw new AccountKeyError("weak_password", "The password is too weak.", { reason: "strength" });
      const r = parseRecoveryKey(recoveryKey);
      try {
        const state = await this.requirePassword(s);
        checkRecoveryKey(r, state.bundle!);
        const bundle = await sealBundle(r, newPassword, this.control.accountId, { entropy: this.entropy, argon2id: this.argon2id, signal: s });
        this.check(s);
        await this.putBundle(r, state.version, bundle, s);
        await this.secrets.set(r);
        const incomplete = await this.grantAll(r, s);
        return incomplete.length ? { incomplete } : {};
      } finally {
        wipe(r);
      }
    });
  }

  /**
   * Account-level strict mode (§3.3). The control plane deletes the bundle, records
   * strict, and queues a `device-revoke` for each listed recovery device; the result is
   * NOT complete protection: each collection is rekeyed only when one of its keyed
   * devices applies that revocation, and content keyed before then stays readable to
   * whoever held the old bundle and password. The UI shows the pending revocations and
   * says so. R stays here until explicit CP completion; repeat this operation to
   * forget it after witnesses arrive. Leaving strict is `setup` with a new key.
   */
  async enableStrict(signal?: AbortSignal): Promise<StrictResult> {
    return this.serial({ signal }, async (s) => {
      const state = await this.readStatus(s);
      if (state.mode === "strict") {
        if (state.strictComplete === true) await this.secrets.clear();
        const accountKeyKept = state.strictComplete === true ? false : state.accountKeyKept!;
        this.last = { ...state, accountKeyKept };
        return { version: state.version, complete: state.strictComplete!, pending: state.pending!, accountKeyKept, revocations: [], alreadyStrict: true };
      }
      let raw: unknown;
      try {
        raw = await this.control.strict({ expected_version: state.version }, { signal: s });
      } catch (e) {
        throw mapPortError(e);
      }
      const r = object(raw);
      if (r.mode !== "strict" || version(r.version) !== state.version + 1 || !Array.isArray(r.revocations)) throw bad("strict");
      const completion = strictCompletion(r);
      const revocations = r.revocations.map((x) => {
        const o = object(x);
        if (typeof o.collection_id !== "string" || typeof o.device_id !== "string") throw bad("strict");
        uuidBytes(o.collection_id);
        uuidBytes(o.device_id);
        return { collectionId: o.collection_id, deviceId: o.device_id };
      });
      if (completion.complete === true) await this.secrets.clear();
      const held = await this.secrets.get();
      const accountKeyKept = held !== null;
      if (held) wipe(held);
      this.last = { mode: "strict", version: r.version as number, unlocked: false, strictComplete: completion.complete, pending: completion.pending, accountKeyKept };
      return { version: r.version as number, ...completion, accountKeyKept, revocations, alreadyStrict: false };
    });
  }

  /**
   * Setup step 2 for every private collection this device has open (also for private
   * collections created after setup, §3.1.3). Requires unlocked. Returns the
   * collections that are still incomplete.
   */
  async keyCollections(signal?: AbortSignal): Promise<string[]> {
    return this.serial({ signal }, async (s) => {
      const r = await this.secrets.get();
      if (!r) throw new AccountKeyError("locked", "Unlock the account key on this device first.");
      try {
        const state = await this.requirePassword(s);
        checkRecoveryKey(r, state.bundle!);
        return await this.keyAll(r, s);
      } finally {
        wipe(r);
      }
    });
  }

  /** Forget `R` on this device. Keys already granted to this device stay; a later `unlock` is needed to key new collections. */
  async lock(): Promise<void> {
    await this.secrets.clear();
  }

  // ---------------------------------------------------------------- internals

  private serial<T>(options: PrivateAccountRequestOptions, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = options.signal ? AbortSignal.any([this.lifetime.signal, options.signal]) : this.lifetime.signal;
    const run = this.busy.then(
      () => {
        this.check(signal);
        return f(signal);
      },
      () => {
        this.check(signal);
        return f(signal);
      },
    );
    this.busy = run.catch(() => undefined);
    return run;
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new AccountKeyError("cancelled", "Account key request cancelled.");
  }

  private async readStatus(signal: AbortSignal): Promise<PrivateAccountStatus> {
    let raw: unknown;
    try {
      raw = await this.control.status({ signal });
    } catch (e) {
      throw mapPortError(e);
    }
    this.check(signal);
    const r = object(raw);
    const v = version(r.version);
    let mode: AccountKeyMode;
    let keyIdHex: string | null = null;
    if (r.mode === "none" && v === 0) mode = "none";
    else if (r.mode === "strict") mode = "strict";
    else if (r.mode === "password" && typeof r.key_id === "string" && HEX32.test(r.key_id)) {
      mode = "password";
      keyIdHex = r.key_id;
    } else throw bad("status");
    const completion = mode === "strict" ? strictCompletion(r) : undefined;
    const held = await this.secrets.get();
    try {
      const unlocked = keyIdHex !== null && held !== null && held.length === 32 && toHex(keyId(held)) === keyIdHex;
      return (this.last = {
        mode, unlocked, version: v,
        ...(completion ? { strictComplete: completion.complete, pending: completion.pending, accountKeyKept: held !== null } : {}),
      });
    } finally {
      if (held) wipe(held);
    }
  }

  private async fetchState(signal: AbortSignal): Promise<State> {
    let raw: unknown;
    try {
      raw = await this.control.fetch({ signal });
    } catch (e) {
      throw mapPortError(e);
    }
    this.check(signal);
    const r = object(raw);
    const v = version(r.version);
    if (r.mode === "none") {
      if (v !== 0) throw bad("mode");
      return { mode: "none", version: 0 };
    }
    if (r.mode === "strict") return { mode: "strict", version: v };
    if (r.mode !== "password") throw bad("mode");
    if (typeof r.key_id !== "string" || !HEX32.test(r.key_id) || typeof r.bundle !== "string" || !HEX_BUNDLE.test(r.bundle)) throw bad("bundle");
    const bundle = decodeBundle(fromHex(r.bundle));
    if (toHex(bundle.keyId) !== r.key_id) throw bad("key_id");
    return { mode: "password", version: v, bundle };
  }

  private async requirePassword(signal: AbortSignal): Promise<State> {
    const state = await this.fetchState(signal);
    if (state.mode === "none") throw new AccountKeyError("no_account_key", "The account has no account key yet; set one up on a device that holds the keys.");
    if (state.mode === "strict") throw new AccountKeyError("strict_mode", "The account is in strict mode; approve this device from an existing device.");
    return state;
  }

  /** Store a bundle with the account key's proof: the proof key registered with it, and a signature over this rewrap. */
  private async putBundle(secret: Uint8Array, expected: number, bundle: Bundle, signal: AbortSignal): Promise<void> {
    const keyIdHex = toHex(bundle.keyId);
    const bytes = encodeBundle(bundle);
    const proof = deriveAccountKeyProof(secret, this.control.accountId);
    let raw: unknown;
    try {
      const proof_sig = toHex(signAccountKeyRewrap(proof, this.control.accountId, bytes, expected));
      raw = await this.control.put({ expected_version: expected, key_id: keyIdHex, bundle: toHex(bytes), proof_pk: toHex(proof.pk), proof_sig }, { signal });
    } catch (e) {
      throw mapPortError(e);
    } finally {
      wipe(proof.seed);
    }
    const r = object(raw);
    if (r.mode !== "password" || version(r.version) !== expected + 1 || r.key_id !== keyIdHex) throw bad("put");
  }

  private async collections(signal: AbortSignal): Promise<string[]> {
    let list: string[];
    try {
      list = await this.replica.privateCollections({ signal });
    } catch (e) {
      throw mapPortError(e);
    }
    this.check(signal);
    if (!Array.isArray(list) || list.some((c) => typeof c !== "string") || new Set(list).size !== list.length) throw bad("collections");
    for (const c of list) uuidBytes(c);
    return list;
  }

  /** Enrol and key the recovery device in each private collection; collect the ones that failed. */
  private async keyAll(secret: Uint8Array, signal: AbortSignal): Promise<string[]> {
    const incomplete: string[] = [];
    for (const collection of await this.collections(signal)) {
      this.check(signal);
      try {
        await this.enrol(secret, collection, signal);
        await this.replica.keyAccountKeyDevice(collection, secret, { signal });
      } catch (e) {
        if (e instanceof AccountKeyError && e.code === "cancelled") throw e;
        incomplete.push(collection);
      }
    }
    return incomplete;
  }

  private async grantAll(secret: Uint8Array, signal: AbortSignal): Promise<string[]> {
    const incomplete: string[] = [];
    for (const collection of await this.collections(signal)) {
      this.check(signal);
      try {
        await this.replica.selfGrantWithAccountKey(collection, secret, { signal });
      } catch (e) {
        if (e instanceof AccountKeyError && e.code === "cancelled") throw e;
        incomplete.push(collection);
      }
    }
    return incomplete;
  }

  /** §5.3: the control plane enrols the derived recovery device, with a proof of possession by its signing key. */
  private async enrol(secret: Uint8Array, collection: string, signal: AbortSignal): Promise<void> {
    let challengeRaw: unknown;
    try {
      challengeRaw = await this.control.challenge({ signal });
    } catch (e) {
      throw mapPortError(e);
    }
    const challenge = typeof challengeRaw === "string" ? challengeRaw.toLowerCase()
      : typeof (challengeRaw as { challenge?: unknown } | null)?.challenge === "string" ? ((challengeRaw as { challenge: string }).challenge).toLowerCase() : "";
    if (!HEX32.test(challenge)) throw bad("challenge");
    this.check(signal);
    const device = deriveRecoveryDevice(secret, collection);
    try {
      const digest = domainHash("mdbase/v1/account-key-enrol", encode([
        fromHex(challenge), uuidBytes(collection), uuidBytes(device.device), uuidBytes(this.control.accountId), device.signPk, device.kemPk, device.noisePk,
      ]));
      const pop = toHex(recoverySign(device, digest));
      let raw: unknown;
      try {
        raw = await this.control.enrolRecoveryDevice(collection, {
          challenge, recovery_device: device.device, sign_pk: toHex(device.signPk), kem_pk: toHex(device.kemPk), pop,
        }, { signal });
      } catch (e) {
        throw mapPortError(e);
      }
      const r = object(raw);
      if (r.collection_id !== collection || r.device_id !== device.device || !Number.isSafeInteger(r.enrolled_at)) throw bad("enrol");
    } finally {
      wipeRecoveryDevice(device);
    }
  }
}

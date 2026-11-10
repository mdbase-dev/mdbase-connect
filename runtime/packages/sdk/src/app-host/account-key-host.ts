/** Account-key (AK1) unlock of ONE adopted Private collection on a first-party
 * installation device. Runs in the owned Worker. Reaches only the fixed status,
 * challenge and fetch routes over the installation bearer; the fetch proof is
 * signed by the native device. Setup, password change, strict mode and
 * recovery-device enrolment are refused here, not routed.
 * `R` and the password are never stored and never returned: `R` lives in a
 * RAM-only store for this one call and is wiped when it settles. The sealed
 * bundle is never persisted or returned either; the owner of a locked
 * collection may keep that ciphertext in RAM between attempts
 * ({@link AppAccountKeySealedBundle}), so a mistyped secret does not spend the
 * account's fetch budget again. */
import { loopbackHttpOrigin } from "../application/local-build.js";
import { AccountKeyError, checkPassword, parseRecoveryKey, wipe, type Argon2idRunner } from "../account-key.js";
import { uuidToBytes } from "../codec.js";
import {
  PrivateAccount, mapPortError, memorySecretStore, type AccountKeyControlPort, type AccountKeyMode, type AccountKeyReplicaPort,
  type PrivateAccountRequestOptions,
} from "../private-account.js";
import { appServerBody, appServerProblem } from "./cp-problem.js";
import { waitForOpenRetry } from "./open-wait.js";
import { AppAccountKeyProofUnavailableError, AppStrictDeviceApprovalError, type AppAccountKeyState } from "./wasm-runtime.js";

/** What the person typed. Strings cannot be wiped in JavaScript: callers drop
 * their references at once and never log, store or publish them. */
export type AppAccountKeySecret = Readonly<{password: string}> | Readonly<{recoveryKey: string}>;
/** Why an unlock ended without a keyed device. The collection stays locked and
 * usable for another attempt; each code has plain copy in `describeError`. */
export type AppAccountKeyUnlockProblem =
  /** Wrong encryption password, or a recovery key of another account key. */
  | "wrong_secret"
  /** The typed recovery key is not well formed. */
  | "invalid_recovery_key"
  /** The account has no account key: nothing to unlock with. */
  | "no_account_key"
  /** The account uses strict device approval: no password unlock exists. */
  | "unlock_strict"
  | "rate_limited"
  /** The account key service or the log could not be reached, or answered badly. */
  | "unavailable"
  /** This app runtime predates the account-key fetch proof signer. */
  | "unlock_unavailable"
  /** The secret is right, but this collection refused the grant (`detail`). */
  | "unlock_failed";
export class AppAccountKeyUnlockError extends Error {
  constructor(readonly reason: AppAccountKeyUnlockProblem, readonly detail?: string, readonly retryAfterMs?: number) {
    super(`app account key unlock: ${reason}`); this.name = "AppAccountKeyUnlockError";
  }
}
/** The authenticated installation session of the adopted Private device. */
export interface AppAccountKeySession {
  readonly accountId: string;
  readonly connectorId: string;
  readonly deviceId: string;
  readonly collection: string;
  readonly cpOrigin: string;
  isCurrent(): boolean;
  connectorBearer(options: {signal: AbortSignal}): Promise<string>;
}
/** The native device, narrowed to what an unlock may do. */
export interface AppAccountKeyNative {
  /** False when the pinned runtime has no account-key fetch signer. */
  supportsFetchProof(): boolean;
  /** The fixed `mdbase/v1/account-key-fetch` proof over a server challenge. */
  signFetch(challenge: Uint8Array): Uint8Array;
  /** Consumes and wipes the 32-byte loan on every path. */
  unlockConsuming(secret: Uint8Array): AppAccountKeyState;
  status(): AppAccountKeyState;
  /** One foreground log turn. */
  drive(options: {signal: AbortSignal}): Promise<void>;
  /** The log head the replica knows; 0 until a log turn has succeeded. */
  headKnown(): number;
}
export interface AppAccountKeyHostOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly allowLoopbackHttp?: boolean;
  /** Off-thread Argon2id; the default runs in this Worker. */
  readonly argon2id?: Argon2idRunner;
  /** How long a started self-grant may stay pending before the call gives up
   * (the grant itself is not withdrawn). */
  readonly settleMs?: number;
}
type HeldSession = Pick<AppAccountKeySession, "accountId" | "connectorId" | "deviceId">;
/** The sealed account-key bundle that ONE locked Private collection keeps
 * between unlock attempts, so a mistyped password or a recovery key of another
 * account key does not spend the account-wide fetch budget (10 per hour, shared
 * with the person's other devices) again. It is the ciphertext Connect already
 * gave this device, held in RAM only: never persisted, published or returned
 * to the app. A held answer is used only while the budget-free status route,
 * which applies the same account and installation scope checks on every
 * attempt, still reports the same account-key version and key id for the same
 * account, connector and device. Anything else drops it and fetches afresh.
 * `unlockPrivateDevice` drops it on every outcome but a wrong secret; the
 * owner clears it when the collection closes (which is also sign-out). */
export class AppAccountKeySealedBundle {
  private held: Readonly<HeldSession & {version: number; keyId: string; bundle: string}> | null = null;
  /** True while a sealed bundle is held. */
  get holding(): boolean { return this.held !== null; }
  /** The held fetch answer for exactly this account-key state, else nothing
   * (and whatever was held is dropped). An unknown version or key id never matches.
   * @internal */
  take(session: HeldSession, version: number | null, keyId: string | null): Record<string, unknown> | null {
    const h = this.held;
    if (h && version !== null && keyId !== null && h.accountId === session.accountId && h.connectorId === session.connectorId && h.deviceId === session.deviceId
      && h.version === version && h.keyId === keyId) return {mode: "password", version: h.version, key_id: h.keyId, bundle: h.bundle};
    this.held = null; return null;
  }
  /** Replaces what is held with this fetch answer when it is a well-formed
   * password bundle, and with nothing otherwise.
   * @internal */
  keep(session: HeldSession, answer: unknown): void {
    this.held = null;
    const r = answer && typeof answer === "object" && !Array.isArray(answer) ? answer as Record<string, unknown> : {};
    if (r.mode !== "password" || !Number.isSafeInteger(r.version) || (r.version as number) < 1 || typeof r.key_id !== "string" || !HEX32.test(r.key_id)
      || typeof r.bundle !== "string" || !/^([0-9a-f]{2}){1,512}$/.test(r.bundle)) return;
    this.held = Object.freeze({accountId: session.accountId, connectorId: session.connectorId, deviceId: session.deviceId, version: r.version as number, keyId: r.key_id, bundle: r.bundle});
  }
  clear(): void { this.held = null; }
}

const MAX_BODY = 64 * 1024, REQUEST_MS = 15_000, SETTLE_MS = 45_000;
const unavailable = (reason: string) => new AccountKeyError("unavailable", "The account key service refused or was unreachable.", {reason});
const cancelled = () => new AccountKeyError("cancelled", "Account key request cancelled.");
const unsupported = () => unavailable("not_supported");
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
const HEX32 = /^[0-9a-f]{64}$/;

/** `AccountKeyControlPort` over the installation bearer: status, challenge and
 * fetch only. One fixed request each, no retry, bounded decoded bodies. */
export class AppCpAccountKeyControl implements AccountKeyControlPort {
  readonly accountId: string;
  private readonly lifetime = new AbortController();
  private readonly origin: string;
  private readonly deviceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly session: AppAccountKeySession, private readonly sign: (challenge: Uint8Array) => Uint8Array, options: AppAccountKeyHostOptions = {}) {
    for (const id of [session.accountId, session.connectorId, session.deviceId, session.collection]) if (uuidToBytes(id).every(v => v === 0)) throw unavailable("binding");
    const u = new URL(session.cpOrigin);
    if (u.origin !== session.cpOrigin || u.username || u.password || (u.protocol !== "https:" && !(options.allowLoopbackHttp === true && loopbackHttpOrigin(session.cpOrigin)))) throw unavailable("binding");
    this.accountId = session.accountId; this.deviceId = session.deviceId; this.origin = u.origin;
    this.fetchImpl = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
    if (session.isCurrent() !== true) throw unavailable("fenced");
  }
  private check(signal: AbortSignal): void {
    if (signal.aborted || this.lifetime.signal.aborted) throw cancelled();
    let current = false; try { current = this.session.isCurrent() === true && this.session.accountId === this.accountId && this.session.deviceId === this.deviceId && this.session.cpOrigin === this.origin; } catch { current = false; }
    if (!current) throw unavailable("fenced");
  }
  private async request(method: "GET" | "POST", path: "/v1/next/account-key/status" | "/v1/next/account-key" | "/v1/next/devices/challenge",
    headers: Readonly<Record<string, string>>, options: PrivateAccountRequestOptions): Promise<Record<string, unknown>> {
    const parent = options.signal ?? this.lifetime.signal; this.check(parent);
    const bearer = await this.session.connectorBearer({signal: parent}); this.check(parent);
    if (typeof bearer !== "string" || !bearer || bearer.length > 16384 || /[^\x21-\x7e]/.test(bearer)) throw unavailable("binding");
    const ctrl = new AbortController(), abort = () => ctrl.abort(), timer = setTimeout(abort, REQUEST_MS); (timer as {unref?: () => void}).unref?.();
    parent.addEventListener("abort", abort, {once: true}); this.lifetime.signal.addEventListener("abort", abort, {once: true});
    const buffer = new Uint8Array(MAX_BODY); let count = 0, response: Response | null = null, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const request = this.fetchImpl;
      try {
        response = await request(`${this.origin}${path}`, {method, headers: {authorization: `Bearer ${bearer}`, ...headers}, signal: ctrl.signal, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer"});
      } catch { this.check(parent); throw unavailable("network"); }
      this.check(parent); if (ctrl.signal.aborted) throw unavailable("timeout");
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try { part = await reader.read(); } catch { this.check(parent); throw unavailable("network"); }
          try { this.check(parent); if (ctrl.signal.aborted) throw unavailable("timeout"); if (part.done) break;
            if (count + part.value.length > buffer.length) { ctrl.abort(); throw unavailable("response"); } buffer.set(part.value, count); count += part.value.length; }
          finally { part.value?.fill(0); }
        }
      }
      const body = appServerBody(buffer.subarray(0, count));
      // The typed refusal object (status, code, retry delay) is read by PrivateAccount.
      if (!response.ok) throw appServerProblem(response.status, body, response.headers);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw unavailable("response");
      return body as Record<string, unknown>;
    } finally {
      buffer.fill(0); void (reader?.cancel() ?? response?.body?.cancel())?.catch(() => {}); try { reader?.releaseLock(); } catch { /* cancelled */ }
      clearTimeout(timer); parent.removeEventListener("abort", abort); this.lifetime.signal.removeEventListener("abort", abort);
    }
  }
  status(options: PrivateAccountRequestOptions): Promise<unknown> { return this.request("GET", "/v1/next/account-key/status", {}, options); }
  challenge(options: PrivateAccountRequestOptions): Promise<unknown> { return this.request("POST", "/v1/next/devices/challenge", {}, options); }
  /** A fresh single-use challenge, the native fetch proof over it, then the
   * bundle. The challenge and signature are wiped here; the bundle is returned
   * to PrivateAccount only. */
  async fetch(options: PrivateAccountRequestOptions): Promise<unknown> {
    let nonce: Uint8Array | null = null, signature: Uint8Array | null = null;
    try {
      const issued = await this.request("POST", "/v1/next/devices/challenge", {}, options);
      const text = issued.challenge, expires = issued.expires_at;
      if (typeof text !== "string" || !/^[0-9a-f]{64}$/.test(text) || typeof expires !== "number" || !Number.isSafeInteger(expires) || expires - this.now() <= 5_000 || expires - this.now() > 16 * 60_000) throw unavailable("response");
      nonce = Uint8Array.from(text.match(/../g)!.map(v => parseInt(v, 16)));
      try { signature = this.sign(nonce); }
      catch (error) {
        if (error instanceof AppAccountKeyProofUnavailableError) throw unavailable(error.reason);
        if (error instanceof AppStrictDeviceApprovalError) throw new AccountKeyError("strict_mode", "The account is in strict mode.");
        throw unavailable("proof");
      }
      if (!(signature instanceof Uint8Array) || signature.length !== 64) throw unavailable("proof");
      return await this.request("GET", "/v1/next/account-key", {"x-mdbase-device-id": this.deviceId, "x-mdbase-challenge": text, "x-mdbase-signature": hex(signature)}, options);
    } finally { nonce?.fill(0); signature?.fill(0); }
  }
  put(): Promise<unknown> { return Promise.reject(unsupported()); }
  strict(): Promise<unknown> { return Promise.reject(unsupported()); }
  enrolRecoveryDevice(): Promise<unknown> { return Promise.reject(unsupported()); }
  close(): void { this.lifetime.abort(); }
}

function problem(error: unknown): AppAccountKeyUnlockError | null {
  if (error instanceof AppAccountKeyUnlockError) return error;
  if (error instanceof AppStrictDeviceApprovalError) return new AppAccountKeyUnlockError("unlock_strict");
  if (error instanceof AppAccountKeyProofUnavailableError) return new AppAccountKeyUnlockError("unlock_unavailable");
  if (!(error instanceof AccountKeyError)) return null;
  switch (error.code) {
    case "wrong_secret": return new AppAccountKeyUnlockError("wrong_secret");
    case "invalid_recovery_key": return new AppAccountKeyUnlockError("invalid_recovery_key", error.reason);
    case "no_account_key": return new AppAccountKeyUnlockError("no_account_key");
    case "strict_mode": return new AppAccountKeyUnlockError("unlock_strict");
    case "rate_limited": return new AppAccountKeyUnlockError("rate_limited", undefined, error.retryAfterMs);
    case "cancelled": return null;
    default: return error.reason === "account_key_proof_unavailable" ? new AppAccountKeyUnlockError("unlock_unavailable")
      : new AppAccountKeyUnlockError("unavailable", error.reason ?? error.code, error.retryAfterMs);
  }
}

/** Which of the three states the account key is in: a password is set, strict,
 * or none. Only `mode` is read. Connect answers an installation with less than
 * it answers the account's own devices (no strict `complete`/`pending`
 * witnesses, which are the account's inventory), so nothing else in the body
 * is required or trusted here. An unknown mode is a refusal, never a guess. */
async function accountKeyMode(control: AppCpAccountKeyControl, signal: AbortSignal): Promise<AccountKeyMode> {
  return (await accountKeyStatus(control, signal)).mode;
}
/** The mode, with the account-key version and key id when the answer carries
 * them well formed. Those two decide only whether a held sealed bundle is still
 * the current one: absent or malformed is "not known" (fetch afresh), never a
 * refusal and never a grant. */
async function accountKeyStatus(control: AppCpAccountKeyControl, signal: AbortSignal): Promise<Readonly<{mode: AccountKeyMode; version: number | null; keyId: string | null}>> {
  let raw: unknown;
  try { raw = await control.status({signal}); } catch (error) { throw mapPortError(error); }
  if (signal.aborted) throw cancelled();
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}, mode = r.mode;
  if (mode !== "password" && mode !== "strict" && mode !== "none") throw unavailable("response");
  return {mode, version: Number.isSafeInteger(r.version) && (r.version as number) >= 1 ? r.version as number : null,
    keyId: typeof r.key_id === "string" && HEX32.test(r.key_id) ? r.key_id : null};
}

/** The account-key mode from the status route (no bundle, no proof, not on the
 * fetch budget). A failed read rejects: the mode is never guessed. */
export async function readAccountKeyMode(session: AppAccountKeySession, options: AppAccountKeyHostOptions & {signal: AbortSignal}): Promise<AccountKeyMode> {
  const control = new AppCpAccountKeyControl(session, () => { throw unavailable("proof"); }, options);
  try { return await accountKeyMode(control, options.signal); }
  catch (error) { if (options.signal.aborted) throw error; throw problem(error) ?? error; }
  finally { control.close(); }
}

/** Unlock this device's ONE adopted Private collection with the account key.
 * Resolves only once the native applied policy has this device keyed and
 * trusted. A typed `AppAccountKeyUnlockError` leaves the collection locked and
 * open for another attempt; anything else is a lost owner or cancelled call. */
export async function unlockPrivateDevice(session: AppAccountKeySession, native: AppAccountKeyNative, secret: AppAccountKeySecret,
  options: AppAccountKeyHostOptions & {signal: AbortSignal; onMode?(mode: AccountKeyMode): void;
    /** This locked collection's holder for the sealed bundle between attempts. Without one, every attempt fetches. */
    sealed?: AppAccountKeySealedBundle}): Promise<void> {
  const signal = options.signal, settleMs = options.settleMs ?? SETTLE_MS, sealed = options.sealed;
  const password = "password" in secret, recovery = "recoveryKey" in secret;
  if (password === recovery || typeof (password ? secret.password : (secret as {recoveryKey: string}).recoveryKey) !== "string" || !Number.isSafeInteger(settleMs) || settleMs < 1)
    throw new AppAccountKeyUnlockError("unavailable", "binding");
  const current = () => { if (signal.aborted) throw cancelled(); if (session.isCurrent() !== true) throw unavailable("fenced"); };
  current();
  // Keyed already (an earlier grant applied): nothing to fetch or derive.
  if (native.status().state === "keyed") { sealed?.clear(); return; }
  // What can be told from the typed secret alone is refused here, before any
  // request: it costs no status read and no bundle fetch, and leaves a held
  // bundle as it was. A mistyped recovery key is not a recovery key. A password
  // outside the length policy every sealed bundle was made under opens none.
  if (recovery) { try { wipe(parseRecoveryKey((secret as {recoveryKey: string}).recoveryKey)); } catch (error) { throw problem(error) ?? error; } }
  else { try { checkPassword((secret as {password: string}).password); } catch { throw new AppAccountKeyUnlockError("wrong_secret"); } }
  let refusal: string | undefined, lost: {error: unknown} | null = null;
  const replica: AccountKeyReplicaPort = {
    privateCollections: async () => [session.collection],
    keyAccountKeyDevice: () => Promise.reject(unsupported()),
    async selfGrantWithAccountKey(collectionId, r, request) {
      const turn = request.signal ?? signal;
      try {
        current(); if (collectionId !== session.collection || !(r instanceof Uint8Array) || r.length !== 32) throw unavailable("binding");
        // The native call consumes its own copy; PrivateAccount wipes `r`.
        const loan = new Uint8Array(r); let state: AppAccountKeyState;
        try { state = native.unlockConsuming(loan); } finally { loan.fill(0); }
        const until = Date.now() + settleMs; let delay = 100;
        while (state.state === "pending") {
          if (Date.now() >= until) { refusal = "grant_pending"; throw unavailable("grant_pending"); }
          await native.drive({signal: turn}); current();
          state = native.status();
          if (state.state !== "pending") break;
          await waitForOpenRetry(delay, turn); current(); delay = Math.min(1_000, delay * 2);
        }
        if (state.state === "refused") { refusal = state.reason; throw unavailable(state.reason); }
      } catch (error) {
        // PrivateAccount folds a failed collection into `incomplete`; keep what
        // actually happened. Only a typed native refusal or a pending grant is
        // a problem the person can retry: the rest ended this owner.
        if (refusal === undefined) lost = {error};
        throw error;
      }
    },
  };
  const control = new AppCpAccountKeyControl(session, challenge => native.signFetch(challenge), options);
  let known: Awaited<ReturnType<typeof accountKeyStatus>> | null = null;
  // The bundle route is asked only when this collection holds no sealed bundle
  // for the account-key version and key id the status read of THIS attempt reported.
  const port: AccountKeyControlPort = !sealed ? control : {
    accountId: control.accountId,
    status: request => control.status(request), challenge: request => control.challenge(request),
    async fetch(request) {
      const held = sealed.take(session, known?.version ?? null, known?.keyId ?? null);
      if (held) return held;
      const answer = await control.fetch(request); sealed.keep(session, answer); return answer;
    },
    put: () => control.put(), strict: () => control.strict(), enrolRecoveryDevice: () => control.enrolRecoveryDevice(), close: () => control.close(),
  };
  const secrets = memorySecretStore();
  const account = new PrivateAccount({control: port, replica, secrets, ...(options.argon2id ? {argon2id: options.argon2id} : {})});
  try {
    known = await accountKeyStatus(control, signal); current();
    const mode = known.mode;
    try { options.onMode?.(mode); } catch { /* display observer does not own the unlock */ }
    if (mode === "none") throw new AppAccountKeyUnlockError("no_account_key");
    if (mode === "strict") throw new AppAccountKeyUnlockError("unlock_strict");
    if (!native.supportsFetchProof()) throw new AppAccountKeyUnlockError("unlock_unavailable");
    // The native unlock reads control items up to the head it knows.
    if (native.headKnown() <= 0) { await native.drive({signal}); current(); }
    if (native.headKnown() <= 0) throw new AppAccountKeyUnlockError("unavailable", "log_head_unknown");
    const result = await account.unlock(secret, signal);
    const ended = lost as {error: unknown} | null;
    if (ended) throw ended.error;
    current();
    if (result.incomplete?.length) throw new AppAccountKeyUnlockError(refusal === "grant_pending" ? "unavailable" : "unlock_failed", refusal ?? "incomplete");
    if (native.status().state !== "keyed") throw new AppAccountKeyUnlockError("unlock_failed", "not_keyed");
    sealed?.clear();
  } catch (error) {
    // Only a wrong secret leaves the sealed bundle for the next attempt.
    if (!(error instanceof AccountKeyError && error.code === "wrong_secret") || signal.aborted || session.isCurrent() !== true) sealed?.clear();
    if (signal.aborted || session.isCurrent() !== true) throw error;
    throw problem(error) ?? error;
  } finally {
    // RAM-only `R` is wiped on every path; the facade keeps nothing else.
    try { await secrets.clear(); } finally { account.close(); }
  }
}

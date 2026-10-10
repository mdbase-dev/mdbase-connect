/**
 * The account key (AK1, account-key bundle design):
 * the user's account secret `R` (their recovery key), sealed under their encryption
 * password for the control plane to store and hand back to a signed-in device.
 *
 * Byte-for-byte the Rust `mdbn-replica` `crypto::account_key` and `crypto::recovery`
 * modules; `conformance/crypto/account-key/` and `conformance/crypto/recovery-key/`
 * pin both.
 *
 * ```text
 * key_id = H("mdbase/v1/account-key-id", R)
 * kek    = Argon2id(NFKC(password), salt, m_kib, t, p, out = 32)
 * aad    = H("mdbase/v1/account-key-bundle", cbor[1, account, key_id, kdf])
 * ct     = XChaCha20-Poly1305(kek, nonce, R, aad)
 * bundle = cbor{0: 1, 1: kdf, 2: nonce, 3: ct, 4: key_id}
 * kdf    = [1 (Argon2id v1.3), m_kib, t, p, salt(16)]
 * ```
 *
 * The control plane never sees `R` or the password. KDF parameters come from the
 * (untrusted) bundle, so they are bounded both ways before any memory is allocated.
 * Secrets are `Uint8Array`s wiped after use (best effort; JS strings cannot be wiped).
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesEqual, decode, encode, structMap, type CborValue } from "./cbor.js";

// ------------------------------------------------------------------ errors

/** Why an account-key operation failed. Never carries secret material. */
export type AccountKeyErrorCode =
  /** The password is too short, too long, or (in the facade) too weak. */
  | "weak_password"
  /** Wrong password or recovery key (authentication failed after the KDF), or a recovery key for another account key. */
  | "wrong_secret"
  /** A typed recovery key is not well formed (prefix, length, character or check). */
  | "invalid_recovery_key"
  /** KDF parameters outside the bounds a client will run. */
  | "params"
  /** Not a well-formed, canonical v1 bundle. */
  | "encoding"
  /** The control plane limited this account's fetches or writes. */
  | "rate_limited"
  /** The account is in strict mode: no account key exists. */
  | "strict_mode"
  /** The account has no account key yet. */
  | "no_account_key"
  /** The caller's signal aborted. */
  | "cancelled"
  /** The account key changed underneath this operation (version conflict); fetch and retry. */
  | "conflict"
  /** This account key is already set up (setup refused). */
  | "already_set_up"
  /** The operation needs the key unlocked on this device first. */
  | "locked"
  /** The control plane or replica refused or was unreachable; the local state is unchanged. */
  | "unavailable"
  /** An invalid response or an SDK bug. */
  | "internal";

export class AccountKeyError extends Error {
  readonly code: AccountKeyErrorCode;
  /** A machine-readable detail: `too_short`, `too_long`, `strength`, `wrong_prefix`, `checksum`, …, or a control-plane error code. */
  readonly reason?: string;
  readonly retryAfterMs?: number;
  constructor(code: AccountKeyErrorCode, message: string, extra: { reason?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "AccountKeyError";
    this.code = code;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

const err = (code: AccountKeyErrorCode, message: string, reason?: string) =>
  new AccountKeyError(code, message, reason === undefined ? {} : { reason });

// ------------------------------------------------------------------ hashing

const utf8 = new TextEncoder();

/** `H(tag, m) = SHA-256(u8(len(tag)) ‖ tag ‖ m)` (`00-overview.md` §4). */
export function domainHash(tag: string, m: Uint8Array): Uint8Array {
  const t = utf8.encode(tag);
  if (t.length > 255) throw err("internal", "domain tag longer than 255 bytes");
  return sha256(concat(Uint8Array.of(t.length), t, m));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Constant-time equality for short secrets. */
function ctEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

/** Wipe a secret buffer (best effort). */
export function wipe(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}

/** Random bytes from the platform CSPRNG. Hosts may inject their own in tests. */
export type Entropy = (n: number) => Uint8Array;
export const platformEntropy: Entropy = (n) => crypto.getRandomValues(new Uint8Array(n));

// ------------------------------------------------------------------ UUIDs

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidBytes(id: string): Uint8Array {
  if (!UUID.test(id)) throw err("internal", "not a UUID");
  const hex = id.replace(/-/g, "").toLowerCase();
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function uuidText(b: Uint8Array): string {
  let h = "";
  for (const x of b) h += x.toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ------------------------------------------------------------------ recovery key

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const PREFIX = "MDB1";
const SECRET_LEN = 32;
const CHECK_LEN = 2;
const BODY_CHARS = 55; // ceil(34 * 8 / 5)

/** A fresh account secret `R`. */
export function generateRecoveryKey(entropy: Entropy = platformEntropy): Uint8Array {
  const r = entropy(SECRET_LEN);
  if (r.length !== SECRET_LEN) throw err("internal", "entropy returned the wrong length");
  return r;
}

function check(secret: Uint8Array): Uint8Array {
  return domainHash("mdbase/v1/recovery-key-check", secret).subarray(0, CHECK_LEN);
}

/**
 * The text to show once and have the user write down:
 * `MDB1-XXXXX-…` (Crockford base32 of `R ‖ check`, 55 characters in groups of five).
 */
export function formatRecoveryKey(secret: Uint8Array): string {
  if (secret.length !== SECRET_LEN) throw err("internal", "recovery secret is 32 bytes");
  const raw = concat(secret, check(secret));
  let body = "";
  let acc = 0;
  let bits = 0;
  for (const b of raw) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      body += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) body += ALPHABET[(acc << (5 - bits)) & 31];
  wipe(raw);
  return [PREFIX, ...(body.match(/.{1,5}/g) as string[])].join("-");
}

/**
 * Parse what the user typed or pasted. Case, spaces and dashes don't matter, and the
 * Crockford look-alikes `O`→`0`, `I`/`L`→`1` are accepted. The check catches typos
 * only; it is not a secret.
 */
export function parseRecoveryKey(input: string): Uint8Array {
  if (typeof input !== "string" || input.length > 4096) throw err("invalid_recovery_key", "Not a recovery key.", "wrong_length");
  let s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!s.startsWith(PREFIX)) throw err("invalid_recovery_key", "A recovery key starts with MDB1.", "wrong_prefix");
  s = s.slice(PREFIX.length);
  if (s.length !== BODY_CHARS) throw err("invalid_recovery_key", "A recovery key has 55 characters after MDB1.", "wrong_length");
  const raw = new Uint8Array(SECRET_LEN + CHECK_LEN);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw err("invalid_recovery_key", "A recovery key uses only Crockford base32 characters.", "bad_character");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      if (o < raw.length) raw[o++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  // 55 × 5 = 275 bits: 272 data bits and 3 zero padding bits (one spelling per key).
  if (o !== raw.length || acc !== 0) throw err("invalid_recovery_key", "Not a recovery key.", "bad_character");
  const secret = raw.slice(0, SECRET_LEN);
  const ok = ctEq(check(secret), raw.subarray(SECRET_LEN));
  wipe(raw);
  if (!ok) {
    wipe(secret);
    throw err("invalid_recovery_key", "The recovery key has a typo (check failed).", "checksum");
  }
  return secret;
}

/** The recovery device a recovery key derives for one collection (`sealed-envelope.md` §5.4). */
export interface RecoveryDevice {
  /** `first 16 bytes of H("mdbase/v1/recovery-id", collection ‖ sign_pk)`, as a UUID. */
  device: string;
  /** Ed25519 seed (secret). */
  signSeed: Uint8Array;
  signPk: Uint8Array;
  /** X25519 private key (secret). */
  kemSk: Uint8Array;
  kemPk: Uint8Array;
  /** The recovery device has no Noise key: 32 zero bytes. */
  noisePk: Uint8Array;
}

/**
 * Derive this collection's recovery device from `R`:
 * `seed = HKDF-SHA256(ikm = R, salt = collection, info = "mdbase/v1/recovery-sign" | "-kem")`.
 */
export function deriveRecoveryDevice(secret: Uint8Array, collection: string): RecoveryDevice {
  if (secret.length !== SECRET_LEN) throw err("internal", "recovery secret is 32 bytes");
  const c = uuidBytes(collection);
  const signSeed = hkdf(sha256, secret, c, utf8.encode("mdbase/v1/recovery-sign"), 32);
  const kemSk = hkdf(sha256, secret, c, utf8.encode("mdbase/v1/recovery-kem"), 32);
  const signPk = ed25519.getPublicKey(signSeed);
  const kemPk = x25519.getPublicKey(kemSk);
  const device = uuidText(domainHash("mdbase/v1/recovery-id", concat(c, signPk)).subarray(0, 16));
  return { device, signSeed, signPk, kemSk, kemPk, noisePk: new Uint8Array(32) };
}

/** Sign with the recovery device (the proof of possession for enrolment, AK1 §5.3). */
export function recoverySign(d: RecoveryDevice, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, d.signSeed);
}

/** Wipe a derived recovery device's secrets. */
export function wipeRecoveryDevice(d: RecoveryDevice): void {
  wipe(d.signSeed, d.kemSk);
}

// ------------------------------------------------------------------ proof key (AK1 §5.2, Connect #635)

/**
 * The account key's proof signer: `seed = HKDF-SHA256(ikm = R, salt = account, info =
 * "mdbase/v1/account-key-proof")`, an Ed25519 key registered with the bundle. Replacing
 * a bundle (change password, recover) must be signed by it, so a signed-in device alone
 * cannot overwrite the bundle with junk.
 */
export interface AccountKeyProof {
  /** Ed25519 seed (secret). */
  seed: Uint8Array;
  pk: Uint8Array;
}

export function deriveAccountKeyProof(secret: Uint8Array, account: string): AccountKeyProof {
  if (secret.length !== SECRET_LEN) throw err("internal", "recovery secret is 32 bytes");
  const seed = hkdf(sha256, secret, uuidBytes(account), utf8.encode("mdbase/v1/account-key-proof"), 32);
  return { seed, pk: ed25519.getPublicKey(seed) };
}

/** `H("mdbase/v1/account-key-rewrap", cbor[account, sha256(bundle), expected_version])`, signed by the proof key. */
export function accountKeyRewrapDigest(account: string, bundleBytes: Uint8Array, expectedVersion: number): Uint8Array {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw err("internal", "expected_version");
  return domainHash("mdbase/v1/account-key-rewrap", encode([uuidBytes(account), sha256(bundleBytes), expectedVersion]));
}

export function signAccountKeyRewrap(proof: AccountKeyProof, account: string, bundleBytes: Uint8Array, expectedVersion: number): Uint8Array {
  return ed25519.sign(accountKeyRewrapDigest(account, bundleBytes, expectedVersion), proof.seed);
}

// ------------------------------------------------------------------ bundle

export const BUNDLE_VERSION = 1;
export const KDF_ARGON2ID = 1;
export const MAX_BUNDLE_BYTES = 512;
/** Minimum password length, in Unicode scalar values after NFKC. */
export const MIN_PASSWORD_CHARS = 12;
/** Maximum password length, in UTF-8 bytes before and after NFKC. */
export const MAX_PASSWORD_BYTES = 1024;

/** v1 defaults: within the 32 MiB mobile/webview budget. */
export const DEFAULT_KDF = { mKib: 19_456, t: 3, p: 1 } as const;
/** Parameters a client will run, whatever a bundle says (checked before allocating). */
const MIN_M_KIB = 19_456;
const MAX_M_KIB = 24_576;
const MIN_T = 2;
const MAX_T = 10;
const MAX_P = 4;

export interface KdfParams {
  /** Memory in KiB. */
  mKib: number;
  /** Passes. */
  t: number;
  /** Lanes. */
  p: number;
  /** 16 random bytes. */
  salt: Uint8Array;
}

export interface Bundle {
  kdf: KdfParams;
  /** 24 bytes. */
  nonce: Uint8Array;
  /** `R` sealed: 32 + 16 bytes. */
  ct: Uint8Array;
  /** `keyId(R)`. */
  keyId: Uint8Array;
}

/** The public id of an account key: which `R` a bundle wraps. */
export function keyId(secret: Uint8Array): Uint8Array {
  return domainHash("mdbase/v1/account-key-id", secret);
}

const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function checkKdfParams(k: KdfParams): void {
  const ok = uint(k.mKib) && uint(k.t) && uint(k.p)
    && k.mKib >= MIN_M_KIB && k.mKib <= MAX_M_KIB && k.t >= MIN_T && k.t <= MAX_T && k.p >= 1 && k.p <= MAX_P
    && k.mKib >= 8 * k.p && k.salt instanceof Uint8Array && k.salt.length === 16;
  if (!ok) throw err("params", "Unsupported key derivation parameters.");
}

function kdfCbor(k: KdfParams): CborValue {
  return [KDF_ARGON2ID, k.mKib, k.t, k.p, k.salt];
}

function kdfFromCbor(v: CborValue): KdfParams {
  if (!Array.isArray(v) || v.length !== 5) throw err("encoding", "Not an account key bundle.");
  const [alg, m, t, p, salt] = v;
  if (!uint(alg) || !uint(m) || !uint(t) || !uint(p) || !(salt instanceof Uint8Array) || salt.length !== 16) {
    throw err("encoding", "Not an account key bundle.");
  }
  if (alg !== KDF_ARGON2ID || m > 0xffff_ffff || t > 0xffff_ffff || p > 0xffff_ffff) throw err("params", "Unsupported key derivation parameters.");
  return { mKib: m, t, p, salt };
}

/** Canonical encoding. */
export function encodeBundle(b: Bundle): Uint8Array {
  return encode(structMap([
    [0, BUNDLE_VERSION],
    [1, kdfCbor(b.kdf)],
    [2, b.nonce],
    [3, b.ct],
    [4, b.keyId],
  ]));
}

/** Strict decoding: canonical bytes only, bounded size, exact shape. */
export function decodeBundle(bytes: Uint8Array): Bundle {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BUNDLE_BYTES) throw err("encoding", "Not an account key bundle.");
  let v: CborValue;
  try {
    v = decode(bytes);
  } catch {
    throw err("encoding", "Not an account key bundle.");
  }
  if (!(v instanceof Map) || v.size !== 5 || [...v.keys()].join() !== "0,1,2,3,4") throw err("encoding", "Not an account key bundle.");
  const m = v as Map<number, CborValue>;
  const nonce = m.get(2);
  const ct = m.get(3);
  const id = m.get(4);
  if (m.get(0) !== BUNDLE_VERSION || !(nonce instanceof Uint8Array) || nonce.length !== 24
    || !(ct instanceof Uint8Array) || ct.length !== 48 || !(id instanceof Uint8Array) || id.length !== 32) {
    throw err("encoding", "Not an account key bundle.");
  }
  const b: Bundle = { kdf: kdfFromCbor(m.get(1) as CborValue), nonce, ct, keyId: id };
  if (!bytesEqual(encodeBundle(b), bytes)) throw err("encoding", "Not an account key bundle.");
  return b;
}

// ------------------------------------------------------------------ password

/** NFKC, bounded before and after normalisation; at least 12 scalar values. */
export function normalizePassword(password: string): Uint8Array {
  if (typeof password !== "string") throw err("weak_password", "The password is required.", "too_short");
  if (utf8.encode(password).length > MAX_PASSWORD_BYTES) throw err("weak_password", "The password is too long.", "too_long");
  const n = password.normalize("NFKC");
  const bytes = utf8.encode(n);
  if (bytes.length > MAX_PASSWORD_BYTES) throw err("weak_password", "The password is too long.", "too_long");
  if ([...n].length < MIN_PASSWORD_CHARS) {
    wipe(bytes);
    throw err("weak_password", `The password needs at least ${MIN_PASSWORD_CHARS} characters.`, "too_short");
  }
  return bytes;
}

/** Length policy only (the strength meter is `passwordStrength`). */
export function checkPassword(password: string): void {
  wipe(normalizePassword(password));
}

// ------------------------------------------------------------------ KDF

/**
 * Runs Argon2id. Hosts replace the default to move the work off the UI thread (a
 * Worker, or native code); the result must equal RFC 9106 Argon2id v1.3 with the
 * given cost and a 32-byte output. Parameters are already bounded when called.
 */
export type Argon2idRunner = (
  password: Uint8Array,
  salt: Uint8Array,
  params: { mKib: number; t: number; p: number },
  signal?: AbortSignal,
) => Promise<Uint8Array>;

/**
 * The default runner: noble's asynchronous Argon2id on the calling thread, yielding to
 * the event loop and cancelling at the next progress tick after `signal` aborts. It
 * blocks UI frames between ticks; browser and native hosts should supply a Worker.
 */
export const inlineArgon2id: Argon2idRunner = async (password, salt, params, signal) => {
  const aborted = () => err("cancelled", "Key derivation cancelled.");
  if (signal?.aborted) throw aborted();
  try {
    return await argon2idAsync(password, salt, {
      t: params.t,
      m: params.mKib,
      p: params.p,
      dkLen: 32,
      version: 0x13,
      maxmem: MAX_M_KIB * 1024 + (1 << 20),
      asyncTick: 20,
      onProgress: () => {
        if (signal?.aborted) throw aborted();
      },
    });
  } catch (e) {
    if (e instanceof AccountKeyError) throw e;
    throw err("params", "Key derivation failed.");
  }
};

async function kek(password: string, kdf: KdfParams, run: Argon2idRunner, signal?: AbortSignal): Promise<Uint8Array> {
  checkKdfParams(kdf);
  const pw = normalizePassword(password);
  try {
    const out = await run(pw, kdf.salt, { mKib: kdf.mKib, t: kdf.t, p: kdf.p }, signal);
    if (!(out instanceof Uint8Array) || out.length !== 32) throw err("internal", "The KDF runner returned the wrong length.");
    return out;
  } finally {
    wipe(pw);
  }
}

function aad(account: string, id: Uint8Array, kdf: KdfParams): Uint8Array {
  return domainHash("mdbase/v1/account-key-bundle", encode([BUNDLE_VERSION, uuidBytes(account), id, kdfCbor(kdf)]));
}

export interface SealOptions {
  /** Default: the v1 cost with a fresh salt. */
  kdf?: KdfParams;
  /** Default: 24 random bytes. */
  nonce?: Uint8Array;
  entropy?: Entropy;
  argon2id?: Argon2idRunner;
  signal?: AbortSignal;
}

/** Seal `secret` under `password` for `account`. */
export async function sealBundle(secret: Uint8Array, password: string, account: string, options: SealOptions = {}): Promise<Bundle> {
  if (secret.length !== SECRET_LEN) throw err("internal", "recovery secret is 32 bytes");
  checkPassword(password);
  const entropy = options.entropy ?? platformEntropy;
  const kdf: KdfParams = options.kdf ?? { ...DEFAULT_KDF, salt: entropy(16) };
  const nonce = options.nonce ?? entropy(24);
  if (nonce.length !== 24) throw err("internal", "nonce is 24 bytes");
  const id = keyId(secret);
  const k = await kek(password, kdf, options.argon2id ?? inlineArgon2id, options.signal);
  try {
    const ct = xchacha20poly1305(k, nonce, aad(account, id, kdf)).encrypt(secret);
    return { kdf, nonce, ct, keyId: id };
  } finally {
    wipe(k);
  }
}

export interface OpenOptions {
  argon2id?: Argon2idRunner;
  signal?: AbortSignal;
}

/** Open a bundle with `password` for `account`; checks the key id of what it opens. */
export async function openBundle(b: Bundle, password: string, account: string, options: OpenOptions = {}): Promise<Uint8Array> {
  const k = await kek(password, b.kdf, options.argon2id ?? inlineArgon2id, options.signal);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(k, b.nonce, aad(account, b.keyId, b.kdf)).decrypt(b.ct);
  } catch {
    throw err("wrong_secret", "Wrong password.");
  } finally {
    wipe(k);
  }
  if (plain.length !== SECRET_LEN || !ctEq(keyId(plain), b.keyId)) {
    wipe(plain);
    throw err("wrong_secret", "Wrong password.");
  }
  return plain;
}

/** Accept a typed recovery key as the account key of `bundle` (forgotten password). */
export function checkRecoveryKey(secret: Uint8Array, b: Bundle): void {
  if (secret.length !== SECRET_LEN || !ctEq(keyId(secret), b.keyId)) throw err("wrong_secret", "This recovery key belongs to a different account key.");
}

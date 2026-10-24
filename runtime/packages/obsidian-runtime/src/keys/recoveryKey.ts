/**
 * The recovery key for private collections is offered at setup, skippable, and
 * recommended; `open-questions.md` Q20 describes a paper key that acts as an
 * `escrow`-kind device the user holds.
 *
 * This module owns only the **user-facing format**: 32 random bytes from the
 * CSPRNG, written as Crockford base32 with a 2-byte check, in groups of five:
 *
 *     MDB1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
 *
 * Deriving the recovery device's signing and KEM keys from the secret, enrolling
 * it, and using it to key a new device are the runtime's job (Rust). The check
 * catches typos before anything is derived;
 * it is not a secret and adds no security.
 *
 * The check is the first two bytes of `H("mdbase/v1/recovery-key-check", secret)`.
 * The tag must be registered in `00-overview.md` §4.
 */

import { concat, domainHash } from "../util/hash.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const PREFIX = "MDB1";
const SECRET_LEN = 32;
const CHECK_LEN = 2;

/** Why a typed recovery key was refused. */
export type RecoveryKeyProblem = "wrong_prefix" | "wrong_length" | "bad_character" | "checksum";

/** Thrown by {@link parseRecoveryKey}. */
export class RecoveryKeyError extends Error {
  constructor(readonly problem: RecoveryKeyProblem) {
    super(`invalid recovery key: ${problem}`);
    this.name = "RecoveryKeyError";
  }
}

/** A fresh 32-byte recovery secret from the platform CSPRNG. */
export function newRecoverySecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_LEN));
}

async function check(secret: Uint8Array): Promise<Uint8Array> {
  return (await domainHash("mdbase/v1/recovery-key-check", secret)).slice(0, CHECK_LEN);
}

function base32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string, nbytes: number): Uint8Array | null {
  const out = new Uint8Array(nbytes);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      if (o < nbytes) out[o++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  // The last character's padding bits must be zero, so each key has one spelling.
  return o === nbytes && acc === 0 ? out : null;
}

const BODY_CHARS = Math.ceil(((SECRET_LEN + CHECK_LEN) * 8) / 5); // 55

/** Format a secret for display and printing. */
export async function formatRecoveryKey(secret: Uint8Array): Promise<string> {
  if (secret.length !== SECRET_LEN) throw new Error("recovery secret is 32 bytes");
  const body = base32(concat(secret, await check(secret)));
  const groups = body.match(/.{1,5}/g)!;
  return [PREFIX, ...groups].join("-");
}

/**
 * Parse what the user typed or pasted. Case, spaces and dashes don't matter, and
 * the Crockford look-alikes `O`→`0`, `I`/`L`→`1` are accepted.
 */
export async function parseRecoveryKey(input: string): Promise<Uint8Array> {
  let s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!s.startsWith(PREFIX)) throw new RecoveryKeyError("wrong_prefix");
  s = s.slice(PREFIX.length);
  if (s.length !== BODY_CHARS) throw new RecoveryKeyError("wrong_length");
  const raw = unbase32(s, SECRET_LEN + CHECK_LEN);
  if (!raw) throw new RecoveryKeyError("bad_character");
  const secret = raw.slice(0, SECRET_LEN);
  const want = await check(secret);
  if (want[0] !== raw[SECRET_LEN] || want[1] !== raw[SECRET_LEN + 1]) throw new RecoveryKeyError("checksum");
  return secret;
}

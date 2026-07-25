import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Forty bits of human-readable entropy, grouped only for transcription. */
export function randomUserCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += USER_CODE_ALPHABET[byte & 31];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function canonicalUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

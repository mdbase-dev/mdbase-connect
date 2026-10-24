/**
 * Embedded WASM loading (shared runtime asset).
 *
 * Obsidian installs only `main.js`, `manifest.json` and `styles.css`, so
 * `runtime.wasm` (and sqlite-wasm) are embedded in `main.js` as base64 of the
 * gzipped bytes. Table-driven decoding avoids intermediate binary strings and
 * per-character callbacks when loading the embedded runtime asset; it works on
 * the string's char codes directly.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** char code → 6-bit value; 255 = not in the alphabet; 254 = padding. */
const TABLE: Uint8Array = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  // URL-safe variants decode too.
  t["-".charCodeAt(0)] = 62;
  t["_".charCodeAt(0)] = 63;
  t["=".charCodeAt(0)] = 254;
  return t;
})();

/** Thrown for input that is not base64. */
export class Base64Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Base64Error";
  }
}

/**
 * Decode standard (or URL-safe) base64. Whitespace is not allowed (embedded
 * strings are generated without it). Padding is optional.
 */
export function decodeBase64(s: string): Uint8Array {
  let len = s.length;
  // Strip padding.
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--;
  if (s.length - len > 2) throw new Base64Error("too much padding");
  const rem = len & 3;
  if (rem === 1) throw new Base64Error("truncated input");
  const outLen = ((len >> 2) * 3) + (rem === 0 ? 0 : rem - 1);
  const out = new Uint8Array(outLen);
  const t = TABLE;
  let o = 0;
  let i = 0;
  const full = len - rem;
  for (; i < full; i += 4) {
    const a = t[s.charCodeAt(i) & 0xff]!;
    const b = t[s.charCodeAt(i + 1) & 0xff]!;
    const c = t[s.charCodeAt(i + 2) & 0xff]!;
    const d = t[s.charCodeAt(i + 3) & 0xff]!;
    if ((a | b | c | d) > 63 || (s.charCodeAt(i) | s.charCodeAt(i + 1) | s.charCodeAt(i + 2) | s.charCodeAt(i + 3)) > 0xff) {
      throw new Base64Error(`invalid character near offset ${i}`);
    }
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (rem > 0) {
    const a = t[s.charCodeAt(i) & 0xff]!;
    const b = t[s.charCodeAt(i + 1) & 0xff]!;
    const c = rem === 3 ? t[s.charCodeAt(i + 2) & 0xff]! : 0;
    if ((a | b | c) > 63) throw new Base64Error(`invalid character near offset ${i}`);
    const n = (a << 18) | (b << 12) | (c << 6);
    out[o++] = n >> 16;
    if (rem === 3) out[o++] = (n >> 8) & 0xff;
  }
  return out;
}

/** Encode bytes as standard padded base64 (used by the vault journal and tests). */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 0x3000; // multiple of 3
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    let s = "";
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      s += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
    }
    if (i < end) {
      const b1 = i + 1 < end ? bytes[i + 1]! : 0;
      const n = (bytes[i]! << 16) | (b1 << 8);
      s += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]!;
      s += i + 1 < end ? ALPHABET[(n >> 6) & 63]! + "=" : "==";
    }
    parts.push(s);
  }
  return parts.join("");
}

/** Gunzip with the platform's `DecompressionStream` (Chromium 80+, Node 18+). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** What an embedded asset looks like in the generated bundle. */
export interface EmbeddedAsset {
  /** base64 of the (optionally gzipped) bytes. */
  readonly b64: string;
  /** `true` when `b64` holds gzip. */
  readonly gzip: boolean;
  /** Raw length, checked after decoding. */
  readonly rawLength: number;
}

/** Decode an embedded asset to its raw bytes, checking the length. */
export async function decodeAsset(asset: EmbeddedAsset): Promise<Uint8Array> {
  const packed = decodeBase64(asset.b64);
  const raw = asset.gzip ? await gunzip(packed) : packed;
  if (raw.length !== asset.rawLength) {
    throw new Error(`embedded asset length ${raw.length}, expected ${asset.rawLength}`);
  }
  return raw;
}

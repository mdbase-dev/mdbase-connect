/** Hashing per `00-overview.md` §4, over WebCrypto. */

const enc = new TextEncoder();

/** Concatenate byte strings. */
export function concat(...parts: Uint8Array[]): Uint8Array {
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

/** SHA-256 of `m`. */
export async function sha256(m: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", m as BufferSource));
}

/** `H(tag, m) = SHA-256(u8(len(tag)) ‖ tag ‖ m)`. */
export async function domainHash(tag: string, m: Uint8Array): Promise<Uint8Array> {
  const t = enc.encode(tag);
  if (t.length > 255) throw new Error("tag too long");
  return sha256(concat(Uint8Array.of(t.length), t, m));
}

/** Lowercase hex. */
export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Parse a canonical UUID string to 16 bytes. */
export function uuidBytes(uuid: string): Uint8Array {
  const h = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(h)) throw new Error(`not a UUID: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

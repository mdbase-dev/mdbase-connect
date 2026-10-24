/**
 * App sessions on the hosted Worker (`replica-client-api.md` §12.3): an app connects
 * to the hosted replica directly over a WebSocket and runs Noise IK with it.
 *
 * 1. The first message is the 64-byte prologue in clear:
 *    `"mdbase/v1/client" ‖ collection ‖ grant ID ‖ target device ID`. It must name
 *    this collection, a non-zero grant and this hosted device.
 * 2. Noise message 1 carries the `hello` request frame; message 2 its response.
 * 3. Then Noise transport messages carry the byte stream of `u32be(length) ‖ frame`.
 *
 * Pure helpers here; the Durable Object wires them to the engine, which holds the
 * Noise state in RAM, and to live admission, which it re-checks synchronously
 * immediately before every hello, call and output.
 */
import type { LiveHostedEvidence } from "./admission/live-admission.ts";

export const PROLOGUE_TAG = new TextEncoder().encode("mdbase/v1/client");
/** Noise transport plaintext per message (65,535 − 16-byte tag). */
export const MAX_PLAINTEXT = 65_519;
/** Largest frame an app may send the hosted replica. */
export const MAX_APP_FRAME = 1 << 20;
/** App sessions per DO (handshaking or open). */
export const MAX_APP_SESSIONS = 32;
/** Reassembly bytes held across all of a DO's app sessions. */
export const MAX_APP_BUFFERED = 8 << 20;
/** App WebSockets per DO, including ones still before their prologue. */
export const MAX_APP_SOCKETS = 64;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const uuidString = (b: Uint8Array) =>
  hex(b).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
export const uuidBytes = (u: string) => Uint8Array.from(u.replace(/-/g, "").match(/../g)!, (h) => parseInt(h, 16));

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The prologue's grant (UUID) when it binds this collection and device, else null. */
export function parsePrologue(p: Uint8Array, collection: string, device: string): string | null {
  if (p.length !== 64 || !equal(p.subarray(0, 16), PROLOGUE_TAG)) return null;
  if (!equal(p.subarray(16, 32), uuidBytes(collection)) || !equal(p.subarray(48, 64), uuidBytes(device))) return null;
  const grant = p.subarray(32, 48);
  if (grant.every((x) => x === 0)) return null;
  return uuidString(grant);
}

/** Reassembles `u32be(length) ‖ frame` records from transport plaintexts. */
export class FrameReader {
  private buf = new Uint8Array(0);

  /** Bytes held for an incomplete frame. */
  get buffered(): number {
    return this.buf.length;
  }

  /** Wipe and drop anything held (session end). */
  wipe(): void {
    this.buf.fill(0);
    this.buf = new Uint8Array(0);
  }

  /** Complete frames, or null when a frame is too large (close the session). Every
   * intermediate copy is wiped, including on refusal. */
  push(bytes: Uint8Array): Uint8Array[] | null {
    const all = new Uint8Array(this.buf.length + bytes.length);
    const out: Uint8Array[] = [];
    let ok = false;
    try {
      all.set(this.buf, 0);
      all.set(bytes, this.buf.length);
      this.buf.fill(0);
      let off = 0;
      while (all.length - off >= 4) {
        const n = new DataView(all.buffer, all.byteOffset + off, 4).getUint32(0);
        if (n > MAX_APP_FRAME) return null;
        if (all.length - off - 4 < n) break;
        out.push(all.slice(off + 4, off + 4 + n));
        off += 4 + n;
      }
      this.buf = all.slice(off);
      if (this.buf.length > MAX_APP_FRAME + 4) return null;
      ok = true;
      return out;
    } finally {
      all.fill(0);
      if (!ok) {
        for (const f of out) f.fill(0);
        this.wipe();
      }
    }
  }
}

/** One frame as transport plaintexts of at most MAX_PLAINTEXT bytes. */
export function frameChunks(frame: Uint8Array): Uint8Array[] {
  const rec = new Uint8Array(4 + frame.length);
  new DataView(rec.buffer).setUint32(0, frame.length);
  rec.set(frame, 4);
  const out: Uint8Array[] = [];
  for (let off = 0; off < rec.length; off += MAX_PLAINTEXT) out.push(rec.subarray(off, off + MAX_PLAINTEXT));
  return out;
}

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(v as number));

/** The engine's encoded live admission as bridge evidence, or null on Deny. */
export function evidence(encoded: unknown): LiveHostedEvidence | null {
  if (!Array.isArray(encoded) || encoded[0] !== 1 && encoded[0] !== 1n) return null;
  const m = encoded[1] as Map<number, unknown>;
  if (!(m instanceof Map)) return null;
  const bytes = (k: number) => m.get(k) as Uint8Array;
  const head = (k: number) => {
    const [seq, chain] = m.get(k) as [unknown, Uint8Array];
    return { seq: big(seq), chain };
  };
  return {
    kind: "verified",
    collection: uuidString(bytes(0)),
    device: uuidString(bytes(1)),
    signPk: bytes(2),
    kemPk: bytes(3),
    noisePk: bytes(4),
    wake: big(m.get(5)),
    generation: big(m.get(6)),
    epoch: big(m.get(7)),
    applied: head(8),
    authenticated: head(9),
    rootId: uuidString(bytes(10)),
    rootPk: bytes(11),
    controlChain: bytes(12),
    keyDeliveryDevice: uuidString(bytes(13)),
    keyDeliverySeq: big(m.get(14)),
  };
}

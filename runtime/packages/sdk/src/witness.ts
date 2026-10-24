/**
 * Head witnesses (log-entry.md §11): "the SDK passes on witnesses between the
 * replicas it talks to". Each remote `hello-result` may carry the replica's latest
 * signed witness. The SDK keeps them for the life of the JS process and hands them to
 * every other replica of the same collection it connects to, so a log service that
 * forks or withholds a tail is caught when two devices meet through one thin client.
 *
 * The SDK can't verify signatures (it holds no device keys); replicas do. So a
 * malicious replica must neither push out genuine witnesses nor fill the store with
 * fake devices:
 * - a witness is accepted only from a session whose replica device the transport
 *   authenticated (the Noise target on relay, IPC and the localhost link), and only
 *   the witness for **that** device;
 * - sessions with an unknown device (in-process) are not trusted to vouch for
 *   anything: their witnesses are dropped (fail closed);
 * - one slot per device, newest seq wins; at most `MAX_DEVICES` per collection.
 * Witnesses are opaque: never re-encoded; only the device and seq are parsed.
 */
import { decode, toHex } from "./cbor.js";

export const MAX_DEVICES = 64;

/** collection → claimed device → source → [seq, exact bytes] */
const store = new Map<string, Map<string, Map<string, [number, Uint8Array]>>>();

function peek(b: Uint8Array): { device: string; seq: number } | null {
  try {
    const m = decode(b);
    if (!(m instanceof Map)) return null;
    const device = (m as Map<number, unknown>).get(2);
    const seq = (m as Map<number, unknown>).get(3);
    if (!(device instanceof Uint8Array) || typeof seq !== "number") return null;
    return { device: toHex(device), seq };
  } catch {
    return null;
  }
}

/** A device ID as the lowercase hex of its 16 bytes (UUID text or hex accepted). */
function normalizeDevice(d: string): string {
  return d.replace(/-/g, "").toLowerCase();
}

/** Remember a witness a replica gave us; `source` is that replica's authenticated device. */
export function rememberWitness(collection: string, witness: Uint8Array, source?: string): void {
  // Fail closed: only an authenticated replica device may vouch, and only for itself.
  if (!source) return;
  const p = peek(witness);
  if (!p) return;
  if (normalizeDevice(source) !== p.device) return;
  let byDevice = store.get(collection);
  if (!byDevice) store.set(collection, (byDevice = new Map()));
  let slots = byDevice.get(p.device);
  if (!slots) {
    if (byDevice.size >= MAX_DEVICES) return;
    byDevice.set(p.device, (slots = new Map()));
  }
  const key = "self";
  const cur = slots.get(key);
  if (!cur || cur[0] < p.seq) slots.set(key, [p.seq, witness]);
}

/** Witnesses to pass to a replica, excluding those claiming its own device. */
export function witnessesFor(collection: string, own?: Uint8Array): Uint8Array[] {
  const ownDevice = own ? peek(own)?.device : undefined;
  const out: Uint8Array[] = [];
  for (const [d, slots] of store.get(collection) ?? []) {
    if (d === ownDevice) continue;
    for (const [, b] of slots.values()) out.push(b);
  }
  return out;
}

/** Tests only. */
export function _clearWitnesses(): void {
  store.clear();
}

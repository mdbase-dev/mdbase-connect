/**
 * Self-heal for a cached store built under control-plane keys this deployment
 * does not pin (older keys, or older code without the attribution witness). The
 * DO store is a cache of the log. On exactly that open refusal, and nothing
 * else, the host drops the cache once per pin set and rebuilds it from the log.
 * If the state rebuilt from the log fails the same check, the log itself was not
 * built under the pins: the DO parks (no alarm) and logs its collection tag.
 */

/** The one native open refusal that qualifies (`OpenError::Mismatch`). */
export const PIN_MISMATCH = 'hosted engine open: Mismatch("store was built under control-plane keys that are not pinned")';
/** Digest of the pins the cache was last dropped for. */
export const PIN_RESET_KEY = "service-pin-reset";

export class PinParked extends Error {
  constructor() { super("hosted_pin_parked"); }
}

export function isPinMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === PIN_MISMATCH;
}

export async function pinsDigest(pins: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode("mdbase-hosted-pins-v1:");
  const input = new Uint8Array(prefix.length + pins.length);
  input.set(prefix); input.set(pins, prefix.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Operator log line: the wake-observe collection tag, never the raw ID. */
export function pinLog(tag: string, role: "hosted" | "escrow", phase: "pin_reset" | "pin_rebuilt" | "pin_parked"): void {
  if (!/^[0-9a-f]{24}$/.test(tag)) return;
  try {
    console.warn(JSON.stringify({ event: "next_service_pin", at: new Date().toISOString(), collection_tag: tag, role, phase }));
  } catch { /* Logging is not authority. */ }
}

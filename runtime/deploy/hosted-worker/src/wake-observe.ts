import { boundedAppendObservation, type AppendObservation } from "./append-observe.ts";
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";

/** Correlation only, never an authority/admission input. No raw collection IDs. */
export async function wakeCollectionTag(collection: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mdbase-service-wake-v1:${collection}`)));
  return Array.from(hash.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Engine emitted a key-grant append request, not evidence of append acceptance. */
export function hasGrantAppend(frame: Uint8Array): boolean {
  if (frame.length > 64 << 10) return false;
  try {
    const request = decode(frame) as Map<number, CborValue>;
    if (!(request instanceof Map) || request.get(2) !== "append") return false;
    const params = request.get(3) as Map<number, CborValue>;
    const items = params instanceof Map ? params.get(3) : null;
    return Array.isArray(items) && items.some((bytes) => {
      if (!(bytes instanceof Uint8Array)) return false;
      const item = decode(bytes) as Map<number, CborValue>;
      return item instanceof Map && item.get(1) === 4;
    });
  } catch { return false; }
}
export function wakeLog(tag: string, role: "hosted" | "escrow", phase: "wake_received" | "activation_complete" | "grant_emitted" | "grant_append_outcome", observation?: AppendObservation): void {
  if (!/^[0-9a-f]{24}$/.test(tag)) return;
  try { console.info(JSON.stringify({ event: "next_service_wake", at: new Date().toISOString(), collection_tag: tag, role, phase, ...(observation ? boundedAppendObservation(observation) : {}) })); } catch { /* Logging is not authority. */ }
}

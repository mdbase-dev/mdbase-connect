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
/** LAB correlation: the first 4 bytes (hex) of each key-grant recipient device in the frame, at most 8. */
export function grantRecipients(frame: Uint8Array): string[] {
  if (frame.length > 64 << 10) return [];
  try {
    const request = decode(frame) as Map<number, CborValue>;
    const params = request instanceof Map ? request.get(3) as Map<number, CborValue> : null;
    const items = params instanceof Map ? params.get(3) : null;
    if (!Array.isArray(items)) return [];
    const out: string[] = [];
    for (const bytes of items) {
      if (!(bytes instanceof Uint8Array)) continue;
      const item = decode(bytes) as Map<number, CborValue>;
      if (!(item instanceof Map) || item.get(1) !== 4 || !(item.get(11) instanceof Uint8Array)) continue;
      const payload = decode(item.get(11) as Uint8Array) as Map<number, CborValue>;
      const recipient = payload instanceof Map ? payload.get(1) : null;
      if (recipient instanceof Uint8Array && recipient.length === 16) out.push(Array.from(recipient.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(""));
      if (out.length >= 8) break;
    }
    return out;
  } catch { return []; }
}
export function wakeLog(tag: string, role: "hosted" | "escrow", phase: "wake_received" | "activation_complete" | "grant_emitted" | "grant_append_outcome", observation?: AppendObservation, recipients?: string[]): void {
  if (!/^[0-9a-f]{24}$/.test(tag)) return;
  try { console.info(JSON.stringify({ event: "next_service_wake", at: new Date().toISOString(), collection_tag: tag, role, phase, ...(recipients?.length ? { recipients } : {}), ...(observation ? boundedAppendObservation(observation) : {}) })); } catch { /* Logging is not authority. */ }
}
/** Engine catch-up diagnostics (`hd_catchup_facts`): numbers and flags only. */
export type CatchupFacts = { applied: number; headKnown: number; caughtUp: boolean; grantWaiting: boolean; grantDue: boolean };
/** One alarm or activation invocation, as the host saw it at its end. */
export type InvocationSample = {
  kind: "alarm" | "activate";
  role: "hosted" | "escrow";
  /** No engine when the invocation began (it opened one, or failed to). */
  cold: boolean;
  /** Applied position when the invocation began (or right after its cold open). */
  startApplied: number | null;
  facts: CatchupFacts | null;
  serving: boolean | null;
  installing: boolean | null;
  /** Engine's next wakeup and the stored alarm, as absolute host ms. */
  nextWakeup: number | null;
  alarm: number | null;
  started: number;
  now: number;
};
/** LAB only (connect#1850): one `hosted_invocation` line per alarm or activation,
 * tagged for correlation with the same collection's wake and grant lines. Positions,
 * counts, flags and deltas only; no identifiers beyond the salted tag. Nothing is
 * logged outside LAB or without a valid tag. */
export function invocationLog(lab: boolean, tag: string | null, s: InvocationSample): void {
  if (!lab || !tag || !/^[0-9a-f]{24}$/.test(tag)) return;
  const f = s.facts;
  const from = s.startApplied;
  try {
    console.info(JSON.stringify({
      event: "hosted_invocation", collection_tag: tag, role: s.role, kind: s.kind, cold: s.cold,
      engine: f !== null,
      applied: f?.applied ?? null,
      log_head: f?.headKnown ?? null,
      behind: f ? Math.max(0, f.headKnown - f.applied) : null,
      applied_this_invocation: f && from !== null ? Math.max(0, f.applied - from) : null,
      serving: s.serving, caught_up: f?.caughtUp ?? null, installing: s.installing,
      grant_waiting: f?.grantWaiting ?? null, grant_due: f?.grantDue ?? null,
      next_wakeup_ms: s.nextWakeup === null ? null : s.nextWakeup - s.now,
      alarm_ms: s.alarm === null ? null : s.alarm - s.now,
      elapsed_ms: Math.max(0, s.now - s.started),
    }));
  } catch { /* Logging is not authority. */ }
}

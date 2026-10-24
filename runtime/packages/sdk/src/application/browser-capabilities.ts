/** Upfront browser capability probe for the application entry.
 *
 * The SDK needs a small set of modern browser features before it can register,
 * spawn its Worker or keep keys and replicas on the device. Below that floor
 * (old Safari/Firefox, private browsing), failing later and piecemeal gives
 * raw TypeErrors; this probe runs once, before any registration, Worker, key
 * or storage allocation, and the entry reports a single typed problem on the
 * existing `unavailable` phase instead.
 *
 * Feature detection only — no version or user-agent sniffing, so future
 * browsers pass by construction. The probe itself uses none of the features
 * it gates, never throws, and writes nothing: the X25519 check generates a
 * throwaway key that is never stored, and the storage check only asks for the
 * (lazily created) OPFS root directory, which private browsing rejects. */

export type BrowserCapabilityProblem = "browser_unsupported" | "application_storage_unavailable";

export type BrowserCapabilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: BrowserCapabilityProblem; readonly missing: readonly string[] };

/** The narrow slice of the browser the probe reads. Tests fake it. */
export interface BrowserCapabilityEnvironment {
  /** `crypto.subtle` (secure contexts only), or undefined where absent. */
  readonly subtle?: { generateKey(algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<unknown> } | undefined;
  readonly abortSignalAny: boolean;
  readonly randomUUID: boolean;
  readonly worker: boolean;
  readonly messageChannel: boolean;
  readonly locks: boolean;
  readonly broadcastChannel: boolean;
  readonly indexedDB: boolean;
  /** `navigator.storage.getDirectory`, present as a function where OPFS exists. */
  readonly getDirectory?: (() => Promise<unknown>) | undefined;
}

function read<T>(get: () => T): T | undefined {
  try { return get(); } catch { return undefined; }
}

/** The real page environment. Every read is guarded: hostile or partial
 * globals read as absent, never as a thrown error. */
export function defaultBrowserCapabilityEnvironment(): BrowserCapabilityEnvironment {
  const subtle = read(() => (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) as
    BrowserCapabilityEnvironment["subtle"];
  const storage = read(() => (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage);
  const getDirectory = read(() => (typeof storage?.getDirectory === "function"
    ? () => (storage.getDirectory as () => Promise<unknown>).call(storage)
    : undefined));
  return {
    subtle,
    abortSignalAny: read(() => typeof AbortSignal === "function" && typeof (AbortSignal as { any?: unknown }).any === "function") === true,
    randomUUID: read(() => typeof (globalThis as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID === "function") === true,
    worker: read(() => typeof Worker === "function") === true,
    messageChannel: read(() => typeof MessageChannel === "function") === true,
    locks: read(() => typeof (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks?.request === "function") === true,
    broadcastChannel: read(() => typeof BroadcastChannel === "function") === true,
    indexedDB: read(() => typeof (globalThis as { indexedDB?: unknown }).indexedDB !== "undefined") === true,
    getDirectory,
  };
}

/** Probe the browser once. `missing` carries stable developer tokens (never
 * shown to people): feature absences under `browser_unsupported`, or the
 * OPFS rejection under `application_storage_unavailable` (the shape private
 * browsing takes on an otherwise current browser). */
export async function probeBrowserCapabilities(
  env: BrowserCapabilityEnvironment = defaultBrowserCapabilityEnvironment(),
): Promise<BrowserCapabilityResult> {
  const missing: string[] = [];
  if (!env.subtle) missing.push("web_crypto");
  if (!env.abortSignalAny) missing.push("abort_signal_any");
  if (!env.randomUUID) missing.push("random_uuid");
  if (!env.worker) missing.push("worker");
  if (!env.messageChannel) missing.push("message_channel");
  if (!env.locks) missing.push("web_locks");
  if (!env.broadcastChannel) missing.push("broadcast_channel");
  if (!env.indexedDB) missing.push("indexed_db");
  if (env.subtle) {
    // The exact operation grant/Noise key custody needs later; a throwaway key.
    try { await env.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]); }
    catch { missing.push("x25519"); }
  }
  if (missing.length) return { ok: false, problem: "browser_unsupported", missing: Object.freeze(missing) };
  if (typeof env.getDirectory !== "function") {
    return { ok: false, problem: "application_storage_unavailable", missing: Object.freeze(["opfs"]) };
  }
  try { await env.getDirectory(); }
  catch { return { ok: false, problem: "application_storage_unavailable", missing: Object.freeze(["opfs"]) }; }
  return { ok: true };
}

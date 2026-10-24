/** Hosted-first handover candidate. No guessed keys, witness decoding-as-trust,
 * current-generation substitution or Saved/physical durability implication. */
import type { MdbaseClient } from "../client.js";
import type { FramePort } from "../transport/port.js";
import type { ConfirmedHead } from "../wire.js";
import type { AppHandoverSource, AppWasmRuntime } from "./wasm-runtime.js";

export interface AppHandoverOptions {
  runtime: AppWasmRuntime;
  /** EXACT same runtime port backing localClient, after its authorized hello. */
  localPort: FramePort;
  localClient: Pick<MdbaseClient, "hello" | "appliedPrefix">;
  hostedClient: Pick<MdbaseClient, "hello" | "authenticatedDevice">;
  source: AppHandoverSource;
  /** Account/install/selection/authority generation, NOT online status. */
  isCurrent(): boolean;
}
export interface AppVerifiedHandover {
  readonly head: Readonly<ConfirmedHead>;
  readonly appliedThrough: number;
  /** Revalidates local session/policy/retained prefix/owner scope. Hosted
   * connectivity is no longer required after capture; offline reads stay local. */
  isCurrent(): boolean;
  dispose(): void;
}
function equal(a: ConfirmedHead, b: ConfirmedHead): boolean {
  return a.seq === b.seq && a.chain === b.chain && a.policyGeneration === b.policyGeneration && a.catalogGeneration === b.catalogGeneration;
}
/** One explicit attempt, no hidden reconnect/retry or automatic provider switch.
 * Return null on any absence/fault/stale/signature/readiness/history failure. */
export async function verifyAppHandover(options: AppHandoverOptions, signal: AbortSignal): Promise<AppVerifiedHandover | null> {
  let witness: Uint8Array | null = null;
  try {
    const { runtime, localPort, localClient, hostedClient, source } = options;
    const hosted = hostedClient.hello, local = localClient.hello;
    const collection = source.collection, deviceId = source.deviceId;
    const authenticatedDevice = hostedClient.authenticatedDevice;
    const sameDevice = (id: string | undefined) => typeof id === "string" && id.replace(/-/g, "").toLowerCase() === deviceId.replace(/-/g, "").toLowerCase();
    if (!sameDevice(authenticatedDevice)) return null;
    const fact = hosted.status.confirmedHead;
    const captured = fact ? Object.freeze({ ...fact }) : undefined;
    if (!captured || !hosted.headWitness || hosted.headWitness.length > 64 * 1024 || captured.seq === 0 || hosted.collection !== collection || local.collection !== collection) return null;
    witness = new Uint8Array(hosted.headWitness);
    const owned = witness;
    const current = () => {
      try { return !signal.aborted && options.isCurrent() === true && source.isCurrent() === true && local.collection === collection && source.collection === collection && source.deviceId === deviceId && localClient.hello === local; } catch { return false; }
    };
    const ready = () => {
      try {
        const o = runtime.observations();
        return !o.requiresReopen && !o.keyringRebuilding && !o.keyringRebuildFailed && o.status.mode === "synced" && o.status.confirmedHead !== undefined && o.status.confirmedHead.seq >= captured.seq;
      } catch { return false; }
    };
    const native = () => {
      if (!current() || !ready()) return false;
      const verified = runtime.verifyHandover(localPort, source, owned);
      return verified !== null && equal(verified, captured);
    };
    const candidateCurrent = () => {
      try { return !signal.aborted && current() && hostedClient.hello === hosted && hostedClient.authenticatedDevice === authenticatedDevice; } catch { return false; }
    };
    if (!candidateCurrent() || !native()) return null;
    const prefix = await localClient.appliedPrefix(captured.seq, signal); // current READ, SDK retry:false.
    if (!candidateCurrent() || !native() || prefix.seq !== captured.seq || prefix.appliedThrough < captured.seq || prefix.chain !== captured.chain) return null;
    // Copy/freeze tuple: caller mutation of status/hello must not rewrite proof.
    const head = Object.freeze({ ...captured }); let disposed = false;
    const evidence: AppVerifiedHandover = {
      head, appliedThrough: prefix.appliedThrough,
      isCurrent: () => { if (disposed) return false; try { return native() && equal(head, captured); } catch { return false; } },
      dispose: () => { disposed = true; owned.fill(0); },
    };
    witness = null; // evidence owns only bounded public signed bytes, never keys.
    return evidence;
  } catch { return null; }
  finally { witness?.fill(0); }
}

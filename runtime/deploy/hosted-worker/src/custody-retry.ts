import { labCustodySubCause } from "./custody/hosted-custody.ts";

/** Custody refusals that carry no verdict: another scoped call held the custody
 * (it serves one call at a time, with no queue), or the CP/KMS round trips
 * outlasted one attempt's timeout. */
const TRANSIENT = new Set(["custody_unavailable", "custody_aborted"]);

/** Custody refusals that are a lasting verdict on the collection, not an outage:
 * this deployment's KMS or the control plane's routing does not give it to this
 * deployment, or the control plane no longer holds a service device for it
 * (deleted, left sync, not a current cloud copy). Retrying on a timer cannot
 * change the answer; only a new CP activation can. */
const PERMANENT = new Set(["custody_collection_not_allowed", "custody_collection_gone"]);

export function isPermanentCustodyRefusal(error: unknown): boolean {
  return error instanceof Error && PERMANENT.has(error.message);
}

export interface CustodyRetryOptions {
  /** Whole budget across attempts. */
  budgetMs?: number;
  /** One attempt's timeout (CP service device, token/unwrap, recheck). */
  attemptMs?: number;
  /** LAB: called before each retry with the refusal and its custody sub-cause. */
  onRetry?: (facts: { attempt: number; code: string; call: string | null; name: string | null; message: string | null }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Fetch a log token or sealer keys, retrying transient custody refusals within
 * one bounded budget. Both are inputs fetched before any request is sent, never
 * effects, so asking again cannot repeat a landed write. A refusal with a verdict
 * (changed identity, invalid record/token) or the budget's end is thrown as is. */
export async function withCustodyRetry<T>(fetch: (signal: AbortSignal) => Promise<T>, options: CustodyRetryOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const attemptMs = options.attemptMs ?? 20_000;
  const deadline = now() + (options.budgetMs ?? 45_000);
  for (let attempt = 1, delay = 250; ; attempt++, delay = Math.min(delay * 2, 4_000)) {
    const remaining = deadline - now();
    try { return await fetch(AbortSignal.timeout(Math.max(1, Math.min(attemptMs, remaining)))); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (!TRANSIENT.has(code) || now() + delay >= deadline) throw error;
      const cause = labCustodySubCause(error);
      try { options.onRetry?.({ attempt, code, call: cause?.call ?? null, name: cause?.name ?? null, message: cause?.message?.slice(0, 300) ?? null }); } catch { /* Logging is not authority. */ }
      await sleep(delay);
    }
  }
}

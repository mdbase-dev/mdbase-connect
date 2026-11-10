/**
 * Piggybacked log nonces, shared by the app HTTP log transport and the hosted
 * Worker (which loads this source directly, so it has no imports).
 *
 * Every signed-RPC response from the log Worker carries `x-mdbase-next-nonce`:
 * a nonce minted exactly like `GET /v1/nonce` (stateless, 60 s, single use per
 * collection actor, bound to a request only by the device signature). Using it
 * for the next RPC makes a steady-state call one request instead of two. A log
 * without the header leaves the pool empty and every call fetches a nonce.
 */
export const NEXT_NONCE_HEADER = "x-mdbase-next-nonce";
/** Server lifetime is 60 s; use a spare well inside that, leaving time to sign and send. */
const SPARE_NONCE_MS = 40_000;
/** A few, for concurrent RPCs; each spare is taken by exactly one later RPC. */
const SPARE_NONCES = 6;

/** 32 nonce bytes from their 64-character lowercase hex form, or null. */
export function nonceFromHex(text: string): Uint8Array | null {
  return /^[0-9a-f]{64}$/.test(text) ? Uint8Array.from(text.match(/../g)!.map(v => parseInt(v, 16))) : null;
}

/** A decoded ls-response refusing the nonce itself (`unauthenticated` with reason
 * `nonce` or `replay`). The log checks the nonce before dispatching anything, so
 * the request had no effect and is safe to send once more with a fresh nonce. */
export function nonceRefusal(response: unknown): boolean {
  if (!(response instanceof Map)) return false;
  const e: unknown = response.get(3);
  if (!(e instanceof Map)) return false;
  return e.get(0) === "unauthenticated" && (e.get(1) === "nonce" || e.get(1) === "replay");
}

/** Unused piggybacked nonces. In memory only: losing them costs one `GET /v1/nonce`. */
export class SpareNonces {
  private spares: { nonce: Uint8Array; at: number }[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  /** The newest fresh spare, removed from the pool (single use), or null. */
  take(): Uint8Array | null {
    for (let spare = this.spares.pop(); spare; spare = this.spares.pop()) {
      const age = this.now() - spare.at;
      if (age >= 0 && age < SPARE_NONCE_MS) return spare.nonce;
      spare.nonce.fill(0);
    }
    return null;
  }
  /** Keep a response's piggybacked nonce, if it carries a well-formed one. */
  keep(headers: Headers): void {
    const next = nonceFromHex(headers.get(NEXT_NONCE_HEADER) ?? "");
    if (!next) return;
    this.spares.push({ nonce: next, at: this.now() });
    while (this.spares.length > SPARE_NONCES) this.spares.shift()!.nonce.fill(0);
  }
}

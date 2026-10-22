/** One collection's CP-issued log token, reused while it has more than a minute
 * left. Every log round asks custody for a token; minting one each time cost
 * three control-plane calls (record, mint, record recheck) per round from every
 * idle actor (LAB: ~215 actors, ~1,000 CP calls/min, growing with accounts).
 *
 * RAM only, never persisted or logged. The holder drops it on any CP refusal or
 * verdict, retire/close, an engine reset, a CP activation (every committed policy
 * batch: enrolment, removal, rekey), and a log-service 401/403. */

/** Reuse only while more than this much lifetime remains. */
export const TOKEN_REUSE_MARGIN_MS = 60_000;
/** Held at most this long after the mint began, whatever the reply says:
 * the issuer's 15 minutes plus a minute of clock margin. */
export const TOKEN_MAX_HOLD_MS = 16 * 60_000;

export class LogTokenCache {
  #held: { token: string; since: number; until: number; tag: unknown } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** The held token for `tag` with more than the margin left, else null (and dropped). */
  get(tag: unknown): string | null {
    const held = this.#held;
    if (!held) return null;
    const now = this.now();
    if (held.tag !== tag || !Number.isSafeInteger(now) || now < held.since || held.until - now <= TOKEN_REUSE_MARGIN_MS) {
      this.#held = null;
      return null;
    }
    return held.token;
  }

  /** Hold a token minted by a call that began at `started` (local clock). */
  put(token: string, expiresAt: number, started: number, tag: unknown): void {
    if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(started)) { this.#held = null; return; }
    this.#held = { token, since: started, until: Math.min(expiresAt, started + TOKEN_MAX_HOLD_MS), tag };
  }

  drop(): void { this.#held = null; }
}

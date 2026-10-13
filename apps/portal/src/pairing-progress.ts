/** The app prepares its own device after account selection. The portal only
 * observes that SAME request; it never retries attestation or approval. */
export const PAIRING_PREPARATION_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;

export function watchPairingPreparation<T extends { attested?: boolean; approved_at: string | null }>(options: {
  read(signal: AbortSignal): Promise<T>;
  isDispatching(): boolean;
  onReady(pairing: T): void;
  onError(reason: unknown): void;
  onTimeout(): void;
}): () => void {
  const lifetime = new AbortController();
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout>;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(pollTimer);
    clearTimeout(deadline);
    lifetime.abort();
  };
  // Independent of the read: even a hung HTTP request cannot leave Preparing
  // on screen indefinitely. Cleanup fences late responses after timeout/retry.
  const deadline = setTimeout(() => { stop(); options.onTimeout(); }, PAIRING_PREPARATION_TIMEOUT_MS);
  const schedule = () => { pollTimer = setTimeout(() => void poll(), POLL_MS); };
  async function poll() {
    if (stopped) return;
    if (options.isDispatching()) { schedule(); return; }
    try {
      const pairing = await options.read(lifetime.signal);
      if (stopped) return;
      if (pairing.attested || pairing.approved_at) { stop(); options.onReady(pairing); }
      else schedule();
    } catch (reason) {
      if (!stopped) { stop(); options.onError(reason); }
    }
  }
  schedule();
  return stop;
}

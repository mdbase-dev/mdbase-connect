/** Next wake while a snapshot install runs. An install lives in engine memory and
 * starts over from its first chunk after an eviction, and one wake moves at most 64
 * chunks, so a longer gap made any install too big for one wake rewrite the same
 * rows forever. Well under the time an idle object survives. */
export const INSTALL_WAKE_MS = 1_000;
/** An object that keeps failing must not be retried every second for good. Only a
 * wake that failed waits longer: the first retry keeps INSTALL_WAKE_MS and each
 * further failure doubles it. Wakes that fail nothing stay at INSTALL_WAKE_MS, so
 * an install catching up after an eviction is not evicted again. Passing the
 * furthest chunk count that failed clears it. Persisted, because a long wait
 * evicts the object. */
const INSTALL_RETRY_CAP_MS = 5 * 60_000;
/** Doublings that reach the cap. */
export const INSTALL_RETRY_MAX_STEPS = 9;
export const installRetryMs = (failures: number) =>
  Math.min(INSTALL_RETRY_CAP_MS, INSTALL_WAKE_MS * 2 ** Math.min(Math.max(0, failures - 1), INSTALL_RETRY_MAX_STEPS));

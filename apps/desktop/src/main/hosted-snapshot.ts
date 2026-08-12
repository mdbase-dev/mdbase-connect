export interface HostedControlSnapshot {
  online: boolean;
  hosted_collections_available: boolean;
  hosted_collections: unknown[];
  grants: unknown[];
  pending_authorizations: unknown[];
}

const credentialStoreUnavailable = (error: unknown): boolean => (
  error instanceof Error
  && "code" in error
  && error.code === "credential_store_unavailable"
);

const offlineSnapshot = (): HostedControlSnapshot => ({
  online: false,
  hosted_collections_available: false,
  hosted_collections: [],
  grants: [],
  pending_authorizations: []
});

interface HostedSnapshotLoaderOptions {
  retryAfterMs?: number;
  now?: () => number;
}

/**
 * A hosted snapshot is status data, so a known unavailable credential store is
 * represented as an offline snapshot rather than a rejected Electron IPC call.
 * Repeated polls are served locally during a short retry cooldown. Other
 * failures remain visible to the renderer and preserve its last snapshot.
 */
export function createHostedSnapshotLoader(
  request: () => Promise<HostedControlSnapshot>,
  options: HostedSnapshotLoaderOptions = {}
): () => Promise<HostedControlSnapshot> {
  const retryAfterMs = options.retryAfterMs ?? 30_000;
  const now = options.now ?? Date.now;
  let retryAt = 0;
  let inFlight: Promise<HostedControlSnapshot> | undefined;

  return () => {
    if (now() < retryAt) return Promise.resolve(offlineSnapshot());
    if (inFlight) return inFlight;

    const pending = (async () => {
      try {
        const snapshot = await request();
        retryAt = 0;
        return snapshot;
      } catch (error) {
        if (!credentialStoreUnavailable(error)) throw error;
        retryAt = now() + retryAfterMs;
        return offlineSnapshot();
      }
    })();
    const tracked = pending.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  };
}

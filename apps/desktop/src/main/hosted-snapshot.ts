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

interface HostedSnapshotLoaderOptions {
  retryAfterMs?: number;
  now?: () => number;
}

/**
 * Preserve failure as failure, never manufacture an empty success. The renderer
 * owns last-known data. A credential error is cached only for a short cooldown,
 * replacing repeated keyring pressure without becoming a second data cache.
 */
export function createHostedSnapshotLoader(
  request: () => Promise<HostedControlSnapshot>,
  options: HostedSnapshotLoaderOptions = {}
): () => Promise<HostedControlSnapshot> {
  const retryAfterMs = options.retryAfterMs ?? 30_000;
  const now = options.now ?? Date.now;
  let retryAt = 0;
  let credentialError: unknown;
  let inFlight: Promise<HostedControlSnapshot> | undefined;

  return () => {
    if (now() < retryAt) return Promise.reject(credentialError);
    if (inFlight) return inFlight;

    const pending = (async () => {
      try {
        const snapshot = await request();
        retryAt = 0;
        credentialError = undefined;
        return snapshot;
      } catch (error) {
        if (!credentialStoreUnavailable(error)) throw error;
        retryAt = now() + retryAfterMs;
        credentialError = error;
        throw error;
      }
    })();
    const tracked = pending.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  };
}

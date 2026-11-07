## Changed

- The control plane now rechecks the newest policy batch of each collection that changed in the last 7 days every 5 minutes, and sweeps older policy history at one probe per poll (about an hour at current size) instead of continuously. Each probe is one exact-position read. Loss hints and fresh deliveries still go first. See `docs/next-policy-outbox.md`.

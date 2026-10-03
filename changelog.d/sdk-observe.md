## Added

- SDK `observe(query, options)` owns progressive live-query snapshots/deltas,
  batched changed-path rereads, capability-gated metadata membership and exact
  revisions, reset/gap reconciliation, cancellation and local-write overlays.
  Manual mode refreshes without watch. Replace collection synchronization
  workers, not domain indexes or draft/session logic; see `docs/sdk-observe.md`.
  Initial loads use full-row query pages, reserving metadata/document batches for
  deltas. Terminal pages no longer release an already consumed query/view cursor.

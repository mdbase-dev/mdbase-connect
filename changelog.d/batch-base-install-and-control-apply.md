## Fixed

- Eliminated redundant log reads and per-control-item durable commits during cold opens of collections with a generation-0 `base` snapshot: `request_read` no longer queues log reads while a snapshot or base install is in flight (preventing wave-7+ concurrency spillovers and duplicate tail downloads), generation-0 base installs skip the redundant `Install::Chain` read for seq 1, and control items share `apply_items`'s per-page deferred-durability window (publishing own approval dispositions and closing revoked sessions only after the durability barrier succeeds).

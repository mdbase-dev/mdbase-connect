## Breaking

- SDK: `snapshot.sync` is now one status object, `MdbaseSync`. `sync.state` is the one thing an indicator shows (`attention`, `saved_on_device`, `offline`, `reconnecting`, `saving`, `catching_up` or `saved`), with `connection`, `health`, `pending`, `pendingFor`, `writes`, `attention`, `conflicts`, `holds`, `incidents` and `live` beside it. It replaces `StatusSummary` and its `kind` and `text`. See `docs/sdk-sync-status.md`.
- SDK: `snapshot.writes` moved to `snapshot.sync.writes`.
- SDK: `summarizeStatus(status, problem, transport, live)` is replaced by `summarizeSync({ status, writes, link, problem, transport, live, online, pendingForMs, storageWarning })`. `StatusSummary` and `StatusKind` are removed; `MdbaseSync`, `SyncState`, `SyncAttention` and `SyncInput` are new.
- SDK: an unreachable, busy or rate-limited service now reads as `reconnecting`. `offline` is kept for a device with no network, which the entry also learns from the browser's `online` and `offline` events instead of waiting for a request to fail. Pending writes read as saved on this device as soon as the browser reports offline.
- SDK: `sync.pendingFor` says how long changes have been pending (`moment`, `while`, `long`), and subscribers are notified at two and at thirty seconds, so apps need no timer of their own to avoid a flicker or to show a slow save.

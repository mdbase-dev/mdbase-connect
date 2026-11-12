## Fixed

- SDK: `ReadOptions.signal`, `DescribeOptions.signal` and the `awaitReceipt` options accept `undefined`, so an app compiled with `exactOptionalPropertyTypes` passes its own optional signal straight through.
- SDK testing kit: the application fixture's `snapshot.sync` reads the published snapshot's `transport` and `live`, as the real entry does, so a test can show an unreachable or offline service. `MemoryReplica` takes `settings` for `describe` to report.
- SDK docs: `docs/sdk-sync-status.md` said the old `offline` status maps to `connection`. It maps to `connection === "offline" || health === "unreachable"`; `reconnecting` is wider. The page also names `client.status.installing` for a first download and no longer says no app read `StatusSummary.text`.

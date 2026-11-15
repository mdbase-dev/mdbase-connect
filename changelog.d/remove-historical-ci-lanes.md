## Removed

- Server CI no longer runs CI lanes that exercise no current code: the historical beta94 provider prelude migration, the beta95 provider and pending-server rollback regressions, and the opt-in binary transfer benchmark. The remaining provider upgrade job is renamed "Current provider upgrade and recovery".
- Removed the dispatch-only `Rollback read compatibility` workflow and its release-tag override, and the monthly performance observation workflow; the provider observation still runs locally with `pnpm profile:provider:observe`.
- The `relay`, `sync` and `linux-packages` system shards no longer check out the engine or build Rust, and nightly flake stress runs the hosted-provider Rust stress on Linux only.

## Removed

- Server CI no longer runs the historical provider upgrade lanes, whose predecessor and successor were both pinned published images: the beta94 provider prelude migration and the beta95 provider rollback step. The opt-in binary transfer benchmark is also gone. The remaining provider upgrade job is renamed "Current provider upgrade and recovery". The beta95 pending-server rollback lane is kept: it is the only lane that starts an older server on the candidate's migrated control-plane schema.
- Removed the dispatch-only `Rollback read compatibility` workflow and its release-tag override, and the monthly performance observation workflow; the provider observation still runs locally with `pnpm profile:provider:observe`.
- The `relay`, `sync` and `linux-packages` system shards no longer check out the engine or build Rust, and nightly flake stress runs the hosted-provider Rust stress on Linux only.

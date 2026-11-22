## Breaking

- Retire the legacy Connect stack (Tier 2a, 2b, and 2c): remove root `crates/` (`connect-hosted-provider`, `connect-runtime`, `connect-protocol`), root `Cargo.toml`/`Cargo.lock`, `packages/sync` (`@mdbase-dev/connect-sync`), `deploy/postgres`, legacy hosted-provider Docker/CI/upgrade/system suites, server legacy hosted/mirror/authority-transfer/migration/takeover routes, `runtime/` migration and takeover crates (`mdbn-legacy`, `mdbn-migrate`, `mdbn-migrate-portable`, `mdbn-takeover`), `hosted-worker` migration/legacy-source code, and `mdbn-daemon` takeover/migrate commands.
- Detach `apps/editor` from `@mdbase-dev/connect` and remove stale vendor tarballs from `apps/editor/vendor/`.
- Update front-door documentation (`README.md`, `docs/architecture.md`, `runtime/README.md`, `docs/README.md`, `docs/legacy-retirement.md`, `apps/editor/NEW_SDK.md`) around the `mdbase-next` runtime and `@mdbase-dev/sdk`.

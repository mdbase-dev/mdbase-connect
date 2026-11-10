# Legacy Connect retirement list

Working list for deleting the legacy Connect stack. It covers the root `crates/`
workspace on `../mdbase-rs`, the legacy hosted provider at `sync.mdbase.dev`,
`packages/sync`, and the server, deploy, test and docs code that exists only for
them. Traced read-only on 2026-11-10 from `origin/main` fb59ee214, mdbase-cloud-ops
`main`, and the other first-party repos. Line counts are `wc -l` over tracked files.

Tiers:

- **0**: delete now; nothing consumes it.
- **1**: delete after a code-only change, here or in mdbase-cloud-ops.
- **2**: blocked on a production condition; the "Check" column says how to check it.
- **Keep**: looks legacy but is current.

Production facts used (sources: agents-notes `docs/2026-10-29-mdbase-next-february-close-out.md`,
`docs/2026-10-30-retire-production-migration-worker-plan.md`, cloud-ops Render
state and locks, public endpoints):

- The bulk migration finished on 2026-10-29. One account, `a9bf357e`, stays on
  `legacy` on purpose: it is suspended and has one hosted collection.
- Retention: legacy data and rollback evidence are kept 90 days after each cutover,
  until 2027-01-27 at the latest. Per-account recovery archives expire on 2027-02-22,
  with removal verified by 2027-02-24. The close-out reminder is set for 2027-02-25.
  No late legacy import is planned; any stragglers go through support by hand.
- About 700 migrated collections are still served by the migration Worker
  `mdbase-next-hosted-mig-production` until their hosting-move.
- The legacy provider `mdbase-connect-hosted-provider` (`sync.mdbase.dev`) is live:
  `/ready` returns 200. Every server CD rebuilds and redeploys it at the same
  revision as Connect.
- Production sets `MDBASE_NEW_ACCOUNT_BACKEND=next` in the Render env, which now
  matches the code default (`services/server/src/runtime-config.ts`).
- `config/desktop-update-minimum.json` sets the desktop minimum to `0.1.0-beta.130`,
  the first build that bundles `mdbn-daemon`. `packages/protocol` still accepts
  connectors from `0.1.0-beta.33`.

## Tier 0: delete now

| Unit | Lines | Evidence nothing consumes it | Same-PR edits |
| --- | --- | --- | --- |
| `crates/connect-hosted-storage-benchmark` (bin `hosted-storage-benchmark`) | 4,196 | No workflow, package script, Dockerfile or cloud-ops reference. Its only build is `cargo build --workspace`. It was the Candidate B storage benchmark, with results dated 2026-08-16. | Drop the workspace member. Regenerate `Cargo.lock` and `deploy/docker/Cargo.lock.hosted-provider`; the second is a provider image input, so the next CD rebuilds the provider. Remove the `config/architecture-budgets.json` entries, or leave them for release prep to refresh. |
| `scripts/hosted-storage-benchmark/` | 2,280 | Only the crate above and its own fixtures use it. | None. |
| `docs/benchmarks/hosted-storage-model/` | 316,837 (50 files, mostly fixtures and results) | Only the two units above read it. Elsewhere it is cited as text, never read: `docs/decisions/0011-*.md` and the doc comment at `runtime/crates/migrate/src/rehearsal/mod.rs:5`. The rehearsal `shape` module generates its own data. | Remove the `.gitignore:22` exception. Reword the 0011 and rehearsal citations to name the commit. |
| `scripts/staging-candidate-b-live-mission.mjs` | 516 | No references in Connect or cloud-ops. Last changed 2026-09-27. Candidate B services are decommissioned (cloud-ops `.ops/tasks/decommission-candidate-b-services.md`, status done). | None. |
| `docs/architecture/candidate-b-beta69-rollback-evidence.md`, `candidate-b-consolidated-schema-diff.md`, `hosted-consumer-staging-missions.md` | 317 | Referenced only by completed cloud-ops tasks and two legacy docs. | Remove the links in `docs/architecture/hosted-projection-migration.md:147` and `hosted-queryable-execution.md:17`. |

Tier 0 removes about 7.3k source and doc lines plus about 317k fixture and result lines.

## Tier 1: delete after a code-only change

These do not serve production traffic. They are still wired into CI, the release
gate or local test commands. "Change first" lists what must land before the source
can be deleted.

| Unit | Lines | Consumers | Change first |
| --- | --- | --- | --- |
| Legacy CLI and daemon: `crates/connect-cli` (`mdbase-cli`, bin `mdbase`), `connect-agent` (`mdbase-connect-daemon`), `connect-core`, `connect-mirror` | 69,821 | <ul><li>`deploy/docker/Dockerfile.client`, which builds image `ghcr.io/mdbase-dev/mdbase-connect-client`.</li><li>The client matrix in `publish-images.yml` and `publish-staging-images.yml`.</li><li>In `server-ci.yml`, the `windows-filesystem` job (`-p mdbase-connect-core -p mdbase-connect-daemon`) and the root-workspace fmt and clippy runs.</li><li>`windows-daemon-lifecycle.yml`, `performance-observations.yml` (mirror profile), `flake-stress.yml` via `scripts/ci/stress.mjs`, and `rust-caches.yml` (connect-debug).</li><li>The `local` system suite, which is also `pnpm e2e` (`scripts/e2e.mjs` runs `target/debug/mdbase connect daemon run`), and the `provider` suite.</li><li>**cloud-ops:** `MDBASE_CONNECT_CLIENT_IMAGE` in `render/{release,staging-release,lab-release}.env` and `.lock.json`. On every server CD, `bin/prepare-release-client`, `bin/qualify-staging-clients` and `bin/deploy-staging-release` (phase `signed-client-relay-qualification`) run the candidate and N-1 client images.</li></ul> | <ol><li>In cloud-ops, remove or replace the `signed-client-relay-qualification` phase and the client-image lock fields. The agents-notes task `tasks/2026-11-08-retire-legacy-root-daemon-cli.md` already notes that this phase qualifies the wrong binary.</li><li>Here, give `pnpm e2e` and the `local` suite a next equivalent, or retire them, and update the `pnpm e2e` line in `AGENTS.md`.</li><li>Drop the client image from both publish workflows, then delete `Dockerfile.client`.</li><li>Remove these crates from `windows-filesystem`, `windows-daemon-lifecycle`, `performance-observations`, `flake-stress` (keep its provider, packages and server parts until Tier 2) and `rust-caches`.</li><li>Move the provider suite's mirror CLI to `packages/sync`, or drop that step.</li></ol> |
| `crates/connect-testbed-adapter` | 367 | The `server-ci` `runtime-testbed` job runs it against the mdbase-spec testbed. | Point that job at the runtime adapter, or drop it. The runtime has its own conformance. |
| Scripts used only by the CLI group: `scripts/e2e.mjs`, `mirror-live-vault.mjs`, `mirror-writable-live-vault.mjs`, `mirror-profile.mjs`, `mirror-profile-baseline.json`, `profile-file-mirror.mjs`, `assert-mirror-performance.mjs` | about 4.5k with `relay-e2e.mjs`, which stays | `local` suite, `performance-observations.yml`, root `profile:mirror*` and `check:mirror:mobile` scripts | Same changes as the CLI row. |
| Stale desktop release triggers | under 20 | The `desktop-release.yml` path filters (`Cargo.toml`, `Cargo.lock`, `crates/**`, `deploy/docker/mdbase-rs-revision`) and the regex in `scripts/continuous-desktop-release.mjs:14`. The desktop bundles `mdbn-daemon` from `runtime/`, not the root crates. | Edit the filters. This can be done now and is independent of the rows above. |
| CLI and daemon docs: `docs/unified-cli.md` (already marked superseded), the legacy sections of `docs/cli-daemon.md`, `docs/windows-core-flakes.md`, `docs/file-io-campaign.md` | 717 | Links only | Delete together with the CLI crates. |

Deleting the CLI drops the N-1 old-connector qualification, but it does not change
what production serves: the relay keeps accepting old connectors (Keep). If you
want evidence first that no old connectors are left, run query Q4 below. That is a
judgement call, not a hard block.

Tier 1 removes about 75k lines, plus about 650 lines of workflow and Dockerfile.

## Tier 2: blocked on a production condition

Three conditions apply, and each releases its own set of units. 2a and 2b are
independent of each other. 2c is last.

### 2a: legacy provider retired (`sync.mdbase.dev` switched off)

**Condition:**

- the legacy account count is 0, or `a9bf357e` has been resolved (deleted, or moved by support);
- the legacy retention window has passed (2027-01-27);
- recovery archives have been removed and verified (2027-02-24);
- the ops consumers of the provider are gone.

| Unit | Lines | Consumers to remove first |
| --- | --- | --- |
| `crates/connect-hosted-provider` (also `mdbase-hosted-backup-admin`, `-key-admin` and `-projection-indexer`), `connect-runtime`, `connect-protocol` (generated Rust) | 86,922 | <ul><li>Render service `mdbase-connect-hosted-provider` and DB `mdbase-connect-hosted-db`, plus the staging and LAB services.</li><li>Connect env `MDBASE_CONNECT_HOSTED_PROVIDER_URL` and `MDBASE_CONNECT_HOSTED_COLLECTIONS`.</li><li>**cloud-ops:** `monitor-production.yml` probe; `validate_desired_state.rb`; the backup and recovery-drill profile `hosted-provider`; `bin/hosted-*` admin tools; `bin/lib/rollback_compat.py`; the provider digests in `ci.yml`.</li><li>Here: `Dockerfile.hosted-provider`, `Cargo.lock.hosted-provider` (also listed in `scripts/lib/release-version.mjs`), `config/release-components.json`, and the Rust outputs of `scripts/generate-{change-events,connect-problems,operation-catalog,application-capabilities}.mjs`, which must stop emitting Rust; also `CODEOWNERS`.</li></ul> |
| `../mdbase-rs` path dependency | n/a | <ul><li>Root `Cargo.toml`.</li><li>`deploy/docker/mdbase-rs-revision`.</li><li>`pnpm check:mdbase-rs-pin` (`scripts/mdbase-rs-pin.mjs`).</li><li>Every `callumalpass/mdbase-rs` checkout in `server-ci` (four jobs), `flake-stress`, `performance-observations`, `rust-caches`, `windows-daemon-lifecycle` and `publish-*images`.</li><li>cloud-ops `check-release-locks`, `verify-release-bundle` and the `RUNTIME_PATHS` in `continuous_deployment.py`.</li></ul>It goes when the last root crate goes, which ends the root Cargo workspace. Outside this repo, mdbase.dev `site-sources.json` still lists mdbase-rs as the "rust" implementation; that is a separate decision. |
| `packages/sync` (`@mdbase-dev/connect-sync`, private; npm publishing stopped in #1290) | 23,950 | Server imports in `hosted.ts`, `hosted-mirror-policy.ts`, `features/hosted/account-routes.ts`, `features/mirrors/pairing-routes.ts`, `features/authority-transfer/lifecycle.ts` and `platform/error-handler.ts` (`SyncError`). Also `Dockerfile.server:44`, `scripts/sync-e2e.mjs` and `flake-stress`. |
| Legacy hosted, mirror and authority server cluster: `hosted-provider*.ts`, `hosted.ts`, `hosted-mirror-policy.ts`, `hosted-replica-policy.ts`, `hosted-capability-lifecycle.ts`, `authority-proof.ts`, `features/hosted/*` except `sharing-routes.ts`, `features/mirrors/*`, `features/authority-transfer/*`, `features/authority-adoption/*`, `features/authorizations/hosted-approval-service.ts` | 8,728 prod and about 5.3k tests | `HostedProviderClient` is also used by `usage-report.ts` (provider `protocolUsage`), account management and deletion, `auth-admin-entitlements`, notifications, `timers/hosted-import` and the migration provider. Each of these needs its provider branch removed. |
| Legacy tables: `hosted_replicas`, `mirror_pairing_requests`, `authority_transfers`, `authority_adoption_requests`, `authority_import_abort_receipts`, `provider_collection_deletion_jobs`, `provider_revocation_jobs` | n/a | Drop them in a forward migration after the code above is gone. Keep the frozen bootstrap (see Keep). |
| `deploy/postgres/*.sql` | 1,167 | cloud-ops `hosted-schema-admin` and `hosted-database-drain-admin` |
| Provider system suites: `scripts/hosted-provider-e2e.mjs`, `hosted-files-e2e.mjs`, `hosted-file-adversarial-e2e.mjs`, `hosted-projection-scale-e2e.mjs`, `sync-e2e.mjs`, `scripts/system/provider/*`; `server-ci` jobs `hosted-provider-rust`, the `hosted-provider-system` shards, `binary-transfer-benchmark` | about 6.9k | These guard the provider that every CD still deploys. Freezing the provider image digest would move them to Tier 1. |
| Upgrade lanes: `test/upgrade/*`; `server-ci` jobs `previous-provider-upgrade` (beta94 `--legacy-prelude`), `retained-v2-provider-upgrade` and `retained-v2-server-pending` (beta95); and `rollback-read-compat.yml` | about 2.8k | Same as above. |
| Self-host: `deploy/self-host/compose.yml`, `docs/self-hosting.md` | 877 | They run the legacy provider with no next log service, and new accounts default to `legacy`. Replace them with a next self-host, or withdraw self-hosting; that is a product decision. |
| Legacy-stack docs: `docs/sync.md`, `hosted-provider.md`, `lossless-opaque-sync-acceptance.md`, `docs/architecture/hosted-*` and `sdk-wave-b-*`, decisions 0003, 0005, 0006, 0010 and 0011, the legacy sections of `architecture.md`, `performance.md` and `encryption.md` | about 3.8k | Links only |

### 2b: migration Worker retired

**Condition:** every collection served by `mdbase-next-hosted-mig-production` has
completed its hosting-move (KMS ReEncrypt) and the Worker has been deleted, as in
the 2026-10-30 retirement plan. 2a's retention window must also have passed,
because the legacy-source connections read provider data.

| Unit | Lines |
| --- | --- |
| `runtime/crates/migrate`, `migrate-portable` (a dependency of hosted-worker) | Included in the 26,161 runtime legacy total in 2c |
| hosted-worker: Rust `migration_*`; TS `deploy/hosted-worker/src/legacy-source/*`, the migration executor and `sql/legacy-reader-role*.sql` | 11,762 Rust and 4,674 TS/SQL |
| Server migration machinery: `features/next/migration-*.ts`, `legacy-grant-carry-over.ts`, `hosting-moves.ts`, `account-backend-flip.ts`, `timers/hosted-import.ts`, the LAB migration routes, and the `next_migration_*` tables. Keep the flip records as long as `GET /v1/account/backend` reads them. | 6,461 prod and about 11.9k tests |
| Migration runbooks: `docs/hosted-migration-*`, `migration-*`, `lab-*`, `legacy-*`, `managed-account-migration.md`, `hosted-rollback-*` | about 2.1k |

### 2c: old field clients gone

**Condition:**

- no desktop build older than `0.1.0-beta.130` is still connecting;
- the unmigrated local collection count is 0 (query Q3);
- the old-SDK apps (Reader and Writer, which pin `@mdbase-dev/connect` beta.149; Reader PR #145 drops it) have been repinned or retired.

| Unit | Lines |
| --- | --- |
| `runtime/crates/legacy` (`mdbn-legacy`) and `takeover`, plus `mdbn-daemon` `takeover/` and `service/legacy*.rs` | 26,161 runtime crates in total (including the 2b migrate crates) and 7,869 daemon |
| Server: `local-takeover.ts`, `local-rollback-bindings.ts`, `cutover-problems.ts` refusals (`moved_to_next_runtime`, `collection_not_yet_migrated`), `native-grant-target.ts` `unmigratedLocalCollection` | Part of the 6,461 above |
| The legacy-connector branches of the relay, and `MINIMUM_CONNECTOR_VERSION` in `packages/protocol` | Small. Removing them is a protocol change and needs a version bump. |

Tier 2 removes about 212k lines across 2a, 2b and 2c.

### Unknown production facts

These could not be determined read-only. The operator (Callum, or the ops Release
supervisor) should run them with the production read-only DB role. Do not run them
from an agent session.

| # | Question | Command (database) |
| --- | --- | --- |
| Q1 | How many accounts are on each backend? | `SELECT account_backend, suspended_at IS NOT NULL AS suspended, count(*) FROM users GROUP BY 1,2;` (`mdbase-connect-db`) |
| Q2 | What legacy provider data is left, and how long is it retained? | `SELECT state, count(*), max(legacy_retain_until) FROM hosted_provider_collections GROUP BY state;` (`mdbase-connect-hosted-db`) |
| Q3 | How many local collections are unmigrated? | The `unmigratedLocalCollection` query in `services/server/src/features/next/native-grant-target.ts`, without the `local_id`/`user_id` filter and with `count(*)` (`mdbase-connect-db`) |
| Q4 | How many active legacy connectors are there? | `SELECT count(*) FROM connectors c LEFT JOIN next_devices d ON d.connector_id = c.id WHERE d.id IS NULL AND c.revoked_at IS NULL AND c.last_seen_at > now() - interval '30 days';` (`mdbase-connect-db`) |
| Q5 | How many hosting-moves remain? | Count of `next_service_devices` rows with `kind = 'hosted'` whose `kms_key_arn` is the migration Worker's key (`mdbase-connect-db`) |
| Q6 | How much legacy transport (direct, relay, hosted) is still in use? | `usage.mdbase.dev` report, behind Cloudflare Access |

## Keep: looks legacy but is current

| Unit | Why |
| --- | --- |
| `packages/protocol` | Used by the next SDK (`runtime/packages/sdk`), desktop, portal and MCP. Only its Rust generator output belongs to 2a. |
| `packages/client` (`@mdbase-dev/connect`) | Used by the Editor types, MCP crypto, devkit and testing, Reader and Writer. It also has `/v1/next` paths. It needs its own retirement record and is outside this list. |
| Relay (`/v1/relay`), relay broker, `deploy/nats`, Noise pipes, `scripts/relay-e2e.mjs` | `mdbn-daemon` uses the relay (`runtime/crates/daemon/src/relay.rs`). `relay-e2e` drives a fake connector against it. |
| Tables `hosted_collections` and `connectors`; `features/hosted/sharing-routes.ts` | Shared with next. Migrated collections keep their `hosted_collections` IDs. |
| `legacy-baseline.ts`, `legacy-backfills.ts`, `legacy-schema-helpers.ts` | Frozen schema bootstrap for every control-plane database. |
| `scripts/hosted-read-canary.mjs`; the container and linux-packages suites | They drive the shipped next CLI. |
| `docs/account-backend.md`, `installation-legacy-refusal.md`, `unmigrated-local-collections.md` | These describe current refusal behaviour until 2c. |
| Root `AGENTS.md` | #1335 already states that `mdbase-rs` is not authoritative and points to the runtime. |

## Risks that cross tiers

- `MDBASE_NEW_ACCOUNT_BACKEND` now defaults to `next` in code, and the server refuses
  to start with `next` but without `MDBASE_NEXT_CONTROL_PLANE=1`. The self-host and
  local compose stacks, the tailnet stack and the server upgrade tests set `legacy`
  explicitly. Retiring the legacy stack must also remove those settings.
- Every server CD rebuilds the provider. `continuous_deployment.py` treats changes
  under `crates/**`, `Cargo.toml`, `Dockerfile.client`, `mdbase-rs-revision` and
  `packages/sync` as runtime changes, so Tier 0 and Tier 1 deletions will trigger
  a provider rebuild.

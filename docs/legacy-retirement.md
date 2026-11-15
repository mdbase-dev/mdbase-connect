# Legacy Connect retirement list

Working list for deleting the legacy Connect stack. It covers the root `crates/`
workspace on `../mdbase-rs`, the legacy hosted provider at `sync.mdbase.dev`,
`packages/sync`, and the server, deploy, test and docs code that exists only for
them. Traced read-only on 2026-11-10 from `origin/main` fb59ee214, mdbase-cloud-ops
`main`, and the other first-party repos. Line counts are `wc -l` over tracked files.
The production facts were refreshed on 2026-11-15 from operations records; no
production query was run for them.

Tiers:

- **0**: deleted in #1360 (the Candidate B storage benchmark and staging leftovers).
- **1**: the legacy connector; removed in two pull requests (below).
- **2**: blocked on a production condition; the "Check" column says how to check it.
- **Keep**: looks legacy but is current.

Production facts used (sources: agents-notes `docs/2026-10-29-mdbase-next-february-close-out.md`,
`docs/2026-10-30-retire-production-migration-worker-plan.md`, cloud-ops Render
state and locks, public endpoints):

- The bulk migration finished on 2026-10-29. Nine accounts created on
  2026-10-24, after the bulk selection cutoff and before new accounts became
  `next`, were missed; they migrated on 2026-11-14. Two accounts stay on `legacy`
  on purpose: `a9bf357e`, which is suspended and has one hosted collection, and
  an internal test baseline account. Nothing in mdbase-cloud-ops uses the
  baseline account.
- Retention: legacy data and rollback evidence are kept 90 days after each
  cutover, so until about 2027-02-12 (inferred from the 2026-11-14 cutovers).
  The last per-account recovery archive expires on 2027-03-10, with removal
  verified by 2027-03-12. The close-out reminder was set for 2027-02-25 and has
  to move to 2027-03-13 or later.
- The hosting-move ran on 2026-11-02: all 699 collections migrated by then moved
  to the control-plane hosted Worker. The 2026-11-14 wave linked three accounts'
  collections to the migration Worker `mdbase-next-hosted-mig-production` again;
  they need a second move before that Worker can be deleted.
- The legacy provider `mdbase-connect-hosted-provider` (`sync.mdbase.dev`) is live:
  `/ready` returns 200. Every server CD rebuilds and redeploys it at the same
  revision as Connect. It does not serve migrated collections, which come from
  the next log. The control plane still depends on the service: Connect `/ready`
  fails without it (and with it the production verification and the monitor),
  and usage reporting, entitlement and account reconciliation, notification
  grants, account deletion, the migration and rollback endpoints and the two
  legacy accounts all call it.
- The legacy tools in mdbase-cloud-ops (`staging-accept-extended`, the hosted
  transfer and fixture rehearsals, the LAB legacy seed) run only by hand on LAB
  or staging. No continuous-deployment gate runs them.
- Production sets `MDBASE_NEW_ACCOUNT_BACKEND=next` (declared in `render.yaml`), which
  matches the code default (`services/server/src/platform/runtime-config.ts`).
- `config/desktop-update-minimum.json` sets the desktop minimum to `0.1.0-beta.130`,
  the first build that bundles `mdbn-daemon`. `packages/protocol` still accepts
  connectors from `0.1.0-beta.33`.

## Tier 1: legacy connector (removed)

Nothing a user installs came from these units: the shipped `mdbase` CLI and
daemon are built from `runtime/`. The owner dropped the old-connector
qualification on 2026-11-10, and mdbase-cloud-ops stopped using the client image
(mdbase-cloud-ops #1715, #1727 and #1732; ops lists `client` under
`retiredComponents`). Removal is split in two pull requests so that the release
pipeline change can be reverted on its own:

1. **Consumers.** Stopped building, publishing, testing and documenting the
   legacy connector:
   - the `client` release component, `deploy/docker/Dockerfile.client` and its
     publish steps in `publish-images.yml` (`publish-staging-images.yml` was
     already gone);
   - the Server CI `windows-filesystem` and `runtime-testbed` jobs,
     `windows-daemon-lifecycle.yml` with `scripts/diagnostics/` (its service
     probe compiled `connect-cli`'s service module), the connector parts of
     `flake-stress` and `rust-caches`, and the engine, Connect and mirror
     profiles of `performance-observations.yml` together with
     `scripts/performance-results.mjs` (the provider observation stays);
   - the `legacy-local` system suite and `pnpm e2e:legacy`, the provider suite's
     legacy-daemon mirror and authority-promotion scenarios, `scripts/e2e.mjs`,
     the mirror profiling scripts, `scripts/stress/connector-lifecycle.mjs`, and
     the root `profile:*` and `check:mirror:mobile` scripts that ran them;
   - the legacy sections of `docs/cli-daemon.md`, `performance.md`,
     `testing-environment.md` and `ci-qualification.md`. The security audit
     package now names `runtime/crates/daemon` for the connector boundaries.
     `docs/unified-cli.md`, `windows-core-flakes.md` and `file-io-campaign.md`
     were already removed in #1356.
2. **Deletion.** Removed `crates/connect-cli`, `connect-agent`, `connect-core`,
   `connect-mirror` and `connect-testbed-adapter`, the workspace dependencies
   only they used (`directories`, `iana-time-zone`, `keyring`, `notify`,
   `rusqlite`, `tokio-tungstenite`) and their lock entries, their CODEOWNERS
   lines, and the architecture check's `connect-core` runtime seam rule. No kept
   crate depended on them. The `local` cases in
   `packages/protocol/test/fixtures/collection-changes-v1.json` stay as client
   decoding fixtures.

The relay keeps accepting old connectors (Keep). Query Q4 below still shows
whether any are left.

Two pieces of coverage for code that is still deployed went with the consumers:

- **Hosted-to-local authority promotion, end to end.** The provider suite's
  promotion scenario drove the legacy CLI's `mirror promote` and the portal's
  "Move main copy" page in a browser. The provider's fence, prove, complete and
  cancel steps are still tested at the API level, and the server keeps its unit
  and Postgres tests. The confirmation page itself was removed from the portal
  on 2026-11-15 (see 2a). Only a legacy account can reach that flow; it goes in
  2a.
- **Durable history for the provider performance observation.** The monthly
  observation still runs and uploads its raw result as a workflow artifact, but
  the normalising and `performance-history` publishing steps went with
  `scripts/performance-results.mjs`.

## Tier 2: blocked on a production condition

Three conditions apply, and each releases its own set of units. 2a and 2b are
independent of each other. 2c is last.

### 2a: legacy provider retired (`sync.mdbase.dev` switched off)

**Condition:**

- the legacy account count is 0, or `a9bf357e` has been resolved (deleted, or moved by support);
- the legacy retention window has passed (about 2027-02-12);
- recovery archives have been removed and verified (2027-03-12);
- the ops consumers of the provider are gone.

Removed ahead of the provider (2026-11-15): **authority adoption** and the
**local-to-hosted authority transfer**. Both created a legacy hosted collection
through `requireLegacyHostedAccount`, which refuses `next` accounts, and only the
deleted legacy connector, `packages/sync` adoption and the portal `/adopt/:id`
page called them. Removed: `features/authority-adoption/*`,
`features/authority-transfer/local-to-hosted-routes.ts` and
`account-cancellation.ts`, the provider client's `prepareAuthorityImport`,
`completeAuthorityImport`, `reconcileAuthorityImportCancellation` and
`advanceProjection`, the portal adoption page, `packages/sync` `./adoption`, and
the provider suite's import and adoption steps. Their routes now return 404.
What remains of that cluster is kept for rows that already exist, and goes with
the provider and the tables below: the to-hosted expiry branch of
`recoverExpiredAuthorityTransfers` (with `finishAuthorityImportAbort` and
`expireAuthorityImport`), the to-hosted source binding in connector inventory
(`POST /v1/connectors/sync`), the 0036 authority-import-source repair and its
`auth-admin repairs authority-import-sources` command, adoption-row revocation in
`instance-admin.ts` (with `abortAuthorityImport`), and the tables themselves.

Also removed ahead of the provider (2026-11-15): the portal pages for **mirror
pairing** (`/mirror/:id`) and the **hosted-to-local authority transfer**
(`/transfer/:id`, "Move main copy"). No current app starts either flow.
Obsidian plugin releases 0.4.2 and earlier and the `mdbase-mirror` CLI in
`packages/sync` can still create a pairing request, which nothing can approve
now. The pages, their styles and the portal's `AuthorityTransfer` type are gone,
and an old link opens the portal app, as `/adopt/:id` does. Until the server
routes go, the server keeps returning links to the removed page. The
server routes (`features/mirrors/pairing-routes.ts` and
`features/authority-transfer/hosted-to-local-routes.ts`) remain for a following
change, so a rolled-back portal and the current server still work together. The
portal keeps showing existing hosted collections and their synced folders, with
**Disconnect**.

| Unit | Lines | Consumers to remove first |
| --- | --- | --- |
| `crates/connect-hosted-provider` (also `mdbase-hosted-backup-admin`, `-key-admin` and `-projection-indexer`), `connect-runtime`, `connect-protocol` (generated Rust) | 86,922 | <ul><li>Render service `mdbase-connect-hosted-provider` and DB `mdbase-connect-hosted-db`, plus the staging and LAB services.</li><li>Connect env `MDBASE_CONNECT_HOSTED_PROVIDER_URL` and `MDBASE_CONNECT_HOSTED_COLLECTIONS`.</li><li>**cloud-ops:** `monitor-production.yml` probe; `validate_desired_state.rb`; the backup and recovery-drill profile `hosted-provider`; `bin/hosted-*` admin tools; `bin/lib/rollback_compat.py`; the provider digests in `ci.yml`.</li><li>Here: `Dockerfile.hosted-provider`, `Cargo.lock.hosted-provider` (also listed in `scripts/lib/release-version.mjs`), `config/release-components.json`, and the Rust outputs of `scripts/generate-{change-events,connect-problems,operation-catalog,application-capabilities}.mjs`, which must stop emitting Rust; also `CODEOWNERS`.</li></ul> |
| `../mdbase-rs` path dependency | n/a | <ul><li>Root `Cargo.toml`.</li><li>`deploy/docker/mdbase-rs-revision`.</li><li>`pnpm check:mdbase-rs-pin` (`scripts/mdbase-rs-pin.mjs`).</li><li>Every `callumalpass/mdbase-rs` checkout in `server-ci` (two jobs), `flake-stress`, `performance-observations` and `rust-caches`, and the `Cargo.lock.hosted-provider` and `mdbase-rs-revision` inputs of `publish-images`.</li><li>cloud-ops `check-release-locks`, `verify-release-bundle` and the `RUNTIME_PATHS` in `continuous_deployment.py`.</li></ul>It goes when the last root crate goes, which ends the root Cargo workspace. Outside this repo, mdbase.dev `site-sources.json` still lists mdbase-rs as the "rust" implementation; that is a separate decision. |
| `packages/sync` (`@mdbase-dev/connect-sync`, private; npm publishing stopped in #1290) | about 21,800 | Server imports in `features/hosted/hosted.ts`, `features/hosted/hosted-mirror-policy.ts`, `features/hosted/account-routes.ts`, `features/mirrors/pairing-routes.ts`, `features/authority-transfer/lifecycle.ts` and `platform/error-handler.ts` (`SyncError`). Also `Dockerfile.server:44`, `scripts/sync-e2e.mjs` and `flake-stress`. |
| Legacy hosted, mirror and authority server cluster: `features/hosted/hosted-provider*.ts`, `features/hosted/hosted.ts`, `features/hosted/hosted-mirror-policy.ts`, `features/hosted/hosted-replica-policy.ts`, `features/hosted/hosted-capability-lifecycle.ts`, `features/hosted/*` except `sharing-routes.ts`, `features/mirrors/*`, `features/authority-transfer/*` except `authority-proof.ts`, `features/authorizations/hosted-approval-service.ts` | about 6,640 prod and about 3.3k tests | `HostedProviderClient` is also used by `features/usage/usage-report.ts` (provider `protocolUsage`), account management and deletion, `auth-admin-entitlements`, notifications, `timers/hosted-import` and the migration provider. Each of these needs its provider branch removed. |
| Legacy tables: `hosted_replicas`, `mirror_pairing_requests`, `authority_transfers`, `authority_adoption_requests`, `authority_import_abort_receipts`, `provider_collection_deletion_jobs`, `provider_revocation_jobs` | n/a | Drop them in a forward migration after the code above is gone. Keep the frozen bootstrap (see Keep). |
| `deploy/postgres/*.sql` | 1,167 | cloud-ops `hosted-schema-admin` and `hosted-database-drain-admin` |
| Provider system suites: `scripts/hosted-provider-e2e.mjs`, `hosted-files-e2e.mjs`, `hosted-file-adversarial-e2e.mjs`, `hosted-projection-scale-e2e.mjs`, `sync-e2e.mjs`, `scripts/system/provider/*`; `server-ci` jobs `hosted-provider-rust` and the `hosted-provider-system` shards | about 6.2k | These guard the provider that every CD still deploys. Freezing the provider image digest would move them to Tier 1. Already removed: the opt-in `binary-transfer-benchmark` job, and the engine checkout and Cargo build in the `relay`, `sync` and `linux-packages` shards, which never started the provider, and the provider Rust stress on the macOS and Windows legs of `flake-stress`. |
| Upgrade lanes: `test/upgrade/*`; `server-ci` jobs `previous-release-upgrade`, `current-provider-upgrade` (`--current-upgrade` against `.github/previous-release.env`) and `retained-v2-server-pending` (beta95) | about 1.7k | Same as above. `retained-v2-server-pending` also stays because it is the only lane that starts an older server on the candidate's migrated control-plane schema; it goes once a check against the merge-base server replaces it. Already removed, because both ends were published historical images or the workflow was not a gate: `previous-provider-upgrade` (beta94 `--legacy-prelude`), the beta95 `--retained-v2` step of the former `retained-v2-provider-upgrade`, and `rollback-read-compat.yml`. |
| Self-host: `deploy/self-host/compose.yml`, `docs/self-hosting.md` | 877 | They run the legacy provider with no next log service, and new accounts are `legacy`. No shipped client can use such a stack: the legacy connector is gone, and installation sign-in refuses a `legacy` account (`installation_legacy_backend`). Replace them with a next self-host, or withdraw self-hosting; that is a product decision. |
| Legacy-stack docs: `docs/sync.md`, `hosted-provider.md`, `lossless-opaque-sync-acceptance.md`, `docs/architecture/hosted-*` and `sdk-wave-b-*`, decisions 0003, 0005, 0006, 0010 and 0011, the legacy sections of `architecture.md`, `performance.md` and `encryption.md` | about 3.8k | Links only |

### 2b: migration Worker retired

**Condition:** every collection served by `mdbase-next-hosted-mig-production` has
completed its hosting-move (KMS ReEncrypt) and the Worker has been deleted, as in
the 2026-10-30 retirement plan. The first move covered 699 collections on
2026-11-02; the three accounts migrated on 2026-11-14 still need theirs. 2a's
retention window must also have passed, because the legacy-source connections
read provider data, and rolling an account back needs this machinery.

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
- the old-SDK apps have been repinned or retired. This one is met: on 2026-11-15
  neither Reader nor Writer depends on `@mdbase-dev/connect` any more (Writer is
  on `@mdbase-dev/sdk`).

| Unit | Lines |
| --- | --- |
| `runtime/crates/legacy` (`mdbn-legacy`) and `takeover`, plus `mdbn-daemon` `takeover/` and `service/legacy*.rs` | 26,161 runtime crates in total (including the 2b migrate crates) and 7,869 daemon |
| Server: `local-takeover.ts`, `local-rollback-bindings.ts`, `cutover-problems.ts` refusals (`moved_to_next_runtime`, `collection_not_yet_migrated`), `native-grant-target.ts` `unmigratedLocalCollection` | Part of the 6,461 above |
| The legacy-connector branches of the relay, and `MINIMUM_CONNECTOR_VERSION` in `packages/protocol` | Small. Removing them is a protocol change and needs a version bump. |

Tier 2 removes about 212k lines across 2a, 2b and 2c.

### Unknown production facts

These could not be determined read-only. Operations queries production only
through fixed, read-only aggregate commands, never ad-hoc SQL, so the queries
below describe what is needed and are not to be run as written:

- Q1 to Q4 each need a new fixed aggregate command in mdbase-cloud-ops.
- Q5 has one: `bin/release production hosting-move inventory`, which is also the
  gate for deleting the migration Worker. It may create a production job.
- Q6 is read from "Accounts by transport" on `usage.mdbase.dev`.

Do not run any of them from an agent session.

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
| `features/authority-transfer/authority-proof.ts` | Used by current next code: `features/account/backend-routes.ts`, `features/authorizations/polling-routes.ts` and `features/next/timers/routes.ts`. |
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
  under `crates/**`, `Cargo.toml`, `config`, `mdbase-rs-revision` and
  `packages/sync` as runtime changes, so the Tier 1 removal triggers
  a provider rebuild.

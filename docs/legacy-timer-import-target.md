# Strict legacy timer target import (integration work)

The source DTO retains the original raw SQL `record_json::text`, complete structured event headers, original generation/state and original RFC3339 timestamp strings. Validation refuses inconsistent/incomplete input before target mutation. The target importer is not a source, completion producer or permission to flip an account; the paged caller and flip gate below bind it to the source.

## Bounded content-free origin

The original record digest is SHA-256 of UTF-8 JCS of the complete original record, before any operational timestamp flooring. `subject_sha256` and `source_uri_sha256` are SHA-256 of UTF-8 JCS of their original scalar values, including JSON `null` for a null subject. Never persist their raw text.

`event_contract` and `event_source` are string-valued SHA-256 digests of UTF-8 JCS of the complete original structured header objects. They are identity comparison data, not serialized header/payload objects, event-delivery instructions or grant authority. Source headers remain unchanged and ephemeral. No original application data or raw record JSON is copied into origin.

The target schema admits only its reviewed origin keys, string-valued identity/digest metadata, exact timestamps over four string-valued keys, and `data_erased: true`. Generation in origin is decimal text; the original numeric generation and existing operational bigint are preserved independently.

Validation budgets PostgreSQL JSONB's UTF-8 text representation (including colon/comma spacing), not compact JSON character counts. It also reserves the eventual erasure marker inside the same 2048-byte cap, so erasure can clear operational data while retaining origin/digest without exceeding the constraint. Unrepresentable Unicode/NUL metadata or over-cap input raises `timer_import_invalid` (409); no dropped field, truncation, default, alternate origin or partial-account flip is allowed.

Operational timestamps floor to microseconds. Exact source strings are retained only when nonzero sub-microsecond digits are lost. Identical re-import requires all operational values and origin/digest to match. Collision/drift or a previously erased origin refuses rather than resetting generation/state or restoring content.

## Effect guard and remaining integration gate

`migration-effects.ts` binds the original grant to its hosted collection owner and actual next registry, then invokes the strict original whole-account readback. The grant's member user and origin text are not owner/completion authority. Durable cohort, collection and flip participation keeps old-generation or orphan events in the migration scope after a timer is pruned.

The guard precedes API intent advancement/reconciliation, revoked-grant cancellation, firing/event insertion, receipt insertion and timer/event/receipt cleanup in the same transaction. Known pending completion leaves state unchanged; database/read failures propagate without a fallback. Native ordinary due rows retain the existing batch budget. Revocation and cleanup scan bounded keyset pages without shortening their existing full scope or changing the seven/fourteen-day retention thresholds. Fired events copy operational timestamps directly from SQL, avoiding a millisecond-only Date reconstruction.

Backend NEXT, current grant consent, origin metadata or a synthetic CP flip alone is insufficient. Runtime publication remains blocked until the whole-account producer is qualified. Native pushes use native identities; genuine late-fire-once/native-click and recovery tests remain required.

## Paged import caller and flip gate

`importHostedCollectionTimers` (`timers/hosted-import.ts`, CLI `next-timers copy-hosted <collection>`) imports one hosted collection whose account migration started and has not flipped:

1. Read the provider drain and notification watermark W. The source must be `migrating` or `migrated`, with a run and nothing in flight.
2. Read every page in one read-only snapshot of the legacy provider database. Each page's fence must name the same run. Each page imports in one transaction; every timer's grant must resolve to a cloud-copy grant of this collection (revoked grants still import). Any refusal stops the import; nothing is skipped.
3. Re-read the watermark; it must still be W on the same run.
4. In one transaction, require the collection's imported target rows to equal the source set exactly (count and an order-independent digest over runtime id, generation, status and record digest), then record a content-free `next_migration.timers_imported` audit manifest: run, head, W, count and digest.

A repeat imports nothing new and records the same manifest. Completion is derived from these rows; there is no completion flag or schema.

`flipAccountBackend` adds, for an account not yet flipped: the next timer service is enabled (`MDBASE_NEXT_TIMERS=1`); immediately before the flip transaction, each named collection's provider source is re-read and must be `migrated`; inside the transaction, each collection's latest manifest must name the same run and watermark, and the recomputed target identity must equal it. The idempotent retry of a completed flip skips these reads, because imported timers may fire after the flip.

## Run provenance and rollback cleanup (LAB)

Each imported page also records, in its own transaction, a `next_migration.timers_page_imported` audit event: the provider run (`migration_id`, `started_at`) and the origin record digests of that page's timers. An unfinished import's pages are recorded too. The timer origin JSONB itself is unchanged; its shape is closed by migration 0074.

A pre-cutover rollback leaves the earlier run's imported rows behind, and the strict import refuses the next run's changed timers with `timer_import_conflict`. In environment `lab` only, `POST /internal/v1/next/migration/collections/{id}/timers/rollback-cleanup {owner_account, started_us, migration_id}` (migration token) deletes that run's rows when:

- the presented claim is current: still legacy, no cutover, no flip, and no queued cutover policy;
- Connect recorded `next_migration.unfence` for that run, and the provider reports the source `active` with no run;
- every row the run's page events name is unchanged: generation and status equal to its origin, no data erasure, no `firing`, and no emitted event.

The deletion runs in one transaction under the namespace locks, advances each namespace's intent, and appends `next_migration.timers_rollback_cleanup` (run, count, digest). Manifests and page events stay. Native rows, rows of another run, and rows no page event names are never selected. A drifted row stops the cleanup with `timer_cleanup_drifted` and nothing is deleted; reconcile it explicitly. Other environments refuse with `migration_lab_only`.

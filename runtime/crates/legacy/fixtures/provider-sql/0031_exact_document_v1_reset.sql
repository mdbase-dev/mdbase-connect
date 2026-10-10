-- beta.39 deliberately rewrites prerelease sync v1 around one byte-authoritative
-- document. Earlier beta record ciphertext contains a wrapper with a second
-- document copy and cannot be interpreted without retaining a second protocol.
--
-- There is no stable data-compatibility promise yet. Reset only the persisted
-- record plane and its replay/checkpoint state. Collection identity, replicas,
-- resources, files, notification grants, account limits, and the shared
-- sequence head remain intact. The next exact-document client performs a fresh
-- snapshot; sequence gaps left by retired record changes are valid.

DELETE FROM hosted_provider_snapshot_leases;
DELETE FROM hosted_provider_mutation_journal;
DELETE FROM hosted_provider_mutation_tombstones;

-- Record notification payloads can embed the retired record shape. Their
-- source outbox and runtime-owned execution state are part of the record-plane
-- replay boundary; notification grants themselves remain authoritative.
DELETE FROM hosted_provider_runtime_outbox
WHERE event_type IN (
  'mdbase.record.created',
  'mdbase.record.modified',
  'mdbase.record.deleted',
  'mdbase.record.renamed'
);

DO $$
DECLARE
  runtime_table text;
BEGIN
  FOREACH runtime_table IN ARRAY ARRAY[
    'mdbase_runtime_timers',
    'mdbase_runtime_runs',
    'mdbase_runtime_event_dedup',
    'mdbase_runtime_events',
    'mdbase_runtime_meta'
  ] LOOP
    IF to_regclass('public.' || runtime_table) IS NOT NULL THEN
      EXECUTE format(
        'DELETE FROM %I WHERE namespace LIKE %L',
        runtime_table,
        'connect-hosted:%:notifications'
      );
    END IF;
  END LOOP;
END $$;

-- Migration 0025 retains opaque prerelease receipts for audit. Mark any
-- remaining rows retired so startup never rehydrates a wrapper-shaped receipt
-- into the exact-document journal after this reset.
UPDATE archived_hosted_mutation_receipts
SET migrated_at = COALESCE(migrated_at, now());

DELETE FROM hosted_provider_changes;
DELETE FROM hosted_provider_record_versions;
DELETE FROM hosted_provider_records;

-- Updating through the collection row also lets the account-usage trigger
-- reconcile live_content_bytes without a separate, drift-prone aggregate.
UPDATE hosted_provider_collections
SET record_count = 0,
    content_bytes = 0,
    updated_at = now()
WHERE record_count <> 0 OR content_bytes <> 0;

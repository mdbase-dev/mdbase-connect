-- Content-free provenance for imported legacy timers. Ordinary native timers
-- retain NULL; this origin is not authority or evidence of a completed flip.
-- Timer data remains only in existing operational columns. The source record's
-- JCS SHA-256 supports exact import comparison without duplicating its content.
-- Subject/source URI are SHA-256 of UTF-8 JCS of the original scalar (including
-- JSON null for a null subject), never their potentially content-bearing text.
-- Operational timestamps are floored to microseconds. Only when nonzero
-- sub-microsecond digits are lost, origin retains the exact original RFC3339
-- timestamp strings as content-free metadata (co0699); never round up.
ALTER TABLE next_timers
  ADD COLUMN legacy_import_origin jsonb,
  ADD CONSTRAINT next_timers_legacy_import_origin_object
    CHECK (legacy_import_origin IS NULL
      OR jsonb_typeof(legacy_import_origin) = 'object');

-- mdbase:next-timer-legacy-import-origin-shape:v1
-- IS TRUE prevents a missing required digest from passing via SQL UNKNOWN.
ALTER TABLE next_timers
  ADD CONSTRAINT next_timers_legacy_import_origin_shape CHECK (
    legacy_import_origin IS NULL OR (
      legacy_import_origin - ARRAY[
        'namespace', 'id', 'generation', 'status', 'fire_at',
        'event_contract', 'event_source', 'source_uri_sha256', 'subject_sha256',
        'runtime_id', 'record_sha256', 'exact_timestamps', 'data_erased'
      ]::text[] = '{}'::jsonb
      AND (NOT (legacy_import_origin ? 'namespace')
        OR jsonb_typeof(legacy_import_origin->'namespace') = 'string')
      AND (NOT (legacy_import_origin ? 'id')
        OR jsonb_typeof(legacy_import_origin->'id') = 'string')
      AND (NOT (legacy_import_origin ? 'generation')
        OR jsonb_typeof(legacy_import_origin->'generation') = 'string')
      AND (NOT (legacy_import_origin ? 'status')
        OR jsonb_typeof(legacy_import_origin->'status') = 'string')
      AND (NOT (legacy_import_origin ? 'fire_at')
        OR jsonb_typeof(legacy_import_origin->'fire_at') = 'string')
      AND (NOT (legacy_import_origin ? 'event_contract')
        OR jsonb_typeof(legacy_import_origin->'event_contract') = 'string')
      AND (NOT (legacy_import_origin ? 'event_source')
        OR jsonb_typeof(legacy_import_origin->'event_source') = 'string')
      AND (NOT (legacy_import_origin ? 'runtime_id')
        OR jsonb_typeof(legacy_import_origin->'runtime_id') = 'string')
      AND jsonb_typeof(legacy_import_origin->'record_sha256') = 'string'
      AND (legacy_import_origin->>'record_sha256') ~ '^[0-9a-f]{64}$'
      AND (NOT (legacy_import_origin ? 'data_erased')
        OR (legacy_import_origin->'data_erased') = 'true'::jsonb)
      AND (NOT (legacy_import_origin ? 'source_uri_sha256') OR (
        jsonb_typeof(legacy_import_origin->'source_uri_sha256') = 'string'
        AND (legacy_import_origin->>'source_uri_sha256') ~ '^[0-9a-f]{64}$'))
      AND (NOT (legacy_import_origin ? 'subject_sha256') OR (
        jsonb_typeof(legacy_import_origin->'subject_sha256') = 'string'
        AND (legacy_import_origin->>'subject_sha256') ~ '^[0-9a-f]{64}$'))
      AND (NOT (legacy_import_origin ? 'exact_timestamps') OR (
        jsonb_typeof(legacy_import_origin->'exact_timestamps') = 'object'
        AND (legacy_import_origin->'exact_timestamps')
          - ARRAY['fire_at', 'fired_at', 'updated_at', 'created_at']::text[] = '{}'::jsonb
        AND NOT jsonb_path_exists(legacy_import_origin->'exact_timestamps',
          '$.* ? (@.type() != "string")')))
      AND octet_length(legacy_import_origin::text) <= 2048
    ) IS TRUE
  );

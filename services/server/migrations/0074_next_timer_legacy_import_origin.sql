-- Content-free provenance for imported legacy timers. Ordinary native timers
-- retain NULL; this origin is not authority or evidence of a completed flip.
-- Timer data remains only in existing operational columns. The source record's
-- JCS SHA-256 supports exact import comparison without duplicating its content.
-- Operational timestamps are floored to microseconds. Only when nonzero
-- sub-microsecond digits are lost, origin retains the exact original RFC3339
-- timestamp strings as content-free metadata (co0699); never round up.
ALTER TABLE next_timers
  ADD COLUMN legacy_import_origin jsonb,
  ADD CONSTRAINT next_timers_legacy_import_origin_object
    CHECK (legacy_import_origin IS NULL
      OR jsonb_typeof(legacy_import_origin) = 'object');

-- A Private (end-to-end encrypted) native collection can be the target of an
-- application grant. Such a grant is only an offer: the collection's replica
-- admits the client after a device-signed grant approval, never on this row.
-- Bindings, approvals and revocation hooks keep referencing grants(id).
ALTER TABLE grants ADD COLUMN next_collection_id uuid
  REFERENCES next_collections(collection_id) ON DELETE CASCADE;
CREATE INDEX grants_next_collection_idx ON grants(next_collection_id)
  WHERE next_collection_id IS NOT NULL;

-- A native grant carries the same signed application authorization as a
-- local-connector grant.
ALTER TABLE grants ADD CONSTRAINT grants_next_application_authorization_required
  CHECK (
    next_collection_id IS NULL
    OR (
      application_authorization IS NOT NULL
      AND application_installation_id IS NOT NULL
      AND application_authorization->'binding'->>'protocol_version' IN ('4', '5')
    )
  );

-- mdbase:next-collection-grant-target:v1
-- Every grant names exactly one target. Discover the predecessor two-way
-- target CHECKs by definition: the unnamed baseline CHECK and the repaired
-- grants_collection_target_check may each be present.
DO $$
DECLARE old_constraint text; matches integer := 0;
BEGIN
  FOR old_constraint IN
    SELECT c.conname::text FROM pg_constraint c
    WHERE c.contype = 'c' AND c.conrelid = 'grants'::regclass
      AND pg_get_constraintdef(c.oid) ~ '\(collection_id IS NULL\) <> \(hosted_collection_id IS NULL\)'
      AND pg_get_constraintdef(c.oid) !~ 'next_collection_id'
  LOOP
    EXECUTE format('ALTER TABLE grants DROP CONSTRAINT %I', old_constraint);
    matches := matches + 1;
  END LOOP;
  IF matches = 0 THEN RAISE EXCEPTION 'Expected an original grant target check'; END IF;
END $$;
ALTER TABLE grants ADD CONSTRAINT grants_collection_target_check
  CHECK (num_nonnulls(collection_id, hosted_collection_id, next_collection_id) = 1);

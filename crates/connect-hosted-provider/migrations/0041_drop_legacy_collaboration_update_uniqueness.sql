-- SQLx/PostgreSQL truncate generated constraint identifiers, so migration 0040's
-- source-length names did not reliably address the two legacy UNIQUE clauses.
-- Remove them by their exact column definitions while retaining the
-- replica-scoped mutation-id key added in 0040.
DO $drop_legacy_collaboration_update_uniqueness$
DECLARE
  constraint_name text;
  definition text;
BEGIN
  FOR constraint_name, definition IN
    SELECT con.conname, pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    WHERE con.conrelid = 'hosted_provider_collaboration_updates'::regclass
      AND con.contype = 'u'
  LOOP
    IF definition = 'UNIQUE (collection_id, record_id, collaboration_epoch, profile, client_mutation_id)'
       OR definition = 'UNIQUE (collection_id, record_id, collaboration_epoch, profile, update_digest)' THEN
      EXECUTE format(
        'ALTER TABLE hosted_provider_collaboration_updates DROP CONSTRAINT %I',
        constraint_name
      );
    END IF;
  END LOOP;
END;
$drop_legacy_collaboration_update_uniqueness$;

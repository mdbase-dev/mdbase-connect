\set ON_ERROR_STOP on

-- Run from the candidate image only after the source provider is terminally
-- suspended by the service scheduler. PostgreSQL exposes every session's
-- existence and database to ordinary roles even when activity details are
-- redacted, so a zero count is a complete drain proof without granting the
-- application role pg_read_all_stats.
DO $hosted_database_drained$
DECLARE
  other_sessions bigint;
BEGIN
  SELECT count(*)
  INTO other_sessions
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid();

  IF other_sessions <> 0 THEN
    RAISE EXCEPTION
      'hosted_database_not_drained: other_sessions=%', other_sessions;
  END IF;
END
$hosted_database_drained$;

SELECT json_build_object(
  'database_drain', json_build_object(
    'visibility_attested', true,
    'visibility_basis', 'session_existence_and_database',
    'other_sessions', 0
  )
);

\set ON_ERROR_STOP on

-- Run from the candidate image only after the source provider is terminally
-- suspended by the service scheduler. The session must be able to see every
-- database session; otherwise a zero count would not be meaningful.
DO $hosted_database_drained$
DECLARE
  can_observe_all boolean :=
    current_setting('is_superuser')::boolean
    OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER');
  nonidle_sessions bigint;
  open_transactions bigint;
BEGIN
  IF NOT can_observe_all THEN
    RAISE EXCEPTION
      'hosted_database_drain_unverifiable: role % cannot observe all database sessions',
      current_user;
  END IF;

  SELECT count(*) FILTER (WHERE state <> 'idle'),
         count(*) FILTER (WHERE xact_start IS NOT NULL)
  INTO nonidle_sessions, open_transactions
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid();

  IF nonidle_sessions <> 0 OR open_transactions <> 0 THEN
    RAISE EXCEPTION
      'hosted_database_not_drained: nonidle_sessions=%, open_transactions=%',
      nonidle_sessions,
      open_transactions;
  END IF;
END
$hosted_database_drained$;

SELECT json_build_object(
  'database_drain', json_build_object(
    'visibility_attested', true,
    'nonidle_sessions', 0,
    'open_transactions', 0
  )
);

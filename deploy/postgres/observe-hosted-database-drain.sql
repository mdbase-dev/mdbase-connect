\set ON_ERROR_STOP on

-- Privacy-safe independent cutover observation. Session existence and database
-- are visible to ordinary roles even when activity details are redacted. The
-- terminal scheduler fence therefore requires zero other sessions of any state.
SELECT json_build_object(
  'database_activity', json_build_object(
    'visibility_attested', true,
    'visibility_basis', 'session_existence_and_database',
    'other_sessions', count(*)
  )
)::text
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid();

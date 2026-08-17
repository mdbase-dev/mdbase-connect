\set ON_ERROR_STOP on

-- Privacy-safe independent cutover observation. Idle pooled sessions may remain,
-- but no other session may be executing or retaining an open transaction.
SELECT json_build_object(
  'database_activity', json_build_object(
    'visibility_attested',
      current_setting('is_superuser')::boolean
      OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER'),
    'nonidle_sessions', count(*) FILTER (WHERE state <> 'idle'),
    'active_sessions', count(*) FILTER (WHERE state = 'active'),
    'open_transactions', count(*) FILTER (WHERE xact_start IS NOT NULL),
    'idle_sessions', count(*) FILTER (WHERE state = 'idle')
  )
)::text
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid();

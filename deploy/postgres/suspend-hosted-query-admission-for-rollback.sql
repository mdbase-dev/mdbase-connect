\set ON_ERROR_STOP on

BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);
UPDATE hosted_provider_runtime_control
SET query_admission_suspended = true,
    suspension_reason = 'controlled_provider_rollback',
    updated_at = now()
WHERE singleton = true;
COMMIT;

SELECT 'hosted_query_admission_suspended' AS result;

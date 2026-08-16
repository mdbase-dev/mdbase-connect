-- Ciphertext scan limits are part of the frozen execution proof. Existing
-- ephemeral cursors cannot infer that limit safely, so rollout drains them
-- before enabling proof v2 rather than silently assigning a wider budget.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM hosted_provider_query_cursors LIMIT 1) THEN
    RAISE EXCEPTION '0050 requires hosted_provider_query_cursors to be drained';
  END IF;
END
$$;

ALTER TABLE hosted_provider_query_cursors
  DROP CONSTRAINT hosted_provider_query_cursors_execution_proof_version_check,
  DROP CONSTRAINT hosted_provider_query_cursors_execution_proof_check,
  ADD COLUMN scan_budget_ciphertext_bytes bigint NOT NULL DEFAULT 1073741824
    CHECK (scan_budget_ciphertext_bytes > 0),
  ADD CONSTRAINT hosted_provider_query_cursors_execution_proof_version_check
    CHECK (execution_proof_version IN (0, 1, 2)),
  ADD CONSTRAINT hosted_provider_query_cursors_execution_proof_check CHECK (
    (
      execution_proof_version = 0
      AND execution_proof_ciphertext IS NULL
      AND execution_proof_bytes = 0
      AND projection_integrity_epoch IS NULL
    ) OR (
      execution_proof_version IN (1, 2)
      AND execution_proof_ciphertext IS NOT NULL
      AND execution_proof_bytes = octet_length(execution_proof_ciphertext)
      AND execution_proof_bytes > 0
    )
  );

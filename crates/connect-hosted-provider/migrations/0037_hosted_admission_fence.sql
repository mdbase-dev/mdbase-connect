-- Bind maintenance and rollback admission changes to one explicit operation.
-- This is a separate additive migration so the already-published consolidated
-- query-runtime migration remains immutable.

ALTER TABLE hosted_provider_runtime_control
  ADD COLUMN admission_fence_token uuid,
  ADD COLUMN admission_fence_kind text,
  ADD COLUMN admission_lease_expires_at timestamptz,
  ADD COLUMN admission_owner_expires_at timestamptz,
  ADD CONSTRAINT hosted_provider_runtime_control_fence_kind_check CHECK (
    admission_fence_kind IS NULL OR admission_fence_kind IN ('cutover', 'rollback')
  ),
  ADD CONSTRAINT hosted_provider_runtime_control_fence_pair_check CHECK (
    (admission_fence_token IS NULL) = (admission_fence_kind IS NULL)
  ),
  ADD CONSTRAINT hosted_provider_runtime_control_fence_state_check CHECK (
    query_admission_suspended
    OR admission_fence_token IS NULL
    OR admission_lease_expires_at IS NOT NULL
  ),
  ADD CONSTRAINT hosted_provider_runtime_control_lease_state_check CHECK (
    admission_lease_expires_at IS NULL
    OR (
      NOT query_admission_suspended
      AND admission_fence_token IS NOT NULL
      AND admission_fence_kind = 'cutover'
    )
  ),
  ADD CONSTRAINT hosted_provider_runtime_control_owner_state_check CHECK (
    (
      admission_fence_kind = 'cutover'
      AND admission_owner_expires_at IS NOT NULL
    )
    OR (
      admission_fence_kind IS DISTINCT FROM 'cutover'
      AND admission_owner_expires_at IS NULL
    )
  );

-- The archive is immutable after the beta69 baseline. This narrow partial
-- index makes bounded receipt conversion advance without rescanning retired
-- rows; it is not a projection/query index.
CREATE INDEX archived_hosted_mutation_receipts_unmigrated_idx
  ON archived_hosted_mutation_receipts (
    created_at, replica_id, mutation_id
  )
  WHERE migrated_at IS NULL;

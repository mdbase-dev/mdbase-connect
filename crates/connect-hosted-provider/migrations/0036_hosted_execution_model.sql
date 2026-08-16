-- Candidate B activation is explicit and collection scoped. Existing rows stay
-- on the recoverable legacy path until an isolated activation or approved
-- production rollout changes this value.
ALTER TABLE hosted_provider_collections
  ADD COLUMN hosted_execution_model text NOT NULL DEFAULT 'legacy'
    CHECK (hosted_execution_model IN ('legacy', 'candidate_b'));

CREATE INDEX hosted_provider_collections_projection_recovery_idx
  ON hosted_provider_collections (hosted_execution_model, updated_at, id)
  WHERE state = 'active' AND hosted_execution_model = 'candidate_b';

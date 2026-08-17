-- Initial Candidate B activation is prepared while legacy execution remains
-- available. Projection completion atomically binds the complete generation,
-- switches the execution model, and clears this durable intent.
ALTER TABLE hosted_provider_collections
  ADD COLUMN pending_hosted_execution_model text
    CHECK (pending_hosted_execution_model IS NULL
      OR pending_hosted_execution_model = 'candidate_b');

CREATE INDEX hosted_provider_collections_projection_activation_idx
  ON hosted_provider_collections (updated_at, id)
  WHERE state = 'active'
    AND pending_hosted_execution_model = 'candidate_b';

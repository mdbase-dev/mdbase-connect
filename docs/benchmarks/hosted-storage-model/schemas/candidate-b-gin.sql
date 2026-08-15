\ir candidate-b-no-gin.sql

ALTER SCHEMA candidate_b_no_gin RENAME TO candidate_b_gin;

CREATE INDEX record_projections_projection_gin
  ON candidate_b_gin.record_projections USING gin (semantic_projection jsonb_path_ops);

-- The GIN above is the only index difference from Candidate B-no-GIN.

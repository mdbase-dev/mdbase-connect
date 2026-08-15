\ir candidate-c-no-gin.sql

ALTER SCHEMA candidate_c_no_gin RENAME TO candidate_c_gin;

CREATE INDEX record_projections_projection_gin
  ON candidate_c_gin.record_projections USING gin (semantic_projection jsonb_path_ops);

-- The GIN above is the only index difference from Candidate C-no-GIN.

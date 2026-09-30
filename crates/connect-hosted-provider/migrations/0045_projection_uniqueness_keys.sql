-- A hosted write must validate its unique values against every other record
-- that shares them. Projection format 8 carries each record's uniqueness keys,
-- as emitted by mdbase-rs, so a write finds those records by containment
-- instead of scanning the collection. The index covers only that small array
-- of current projections, never the rest of the projection document.
CREATE INDEX hosted_provider_record_projections_uniqueness_keys_idx
  ON hosted_provider_record_projections
  USING gin ((semantic_projection -> 'uniqueness_keys') jsonb_path_ops)
  WHERE valid_to_sequence IS NULL;

-- Direction-specific execution evidence; intent remains in migration 0089.
ALTER TABLE next_collection_mode_changes
  ADD COLUMN source_epoch numeric(20,0),
  ADD COLUMN rekey_verified_at timestamptz,
  ADD COLUMN rekey_seq bigint,
  ADD COLUMN rekey_chain bytea;
ALTER TABLE next_collection_mode_changes
  ADD CONSTRAINT next_mode_source_epoch CHECK (source_epoch IS NULL OR (source_epoch > 0 AND source_epoch < 18446744073709551616)),
  ADD CONSTRAINT next_mode_rekey_receipt CHECK
    ((rekey_verified_at IS NULL AND rekey_seq IS NULL AND rekey_chain IS NULL) OR
     (rekey_verified_at IS NOT NULL AND rekey_seq IS NOT NULL AND rekey_chain IS NOT NULL AND rekey_seq > 1 AND octet_length(rekey_chain)=32));

-- Retain the original acknowledged bytes and ops, and schedule each lost batch
-- once. A replacement batch can itself be lost and reissued on a later sweep.
ALTER TABLE next_policy_batches ADD COLUMN lost_at timestamptz;
ALTER TABLE next_policy_outbox ADD COLUMN reissue_of bigint REFERENCES next_policy_batches(id);
CREATE UNIQUE INDEX next_policy_outbox_reissue_idx ON next_policy_outbox(reissue_of) WHERE reissue_of IS NOT NULL;
CREATE INDEX next_policy_batches_verify_idx ON next_policy_batches(collection_id, id)
  WHERE state = 'appended' AND lost_at IS NULL;

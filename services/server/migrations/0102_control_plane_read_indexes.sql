-- Indexes for the control plane's frequent reads, which until now scanned whole
-- tables. Additive only: the previous release runs unchanged beside them.
--
-- Policy history. Device, membership and enrolment checks read one
-- collection's outbox rows, often in id order; the existing partial index
-- covers only pending rows. Recovery and the batch foreign key (checked on every
-- batch delete) find outbox rows by batch. Genesis and recovery reads find a
-- collection's batches by sequence; the existing partial indexes cover only
-- open or verified batches. Both partial indexes stay: the outbox sweep and the
-- open-batch reads still use them.
CREATE INDEX next_policy_outbox_collection_idx ON next_policy_outbox(collection_id, id);
CREATE INDEX next_policy_outbox_batch_idx ON next_policy_outbox(batch_id);
CREATE INDEX next_policy_batches_collection_seq_idx ON next_policy_batches(collection_id, seq);

-- Grants are listed by account and cascade from a deleted local collection;
-- revocation updates tokens by grant, and a grant delete cascades into them.
CREATE INDEX grants_user_idx ON grants(user_id);
CREATE INDEX grants_collection_idx ON grants(collection_id)
  WHERE collection_id IS NOT NULL;
CREATE INDEX access_tokens_grant_idx ON access_tokens(grant_id);
CREATE INDEX refresh_tokens_grant_idx ON refresh_tokens(grant_id);

-- Owner intent is durable before any policy/key work. Policy publication uses the
-- existing outbox/batch ledger; an accepted request is not a completed conversion.
CREATE TABLE next_collection_mode_changes (
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_mode text NOT NULL CHECK (source_mode IN ('private', 'cloud_copy')),
  target_mode text NOT NULL CHECK (target_mode IN ('private', 'cloud_copy')),
  policy_outbox_id bigint REFERENCES next_policy_outbox(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (collection_id, request_id),
  CHECK (source_mode <> target_mode),
  CHECK (completed_at IS NULL OR policy_outbox_id IS NOT NULL)
);
CREATE UNIQUE INDEX next_collection_mode_changes_active_idx
  ON next_collection_mode_changes(collection_id) WHERE completed_at IS NULL;

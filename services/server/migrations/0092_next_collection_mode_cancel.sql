-- Cancellation is terminal only while no policy bytes can have been sent.
ALTER TABLE next_collection_mode_changes ADD COLUMN cancelled_at timestamptz;
ALTER TABLE next_collection_mode_changes ADD CONSTRAINT next_mode_cancel_terminal CHECK (cancelled_at IS NULL OR (completed_at IS NULL AND policy_outbox_id IS NULL));
DROP INDEX next_collection_mode_changes_active_idx;
CREATE UNIQUE INDEX next_collection_mode_changes_active_idx ON next_collection_mode_changes(collection_id) WHERE completed_at IS NULL AND cancelled_at IS NULL;

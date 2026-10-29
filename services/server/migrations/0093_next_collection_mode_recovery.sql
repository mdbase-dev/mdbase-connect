-- Observing occupation of the reserved slot releases policy, not key readiness.
ALTER TABLE next_collection_mode_changes
  ADD COLUMN policy_hold_released_at timestamptz,
  ADD COLUMN abandoned_at timestamptz;
ALTER TABLE next_collection_mode_changes ADD CONSTRAINT next_mode_abandon_terminal CHECK
  (abandoned_at IS NULL OR (target_mode='private' AND policy_outbox_id IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL));
DROP INDEX next_collection_mode_changes_active_idx;
CREATE UNIQUE INDEX next_collection_mode_changes_active_idx
  ON next_collection_mode_changes(collection_id)
  WHERE completed_at IS NULL AND cancelled_at IS NULL AND abandoned_at IS NULL;

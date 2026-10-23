-- The exact registered TaskNotes family (bundle:dev.tasknotes.app), one account
-- and collection. Manifest-specific application UUIDs are NOT predecessor IDs.
-- Survives installation sign-out and timer/receipt retention pruning.
CREATE TABLE next_tasknotes_legacy_reminder_retirements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, collection_id)
);

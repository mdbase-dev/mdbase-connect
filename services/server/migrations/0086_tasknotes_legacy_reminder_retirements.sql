-- Exact account, hard-coded TaskNotes family and collection. Versioned
-- manifest registrations have different application UUIDs but share this fence.
-- Survives installation sign-out and timer/receipt retention pruning.
CREATE TABLE next_tasknotes_legacy_reminder_retirements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_identity text NOT NULL CHECK (family_identity = 'bundle:dev.tasknotes.app'),
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, family_identity, collection_id)
);

-- Exact account, immutable registered application UUID and collection.
-- Different manifest registrations never share a retirement fence.
-- Survives installation sign-out and timer/receipt retention pruning.
CREATE TABLE next_tasknotes_legacy_reminder_retirements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, application_id, collection_id)
);

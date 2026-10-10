-- Portal confirmation belongs to this request, not inherited account selection.
-- Existing manual clients keep their historical receipts; there is no backfill.
ALTER TABLE installation_device_pairings
  ADD COLUMN portal_account_confirmed_at timestamptz,
  ADD COLUMN portal_account_email text,
  ADD COLUMN portal_account_session_id uuid,
  ADD COLUMN portal_account_session_epoch bigint,
  ADD COLUMN selected_collection_id uuid,
  ADD COLUMN created_collection_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT installation_portal_confirmation_complete CHECK (
    (portal_account_confirmed_at IS NULL AND portal_account_email IS NULL AND portal_account_session_id IS NULL AND portal_account_session_epoch IS NULL)
    OR (portal_account_confirmed_at IS NOT NULL AND portal_account_email IS NOT NULL AND portal_account_session_id IS NOT NULL AND portal_account_session_epoch IS NOT NULL)
  ),
  ADD CONSTRAINT installation_portal_created_selection CHECK (
    selected_collection_id IS NOT NULL OR cardinality(created_collection_ids)=0
  );

-- One immutable named creation intent per original approval request. Persist it
-- before calling the canonical creator; an interrupted call cannot pick a new UUID.
CREATE TABLE installation_pairing_collection_creations (
  pairing_id uuid PRIMARY KEY REFERENCES installation_device_pairings(pairing_id) ON DELETE CASCADE,
  collection_id uuid UNIQUE NOT NULL,
  display_name text NOT NULL,
  completed_at timestamptz
);

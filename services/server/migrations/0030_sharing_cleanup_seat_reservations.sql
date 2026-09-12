-- Account deletion removes member rows. Pending provider cleanup must retain
-- the owner's seat reservation independently of those account-owned rows.
ALTER TABLE provider_revocation_jobs
  ADD COLUMN seat_membership_id uuid,
  ADD COLUMN seat_owner_user_id uuid,
  ADD CONSTRAINT provider_revocation_jobs_seat_binding_complete CHECK (
    (seat_membership_id IS NULL AND seat_owner_user_id IS NULL)
    OR (seat_membership_id IS NOT NULL AND seat_owner_user_id IS NOT NULL)
  );

CREATE INDEX provider_revocation_jobs_pending_seats_idx
  ON provider_revocation_jobs(seat_owner_user_id, seat_membership_id)
  WHERE completed_at IS NULL AND seat_membership_id IS NOT NULL;

-- New entitlement profiles must opt into sharing deliberately.
ALTER TABLE entitlement_profiles ALTER COLUMN max_collection_member_seats SET DEFAULT 0;
UPDATE entitlement_profiles SET max_collection_member_seats = 10
  WHERE code IN ('beta_v1', 'open_beta_v1');

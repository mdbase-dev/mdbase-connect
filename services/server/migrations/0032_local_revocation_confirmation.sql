-- Reuse the connector's monotonic policy sequence, not a second delivery journal.
-- Historical/unbound revocations remain pending until snapshot construction binds
-- them under the connector lock and the enforcing connector acknowledges it.
ALTER TABLE grants ADD COLUMN revocation_policy_sequence bigint;
ALTER TABLE grants ADD COLUMN revocation_confirmed_at timestamptz;

ALTER TABLE policy_state ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_state ADD COLUMN lease_expires_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_state ADD COLUMN observed_at_ms INTEGER NOT NULL DEFAULT 0;
-- NULL is the additive old-store state. The first bearer-authenticated policy
-- snapshot pins this authority to one connector forever, including revocations.
ALTER TABLE policy_state ADD COLUMN connector_id TEXT;

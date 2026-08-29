-- Additive for rolling deploys: old servers ignore these columns. New servers
-- require the policy-freshness-lease-v1 connector capability before attaching.
ALTER TABLE connectors ADD COLUMN policy_sequence bigint NOT NULL DEFAULT 0;

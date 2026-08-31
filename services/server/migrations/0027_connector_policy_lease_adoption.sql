-- Lease negotiation and adoption are irreversible connector-level compatibility
-- boundaries. Negotiation is recorded before policy delivery; adoption is only
-- recorded after the exact initial generation is acknowledged.
ALTER TABLE connectors ADD COLUMN policy_lease_negotiated_at timestamptz;
ALTER TABLE connectors ADD COLUMN policy_lease_adopted_at timestamptz;
ALTER TABLE connectors ADD COLUMN latest_policy_mode text;
ALTER TABLE connectors ADD COLUMN latest_policy_mode_at timestamptz;
ALTER TABLE connectors ADD COLUMN latest_policy_ack_mode text;
ALTER TABLE connectors ADD COLUMN latest_policy_ack_generation bigint;
ALTER TABLE connectors ADD COLUMN latest_policy_ack_at timestamptz;

ALTER TABLE connectors ADD CONSTRAINT connectors_latest_policy_mode_check
  CHECK (latest_policy_mode IS NULL OR latest_policy_mode IN ('lease_v1', 'legacy_ack_v0'));
ALTER TABLE connectors ADD CONSTRAINT connectors_latest_policy_ack_mode_check
  CHECK (latest_policy_ack_mode IS NULL OR latest_policy_ack_mode IN ('lease_v1', 'legacy_ack_v0'));

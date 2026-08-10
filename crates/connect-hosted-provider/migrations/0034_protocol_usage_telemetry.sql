-- Privacy-minimal rollout telemetry. The hosted provider intentionally stores
-- only its account-scoped identity plus the protocol version and aggregate
-- timestamps/count. It does not retain replica, grant, application,
-- collection, operation, request, path, input, payload, or content identity.

CREATE TABLE IF NOT EXISTS hosted_provider_protocol_usage (
  account_id uuid NOT NULL
    REFERENCES hosted_provider_accounts(id) ON DELETE CASCADE,
  protocol_version integer NOT NULL CHECK (protocol_version > 0),
  sample_count bigint NOT NULL CHECK (sample_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, protocol_version)
);

CREATE INDEX IF NOT EXISTS hosted_provider_protocol_usage_recent_idx
  ON hosted_provider_protocol_usage (protocol_version, last_seen_at DESC);

-- Privacy-minimal compatibility telemetry. No request, application,
-- collection, operation, path, input, payload, or content identifiers are
-- retained. User identity is needed only to answer the rollout question:
-- how many beta users still depend on a legacy protocol?

CREATE TABLE IF NOT EXISTS protocol_usage_telemetry (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (surface IN ('direct', 'relay', 'hosted')),
  protocol_axis text NOT NULL CHECK (protocol_axis IN ('operation_transport')),
  protocol_version integer NOT NULL CHECK (protocol_version > 0),
  sample_count bigint NOT NULL CHECK (sample_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, surface, protocol_axis, protocol_version)
);

CREATE INDEX IF NOT EXISTS protocol_usage_telemetry_recent_idx
  ON protocol_usage_telemetry (protocol_axis, protocol_version, last_seen_at DESC);

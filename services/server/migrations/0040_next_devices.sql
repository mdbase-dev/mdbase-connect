-- mdbase-next devices registered independently of any log (mdbase-next
-- docs/ship/control-plane.md §3.1, §4.4; interface note
-- 2026-10-04-control-daemon-grant-feed-and-relay.md). A daemon device is bound 1:1 to
-- its connector, and is inactive whenever the connector is revoked. Grant client keys
-- are the app's Noise static keys registered at consent.
-- Key lengths are validated by the application (pg-mem has no octet_length).
-- New tables only: the previous release never reads them, and nothing writes them
-- unless MDBASE_NEXT_CONTROL_PLANE=1.
CREATE TABLE next_devices (
  id uuid PRIMARY KEY,
  connector_id uuid NOT NULL UNIQUE REFERENCES connectors(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('desktop', 'cli')),
  sign_pk bytea NOT NULL,
  kem_pk bytea NOT NULL,
  noise_pk bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE next_device_challenges (
  challenge bytea PRIMARY KEY,
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX next_device_challenges_expiry_idx ON next_device_challenges(expires_at);

CREATE TABLE next_grant_client_keys (
  grant_id uuid PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  client_pk bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

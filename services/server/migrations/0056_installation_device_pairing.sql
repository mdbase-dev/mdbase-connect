-- App/mobile windows on the SAME daemon approval channel. Public attested
-- identity survives an explicit expired/denied-window renewal; no new actor.
CREATE TABLE installation_device_pairings (
  pairing_id uuid PRIMARY KEY REFERENCES pairing_requests(id) ON DELETE CASCADE,
  previous_pairing_id uuid,
  installation_id uuid NOT NULL,
  device_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  app_id text NOT NULL,
  app_origin text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('app-runtime', 'mobile')),
  challenge bytea NOT NULL CHECK (octet_length(challenge) = 32),
  account_selected_at timestamptz,
  sign_pk bytea CHECK (sign_pk IS NULL OR octet_length(sign_pk) = 32),
  kem_pk bytea CHECK (kem_pk IS NULL OR octet_length(kem_pk) = 32),
  noise_pk bytea CHECK (noise_pk IS NULL OR octet_length(noise_pk) = 32),
  registration_sig bytea CHECK (registration_sig IS NULL OR octet_length(registration_sig) = 64),
  attested_at timestamptz,
  CHECK ((attested_at IS NULL AND sign_pk IS NULL AND kem_pk IS NULL AND noise_pk IS NULL AND registration_sig IS NULL)
      OR (attested_at IS NOT NULL AND sign_pk IS NOT NULL AND kem_pk IS NOT NULL AND noise_pk IS NOT NULL AND registration_sig IS NOT NULL))
);
CREATE INDEX installation_device_pairings_installation ON installation_device_pairings(installation_id);
CREATE INDEX installation_device_pairings_device ON installation_device_pairings(device_id);

-- Credential lifetime belongs to the registered connector/device, NOT to the
-- transient pairing window. pairing_id is an outcome reference, deliberately
-- not a cascading FK. Deleting/pruning a window cannot revoke a device.
CREATE TABLE installation_device_credentials (
  pairing_id uuid NOT NULL UNIQUE,
  connector_id uuid PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  device_id uuid NOT NULL UNIQUE REFERENCES next_devices(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL UNIQUE,
  app_id text NOT NULL,
  app_origin text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('app-runtime', 'mobile')),
  sign_pk bytea NOT NULL CHECK (octet_length(sign_pk) = 32),
  kem_pk bytea NOT NULL CHECK (octet_length(kem_pk) = 32),
  noise_pk bytea NOT NULL CHECK (octet_length(noise_pk) = 32),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

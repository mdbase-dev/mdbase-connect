-- Additive app/mobile state on the SAME daemon pairing approval channel.
-- Original request = pairing_requests.id. No bearer/pairing secret is stored.
CREATE TABLE installation_device_pairings (
  pairing_id uuid PRIMARY KEY REFERENCES pairing_requests(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL UNIQUE,
  device_id uuid NOT NULL UNIQUE,
  connector_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('app-runtime', 'mobile')),
  challenge bytea NOT NULL,
  account_selected_at timestamptz,
  sign_pk bytea,
  kem_pk bytea,
  noise_pk bytea,
  registration_sig bytea,
  attested_at timestamptz,
  CHECK (octet_length(challenge) = 32),
  CHECK (sign_pk IS NULL OR octet_length(sign_pk) = 32),
  CHECK (kem_pk IS NULL OR octet_length(kem_pk) = 32),
  CHECK (noise_pk IS NULL OR octet_length(noise_pk) = 32),
  CHECK (registration_sig IS NULL OR octet_length(registration_sig) = 64),
  CHECK ((attested_at IS NULL AND sign_pk IS NULL AND kem_pk IS NULL AND noise_pk IS NULL AND registration_sig IS NULL)
      OR (attested_at IS NOT NULL AND sign_pk IS NOT NULL AND kem_pk IS NOT NULL AND noise_pk IS NOT NULL AND registration_sig IS NOT NULL))
);

-- Installation credentials are NOT ordinary desktop/controller credentials.
-- Only explicitly opted-in next device/cloud/log endpoints may resolve them.
CREATE TABLE installation_device_credentials (
  pairing_id uuid PRIMARY KEY REFERENCES installation_device_pairings(pairing_id) ON DELETE CASCADE,
  connector_id uuid NOT NULL UNIQUE REFERENCES connectors(id) ON DELETE CASCADE,
  device_id uuid NOT NULL UNIQUE REFERENCES next_devices(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

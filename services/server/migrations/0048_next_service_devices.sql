-- mdbase-next service devices: the hosted replica and escrow members of a cloud-copy
-- collection (mdbase-next interface note 2026-10-04-control-hosted-replica.md §2).
-- Public keys only. `wrapped_keys` is the deployment's KMS-wrapped private keys, which
-- the control plane stores and returns but can never unwrap. The composite key admits
-- rows only for cloud_copy collections. The writer validates the record as well.
CREATE TABLE next_service_devices (
  collection_id uuid NOT NULL,
  sync text NOT NULL DEFAULT 'cloud_copy' CHECK (sync = 'cloud_copy'),
  kind text NOT NULL CHECK (kind IN ('hosted', 'escrow')),
  device_id uuid NOT NULL UNIQUE,
  sign_pk bytea NOT NULL CHECK (octet_length(sign_pk) = 32),
  kem_pk bytea NOT NULL CHECK (octet_length(kem_pk) = 32),
  noise_pk bytea NOT NULL CHECK (octet_length(noise_pk) = 32),
  wrapped_keys bytea NOT NULL CHECK (octet_length(wrapped_keys) BETWEEN 1 AND 65536),
  kms_key_arn text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, kind),
  FOREIGN KEY (collection_id, sync) REFERENCES next_collections(collection_id, sync) ON DELETE CASCADE
);

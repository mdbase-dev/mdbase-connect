CREATE TABLE hosted_provider_mutation_journal (
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  grant_id uuid,
  request_id uuid NOT NULL,
  operation_kind text NOT NULL,
  fingerprint_schema_version integer NOT NULL DEFAULT 1
    CHECK (fingerprint_schema_version IN (0, 1)),
  input_schema_version integer NOT NULL CHECK (input_schema_version > 0),
  input_digest bytea NOT NULL,
  state text NOT NULL CHECK (state IN (
    'claimed', 'prepared', 'applied', 'completed', 'acknowledged',
    'abandoned', 'outcome_unknown'
  )),
  process_epoch uuid NOT NULL,
  lease_owner uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  fencing_generation bigint NOT NULL CHECK (fencing_generation > 0),
  prepared_head bigint CHECK (prepared_head IS NULL OR prepared_head >= 0),
  prepared_ciphertext bytea,
  evidence_ciphertext bytea,
  evidence_kind text CHECK (evidence_kind IN ('public_result', 'sync_effect')),
  effect_applied boolean,
  final_receipt_ciphertext bytea,
  receipt_digest bytea,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  acknowledged_at timestamptz,
  PRIMARY KEY (replica_id, request_id),
  CHECK (
    (state IN ('completed', 'acknowledged', 'abandoned', 'outcome_unknown')
      AND final_receipt_ciphertext IS NOT NULL
      AND receipt_digest IS NOT NULL
      AND completed_at IS NOT NULL)
    OR
    (state IN ('claimed', 'prepared', 'applied')
      AND final_receipt_ciphertext IS NULL
      AND receipt_digest IS NULL
      AND completed_at IS NULL)
  ),
  CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL)),
  CHECK (state <> 'applied' OR (
    evidence_ciphertext IS NOT NULL AND evidence_kind IS NOT NULL
  )),
  CHECK (evidence_ciphertext IS NULL OR evidence_kind IS NOT NULL)
);

CREATE INDEX hosted_provider_mutation_journal_state_age_idx
  ON hosted_provider_mutation_journal (state, updated_at);
CREATE INDEX hosted_provider_mutation_journal_lease_idx
  ON hosted_provider_mutation_journal (state, process_epoch, lease_expires_at);

CREATE TABLE hosted_provider_mutation_tombstones (
  replica_id uuid NOT NULL,
  grant_id uuid,
  request_id uuid NOT NULL,
  operation_kind text NOT NULL,
  fingerprint_schema_version integer NOT NULL DEFAULT 1
    CHECK (fingerprint_schema_version IN (0, 1)),
  input_schema_version integer NOT NULL CHECK (input_schema_version > 0),
  input_digest bytea NOT NULL,
  terminal_state text NOT NULL CHECK (terminal_state IN (
    'completed', 'acknowledged', 'abandoned', 'outcome_unknown'
  )),
  receipt_digest bytea NOT NULL,
  accepted_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  tombstoned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (replica_id, request_id),
  CHECK (expires_at > tombstoned_at)
);

CREATE INDEX hosted_provider_mutation_tombstones_expiry_idx
  ON hosted_provider_mutation_tombstones (expires_at);

-- Retired bearer hashes and browser proof metadata are authentication material
-- only for exact terminal receipt replay. They must never authorize new work.
CREATE TABLE hosted_provider_retired_replay_credentials (
  id bigserial PRIMARY KEY,
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL,
  allowed_origin text,
  proof_public_key text,
  retired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > retired_at)
);

CREATE INDEX hosted_provider_retired_replay_credentials_token_idx
  ON hosted_provider_retired_replay_credentials (token_hash, expires_at);

INSERT INTO hosted_provider_retired_replay_credentials (
  replica_id, token_hash, allowed_origin, proof_public_key, retired_at, expires_at
)
SELECT id, token_hash, allowed_origin, proof_public_key, revoked_at,
       revoked_at + interval '365 days'
FROM hosted_provider_replicas
WHERE purpose = 'application' AND revoked_at IS NOT NULL;

-- Preserve beta receipts losslessly. Their old hashes and AAD are not used by
-- the new runtime journal, so these are explicitly archival rather than dual
-- replay paths.
CREATE TABLE archived_hosted_operation_requests AS
  TABLE hosted_provider_operation_requests WITH DATA;
CREATE UNIQUE INDEX archived_hosted_operation_requests_identity
  ON archived_hosted_operation_requests (replica_id, request_id);

DROP TABLE hosted_provider_operation_requests;

CREATE TABLE archived_hosted_mutation_receipts AS
  TABLE hosted_provider_mutation_receipts WITH DATA;
CREATE UNIQUE INDEX archived_hosted_mutation_receipts_identity
  ON archived_hosted_mutation_receipts (replica_id, mutation_id);

ALTER TABLE archived_hosted_mutation_receipts
  ADD COLUMN migrated_at timestamptz;

DROP TABLE hosted_provider_mutation_receipts;

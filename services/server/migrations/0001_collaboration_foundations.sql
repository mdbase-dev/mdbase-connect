ALTER TABLE hosted_replicas
  ADD COLUMN IF NOT EXISTS authorized_user_id uuid REFERENCES users(id);

UPDATE hosted_replicas
SET authorized_user_id = grant_record.user_id
FROM grants grant_record
WHERE grant_record.hosted_replica_id = hosted_replicas.id
  AND hosted_replicas.authorized_user_id IS NULL;

UPDATE hosted_replicas
SET authorized_user_id = pairing.user_id
FROM mirror_pairing_requests pairing
WHERE pairing.replica_id = hosted_replicas.id
  AND pairing.user_id IS NOT NULL
  AND hosted_replicas.authorized_user_id IS NULL;

UPDATE hosted_replicas
SET authorized_user_id = collection.user_id
FROM hosted_collections collection
WHERE collection.id = hosted_replicas.collection_id
  AND hosted_replicas.authorized_user_id IS NULL;

CREATE INDEX IF NOT EXISTS hosted_replicas_user_collection_idx
  ON hosted_replicas(collection_id, authorized_user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS provider_revocation_jobs (
  id uuid PRIMARY KEY,
  replica_id uuid NOT NULL,
  grant_id uuid,
  collection_id uuid NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'completed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_revocation_jobs_active_replica_idx
  ON provider_revocation_jobs(replica_id)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS provider_revocation_jobs_ready_idx
  ON provider_revocation_jobs(state, available_at)
  WHERE completed_at IS NULL;

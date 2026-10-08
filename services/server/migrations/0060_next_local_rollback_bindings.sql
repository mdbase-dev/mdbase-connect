-- One immutable result per local collection + caller-durable rollback ID.
-- This is preparation metadata, not a backend reversal or grant authorization.
CREATE TABLE next_local_rollback_bindings (
  collection_id uuid NOT NULL,
  rollback_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_connector_id uuid NOT NULL,
  legacy_collection_ids uuid[] NOT NULL,
  caller_connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, rollback_id)
);
-- Old identity/inventory remain immutable audit metadata even if that connector
-- is later removed. Every replay independently rechecks live ownership/identity.

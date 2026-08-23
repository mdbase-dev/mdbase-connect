-- Phase 3A: encrypted hosted collaboration storage.  This migration is
-- additive; no transport or capability is enabled by these relations.
ALTER TABLE hosted_provider_replicas
  ADD CONSTRAINT hosted_provider_replicas_id_collection_key UNIQUE (id, collection_id);

ALTER TABLE hosted_provider_collections
  ADD COLUMN collaboration_bytes bigint NOT NULL DEFAULT 0
    CHECK (collaboration_bytes >= 0),
  ADD COLUMN max_collaboration_bytes bigint NOT NULL DEFAULT 268435456
    CHECK (max_collaboration_bytes > 0);

ALTER TABLE hosted_provider_accounts
  ADD COLUMN live_collaboration_bytes bigint NOT NULL DEFAULT 0
    CHECK (live_collaboration_bytes >= 0),
  ADD COLUMN max_collaboration_bytes bigint NOT NULL DEFAULT 268435456
    CHECK (max_collaboration_bytes > 0);

CREATE TABLE hosted_provider_collaboration_documents (
  collection_id uuid NOT NULL,
  record_id uuid NOT NULL,
  collaboration_epoch bigint NOT NULL CHECK (collaboration_epoch > 0),
  profile text NOT NULL CHECK (profile = 'markdown-body-yjs-v13'),
  snapshot_ciphertext bytea NOT NULL,
  state_vector_ciphertext bytea NOT NULL,
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  materialized_revision text NOT NULL,
  snapshot_sequence bigint NOT NULL DEFAULT 0 CHECK (snapshot_sequence >= 0),
  retained_update_count bigint NOT NULL DEFAULT 0 CHECK (retained_update_count >= 0),
  retained_update_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_update_bytes >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed', 'rebuilding')),
  collaboration_bytes bigint NOT NULL DEFAULT 0 CHECK (collaboration_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, record_id, collaboration_epoch, profile),
  UNIQUE (collection_id, record_id, collaboration_epoch),
  FOREIGN KEY (collection_id, record_id)
    REFERENCES hosted_provider_records(collection_id, record_id) ON DELETE CASCADE
);

CREATE INDEX hosted_provider_collaboration_documents_state_idx
  ON hosted_provider_collaboration_documents (state, updated_at);

CREATE TABLE hosted_provider_collaboration_updates (
  collection_id uuid NOT NULL,
  record_id uuid NOT NULL,
  collaboration_epoch bigint NOT NULL CHECK (collaboration_epoch > 0),
  profile text NOT NULL CHECK (profile = 'markdown-body-yjs-v13'),
  sequence bigint NOT NULL CHECK (sequence > 0),
  update_ciphertext bytea NOT NULL,
  update_digest bytea NOT NULL,
  replica_id uuid,
  client_mutation_id uuid NOT NULL,
  materialized_revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, record_id, collaboration_epoch, profile, sequence),
  UNIQUE (collection_id, record_id, collaboration_epoch, profile, client_mutation_id),
  UNIQUE (collection_id, record_id, collaboration_epoch, profile, update_digest),
  FOREIGN KEY (collection_id, record_id, collaboration_epoch, profile)
    REFERENCES hosted_provider_collaboration_documents(collection_id, record_id, collaboration_epoch, profile)
    ON DELETE CASCADE,
  FOREIGN KEY (replica_id, collection_id)
    REFERENCES hosted_provider_replicas(id, collection_id) ON DELETE SET NULL
);

CREATE INDEX hosted_provider_collaboration_updates_replay_idx
  ON hosted_provider_collaboration_updates
    (collection_id, record_id, collaboration_epoch, profile, sequence);

CREATE TABLE hosted_provider_collaboration_receipts (
  collection_id uuid NOT NULL,
  record_id uuid NOT NULL,
  collaboration_epoch bigint NOT NULL CHECK (collaboration_epoch > 0),
  profile text NOT NULL CHECK (profile = 'markdown-body-yjs-v13'),
  replica_id uuid NOT NULL,
  client_mutation_id uuid NOT NULL,
  mutation_digest bytea NOT NULL,
  receipt_ciphertext bytea NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, record_id, collaboration_epoch, profile, replica_id, client_mutation_id),
  UNIQUE (collection_id, record_id, collaboration_epoch, profile, mutation_digest),
  FOREIGN KEY (collection_id, record_id, collaboration_epoch, profile)
    REFERENCES hosted_provider_collaboration_documents(collection_id, record_id, collaboration_epoch, profile)
    ON DELETE CASCADE,
  FOREIGN KEY (replica_id, collection_id)
    REFERENCES hosted_provider_replicas(id, collection_id) ON DELETE CASCADE
);

CREATE TABLE hosted_provider_collaboration_tickets (
  ticket_hash bytea PRIMARY KEY,
  replica_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  record_id uuid NOT NULL,
  collaboration_epoch bigint NOT NULL CHECK (collaboration_epoch > 0),
  profile text NOT NULL CHECK (profile = 'markdown-body-yjs-v13'),
  mode text NOT NULL CHECK (mode IN ('read_only', 'read_write')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(ticket_hash) > 0),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  FOREIGN KEY (replica_id, collection_id)
    REFERENCES hosted_provider_replicas(id, collection_id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id, record_id, collaboration_epoch, profile)
    REFERENCES hosted_provider_collaboration_documents(collection_id, record_id, collaboration_epoch, profile)
    ON DELETE CASCADE
);

CREATE INDEX hosted_provider_collaboration_tickets_expiry_idx
  ON hosted_provider_collaboration_tickets (expires_at);

CREATE OR REPLACE FUNCTION hosted_provider_validate_collaboration_ticket_consumption()
RETURNS trigger AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR NEW.consumed_at > NEW.expires_at OR NEW.consumed_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'collaboration_ticket_not_single_use_or_expired';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hosted_provider_collaboration_ticket_consumption
BEFORE UPDATE OF consumed_at ON hosted_provider_collaboration_tickets
FOR EACH ROW WHEN (OLD.consumed_at IS DISTINCT FROM NEW.consumed_at)
EXECUTE FUNCTION hosted_provider_validate_collaboration_ticket_consumption();

-- Keep collaboration overhead separate from ordinary content/file accounting.
CREATE OR REPLACE FUNCTION hosted_provider_apply_account_usage()
RETURNS trigger AS $$
DECLARE
  target_account uuid;
  collection_delta bigint := 0;
  content_delta bigint := 0;
  file_delta bigint := 0;
  retained_delta bigint := 0;
  collaboration_delta bigint := 0;
  account_row hosted_provider_accounts%ROWTYPE;
  reconciliation boolean :=
    COALESCE(current_setting('mdbase.quota_reconciliation', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_account := NEW.account_id;
    collection_delta := 1;
    content_delta := NEW.content_bytes;
    file_delta := NEW.file_bytes;
    retained_delta := NEW.stored_file_bytes;
    collaboration_delta := NEW.collaboration_bytes;
  ELSIF TG_OP = 'DELETE' THEN
    target_account := OLD.account_id;
    collection_delta := -1;
    content_delta := -OLD.content_bytes;
    file_delta := -OLD.file_bytes;
    retained_delta := -OLD.stored_file_bytes;
    collaboration_delta := -OLD.collaboration_bytes;
  ELSIF OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    IF OLD.account_id IS NOT NULL THEN
      UPDATE hosted_provider_accounts SET
        collection_count = collection_count - 1,
        live_content_bytes = live_content_bytes - OLD.content_bytes,
        live_file_bytes = live_file_bytes - OLD.file_bytes,
        retained_file_bytes = retained_file_bytes - OLD.stored_file_bytes,
        live_collaboration_bytes = live_collaboration_bytes - OLD.collaboration_bytes,
        updated_at = now() WHERE id = OLD.account_id;
    END IF;
    target_account := NEW.account_id;
    collection_delta := 1;
    content_delta := NEW.content_bytes;
    file_delta := NEW.file_bytes;
    retained_delta := NEW.stored_file_bytes;
    collaboration_delta := NEW.collaboration_bytes;
  ELSE
    target_account := NEW.account_id;
    content_delta := NEW.content_bytes - OLD.content_bytes;
    file_delta := NEW.file_bytes - OLD.file_bytes;
    retained_delta := NEW.stored_file_bytes - OLD.stored_file_bytes;
    collaboration_delta := NEW.collaboration_bytes - OLD.collaboration_bytes;
  END IF;
  IF target_account IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO account_row FROM hosted_provider_accounts
    WHERE id = target_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'hosted_provider_account_missing';
  END IF;
  IF NOT reconciliation AND collection_delta > 0
     AND account_row.collection_count + collection_delta > account_row.max_collections THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_collection_quota_exceeded';
  END IF;
  IF NOT reconciliation AND content_delta + file_delta > 0
     AND account_row.live_content_bytes + account_row.live_file_bytes
       + content_delta + file_delta > account_row.max_live_storage_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_storage_quota_exceeded';
  END IF;
  IF NOT reconciliation AND retained_delta > 0
     AND account_row.retained_file_bytes + retained_delta > account_row.max_retained_file_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_retained_storage_quota_exceeded';
  END IF;
  IF NOT reconciliation AND collaboration_delta > 0
     AND account_row.live_collaboration_bytes + collaboration_delta > account_row.max_collaboration_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_collaboration_quota_exceeded';
  END IF;
  UPDATE hosted_provider_accounts SET
    collection_count = collection_count + collection_delta,
    live_content_bytes = live_content_bytes + content_delta,
    live_file_bytes = live_file_bytes + file_delta,
    retained_file_bytes = retained_file_bytes + retained_delta,
    live_collaboration_bytes = live_collaboration_bytes + collaboration_delta,
    updated_at = now() WHERE id = target_account;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hosted_provider_collection_account_usage
  ON hosted_provider_collections;
CREATE TRIGGER hosted_provider_collection_account_usage
AFTER INSERT OR DELETE OR UPDATE OF account_id, content_bytes, file_bytes,
  stored_file_bytes, collaboration_bytes
ON hosted_provider_collections FOR EACH ROW
EXECUTE FUNCTION hosted_provider_apply_account_usage();

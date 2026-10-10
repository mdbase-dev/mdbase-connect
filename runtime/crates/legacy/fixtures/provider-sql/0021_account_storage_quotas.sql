CREATE TABLE IF NOT EXISTS hosted_provider_accounts (
  id uuid PRIMARY KEY,
  entitlement_revision bigint NOT NULL CHECK (entitlement_revision > 0),
  max_live_storage_bytes bigint NOT NULL CHECK (max_live_storage_bytes > 0),
  max_retained_file_bytes bigint NOT NULL CHECK (max_retained_file_bytes >= max_live_storage_bytes),
  max_document_bytes bigint NOT NULL CHECK (max_document_bytes > 0),
  max_single_file_bytes bigint NOT NULL CHECK (max_single_file_bytes > 0),
  max_replicas_per_collection bigint NOT NULL CHECK (max_replicas_per_collection > 0),
  max_collections bigint NOT NULL CHECK (max_collections > 0),
  max_files_per_collection bigint NOT NULL CHECK (max_files_per_collection > 0),
  collection_count bigint NOT NULL DEFAULT 0 CHECK (collection_count >= 0),
  live_content_bytes bigint NOT NULL DEFAULT 0 CHECK (live_content_bytes >= 0),
  live_file_bytes bigint NOT NULL DEFAULT 0 CHECK (live_file_bytes >= 0),
  retained_file_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_file_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE hosted_provider_collections
  ADD COLUMN IF NOT EXISTS account_id uuid
    REFERENCES hosted_provider_accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS hosted_provider_collections_account_idx
  ON hosted_provider_collections(account_id)
  WHERE account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION hosted_provider_apply_account_usage()
RETURNS trigger AS $$
DECLARE
  target_account uuid;
  collection_delta bigint := 0;
  content_delta bigint := 0;
  file_delta bigint := 0;
  retained_delta bigint := 0;
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
  ELSIF TG_OP = 'DELETE' THEN
    target_account := OLD.account_id;
    collection_delta := -1;
    content_delta := -OLD.content_bytes;
    file_delta := -OLD.file_bytes;
    retained_delta := -OLD.stored_file_bytes;
  ELSIF OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    IF OLD.account_id IS NOT NULL THEN
      UPDATE hosted_provider_accounts SET
        collection_count = collection_count - 1,
        live_content_bytes = live_content_bytes - OLD.content_bytes,
        live_file_bytes = live_file_bytes - OLD.file_bytes,
        retained_file_bytes = retained_file_bytes - OLD.stored_file_bytes,
        updated_at = now()
      WHERE id = OLD.account_id;
    END IF;
    target_account := NEW.account_id;
    collection_delta := 1;
    content_delta := NEW.content_bytes;
    file_delta := NEW.file_bytes;
    retained_delta := NEW.stored_file_bytes;
  ELSE
    target_account := NEW.account_id;
    content_delta := NEW.content_bytes - OLD.content_bytes;
    file_delta := NEW.file_bytes - OLD.file_bytes;
    retained_delta := NEW.stored_file_bytes - OLD.stored_file_bytes;
  END IF;

  IF target_account IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO account_row
  FROM hosted_provider_accounts
  WHERE id = target_account
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'hosted_provider_account_missing';
  END IF;

  IF NOT reconciliation
     AND collection_delta > 0
     AND account_row.collection_count + collection_delta > account_row.max_collections THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'account_collection_quota_exceeded';
  END IF;
  IF NOT reconciliation
     AND content_delta + file_delta > 0
     AND account_row.live_content_bytes + account_row.live_file_bytes
           + content_delta + file_delta > account_row.max_live_storage_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'account_storage_quota_exceeded';
  END IF;
  IF NOT reconciliation
     AND retained_delta > 0
     AND account_row.retained_file_bytes + retained_delta
           > account_row.max_retained_file_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'account_retained_storage_quota_exceeded';
  END IF;

  UPDATE hosted_provider_accounts SET
    collection_count = collection_count + collection_delta,
    live_content_bytes = live_content_bytes + content_delta,
    live_file_bytes = live_file_bytes + file_delta,
    retained_file_bytes = retained_file_bytes + retained_delta,
    updated_at = now()
  WHERE id = target_account;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hosted_provider_collection_account_usage
  ON hosted_provider_collections;
CREATE TRIGGER hosted_provider_collection_account_usage
AFTER INSERT OR DELETE OR UPDATE OF account_id, content_bytes, file_bytes, stored_file_bytes
ON hosted_provider_collections
FOR EACH ROW EXECUTE FUNCTION hosted_provider_apply_account_usage();

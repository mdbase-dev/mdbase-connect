CREATE TABLE IF NOT EXISTS hosted_provider_resource_changes (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  type_name text NOT NULL,
  path text NOT NULL,
  revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, sequence)
);

CREATE INDEX IF NOT EXISTS hosted_provider_resource_changes_type_idx
  ON hosted_provider_resource_changes (collection_id, type_name, sequence);

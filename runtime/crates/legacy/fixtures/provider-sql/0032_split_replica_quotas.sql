ALTER TABLE hosted_provider_accounts
  RENAME COLUMN max_replicas_per_collection
  TO max_mirror_replicas_per_collection;

ALTER TABLE hosted_provider_accounts
  ADD COLUMN max_application_replicas_per_collection bigint
    NOT NULL DEFAULT 50
    CHECK (max_application_replicas_per_collection > 0);

ALTER TABLE hosted_provider_accounts
  ALTER COLUMN max_application_replicas_per_collection DROP DEFAULT;

ALTER TABLE hosted_provider_collections
  RENAME COLUMN max_replicas TO max_mirror_replicas;

ALTER TABLE hosted_provider_collections
  ADD COLUMN max_application_replicas bigint
    NOT NULL DEFAULT 50
    CHECK (max_application_replicas > 0);

ALTER TABLE hosted_provider_collections
  ALTER COLUMN max_application_replicas DROP DEFAULT;

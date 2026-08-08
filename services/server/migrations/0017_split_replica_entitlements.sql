ALTER TABLE entitlement_profiles
  RENAME COLUMN max_replicas_per_collection
  TO max_mirror_replicas_per_collection;

ALTER TABLE entitlement_profiles
  ADD COLUMN max_application_replicas_per_collection bigint
    NOT NULL DEFAULT 50
    CHECK (max_application_replicas_per_collection > 0);

ALTER TABLE entitlement_profiles
  ALTER COLUMN max_application_replicas_per_collection DROP DEFAULT;

UPDATE entitlement_profiles
SET max_mirror_replicas_per_collection = 10,
    max_application_replicas_per_collection = 50
WHERE code = 'beta_v1';

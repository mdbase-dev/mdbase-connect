ALTER TABLE hosted_provider_replicas
ADD COLUMN full_collection boolean;

-- Preserve the meaning of application capabilities issued before this field
-- existed. Mirror replicas do not use this authorization bit.
UPDATE hosted_provider_replicas
SET full_collection = purpose = 'application' AND cardinality(allowed_types) = 0;

ALTER TABLE hosted_provider_replicas
  ALTER COLUMN full_collection SET DEFAULT false,
  ALTER COLUMN full_collection SET NOT NULL;

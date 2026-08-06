ALTER TABLE hosted_provider_collections
  ADD COLUMN IF NOT EXISTS timezone text;

UPDATE hosted_provider_collections
SET timezone = 'UTC'
WHERE timezone IS NULL;

ALTER TABLE hosted_provider_collections
  ALTER COLUMN timezone SET NOT NULL;

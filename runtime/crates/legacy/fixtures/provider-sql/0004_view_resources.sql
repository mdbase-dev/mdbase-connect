ALTER TABLE hosted_provider_resources
  DROP CONSTRAINT IF EXISTS hosted_provider_resources_kind_check;

ALTER TABLE hosted_provider_resources
  ADD CONSTRAINT hosted_provider_resources_kind_check
  CHECK (kind IN ('configuration', 'type', 'view'));

ALTER TABLE hosted_provider_resource_changes
  ADD COLUMN IF NOT EXISTS resource_kind text NOT NULL DEFAULT 'type'
  CHECK (resource_kind IN ('type', 'view'));

ALTER TABLE hosted_provider_resource_changes
  ALTER COLUMN type_name DROP NOT NULL;

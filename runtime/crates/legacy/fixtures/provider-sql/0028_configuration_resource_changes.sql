ALTER TABLE hosted_provider_resource_changes
  DROP CONSTRAINT IF EXISTS hosted_provider_resource_changes_resource_kind_check;

ALTER TABLE hosted_provider_resource_changes
  ADD CONSTRAINT hosted_provider_resource_changes_resource_kind_check
  CHECK (resource_kind IN ('configuration', 'type', 'contract', 'schema', 'view'));

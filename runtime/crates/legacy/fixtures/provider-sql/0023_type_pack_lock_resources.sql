ALTER TABLE hosted_provider_resources
  DROP CONSTRAINT IF EXISTS hosted_provider_resources_kind_check;

ALTER TABLE hosted_provider_resources
  ADD CONSTRAINT hosted_provider_resources_kind_check
  CHECK (kind IN ('configuration', 'type', 'contract', 'schema', 'view', 'lock'));

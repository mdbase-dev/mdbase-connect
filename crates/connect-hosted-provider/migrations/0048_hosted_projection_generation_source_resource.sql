-- Terminal rebuild quarantine is scoped to the exact encrypted resource
-- revision that produced the semantic catalog. The compiled catalog revision
-- is a different digest namespace and cannot be compared to collection
-- resource_revision. Existing prototype generations remain nullable and are
-- never relabelled; every new generation records the source explicitly.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE hosted_provider_projection_generations
  ADD COLUMN source_resource_revision text;

ALTER TABLE hosted_provider_projection_generations
  ADD CONSTRAINT hosted_provider_projection_generation_source_resource_check
  CHECK (
    source_resource_revision IS NULL
    OR length(source_resource_revision) BETWEEN 1 AND 1024
  ) NOT VALID;

ALTER TABLE hosted_provider_projection_generations
  VALIDATE CONSTRAINT hosted_provider_projection_generation_source_resource_check;

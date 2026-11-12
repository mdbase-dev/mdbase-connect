-- A delivered notification event is never read again. Remove delivered rows,
-- with their record path and frontmatter payload, left by earlier builds.
DELETE FROM hosted_provider_runtime_outbox WHERE processed_at IS NOT NULL;

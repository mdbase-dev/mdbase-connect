-- SELECT-only role for the migration reader (mdbn-legacy hosted::source).
-- Run by an authorized operator with the provider's owner role, against a test database or a
-- restored copy. Never against production without explicit authorization.
--
--   psql "$PROVIDER_ADMIN_URL" -v reader_password="'…'" -f reader-role.sql
--
-- The reader also refuses superusers and any role with write privileges on
-- hosted_provider_* tables, so a misconfigured role fails closed.
--
-- That check covers the role's own privileges. The role is NOINHERIT and is granted
-- no memberships here: never GRANT another role to mdbn_migration_reader, because a
-- member of a writer role could `SET ROLE` to it and write.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdbn_migration_reader') THEN
    CREATE ROLE mdbn_migration_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION;
  END IF;
END $$;

ALTER ROLE mdbn_migration_reader PASSWORD :reader_password;
ALTER ROLE mdbn_migration_reader SET default_transaction_read_only = on;
GRANT USAGE ON SCHEMA public TO mdbn_migration_reader;
-- Only the tables the reader queries.
GRANT SELECT ON
  hosted_provider_collections,
  hosted_provider_resources,
  hosted_provider_records,
  hosted_provider_files,
  hosted_provider_replicas,
  hosted_provider_changes,
  hosted_provider_file_changes,
  hosted_provider_resource_changes
TO mdbn_migration_reader;

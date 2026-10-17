-- SELECT-only, least-privilege login role for the hosted Worker's legacy source
-- reader (src/legacy-source/source.ts and src/legacy-source/bindings.ts).
--
-- An operator recipe, not a schema migration: it changes no table and is safe to
-- re-run (it resets the role's grants to exactly this list). Run it with the
-- hosted provider's owner role against a test database or a LAB provider database.
-- Never against staging or production without explicit authorization.
--
--   psql "$PROVIDER_OWNER_URL" --set ON_ERROR_STOP=on \
--     --set reader_verifier='SCRAM-SHA-256$4096:…' -f legacy-reader-role.sql
--
-- Pass a SCRAM-SHA-256 verifier, never a plaintext password, so the password never
-- reaches the database host, its logs or a job record. Undo: legacy-reader-role-drop.sql.
--
-- The grants are column-level: exactly the columns the reader's queries name (and
-- `hosted_provider_backup_holds.expires_at` for the out-of-checkpoint hold check).
-- Nothing else is readable: no replica token hashes, no other provider tables, no
-- runtime or archive tables. The role is NOINHERIT and a member of no role (checked
-- below): never GRANT another role to it, because it could then SET ROLE and write.
-- PUBLIC loses TEMPORARY on this database so the role cannot create even temp
-- tables (the database owner keeps it implicitly).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdbn_hosted_legacy_reader') THEN
    CREATE ROLE mdbn_hosted_legacy_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

-- A non-superuser owner cannot name the SUPERUSER/REPLICATION/BYPASSRLS attributes in
-- ALTER ROLE, so an existing role's attributes are asserted instead (below).
ALTER ROLE mdbn_hosted_legacy_reader LOGIN CONNECTION LIMIT 10 PASSWORD :'reader_verifier';
ALTER ROLE mdbn_hosted_legacy_reader SET default_transaction_read_only = on;
ALTER ROLE mdbn_hosted_legacy_reader SET statement_timeout = '60s';
ALTER ROLE mdbn_hosted_legacy_reader SET idle_in_transaction_session_timeout = '15min';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdbn_hosted_legacy_reader'
                 AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
                 AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'mdbn_hosted_legacy_reader has unexpected role attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
             WHERE r.rolname = 'mdbn_hosted_legacy_reader') THEN
    RAISE EXCEPTION 'mdbn_hosted_legacy_reader must not be a member of any role';
  END IF;
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- Reset to exactly the list below (a table-level REVOKE also revokes column grants).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mdbn_hosted_legacy_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mdbn_hosted_legacy_reader;
GRANT USAGE ON SCHEMA public TO mdbn_hosted_legacy_reader;

GRANT SELECT (id, expires_at) ON hosted_provider_backup_holds TO mdbn_hosted_legacy_reader;
GRANT SELECT (id, state, head, wrapped_data_key, max_document_bytes)
  ON hosted_provider_collections TO mdbn_hosted_legacy_reader;
GRANT SELECT (collection_id, path, kind, revision, document_ciphertext)
  ON hosted_provider_resources TO mdbn_hosted_legacy_reader;
GRANT SELECT (collection_id, record_id, revision, sequence, content_bytes, payload_ciphertext)
  ON hosted_provider_records TO mdbn_hosted_legacy_reader;
GRANT SELECT (collection_id, file_id, sequence, size, object_key, payload_ciphertext)
  ON hosted_provider_files TO mdbn_hosted_legacy_reader;
GRANT SELECT (collection_id, sequence, record_id, revision, after_ciphertext)
  ON hosted_provider_changes TO mdbn_hosted_legacy_reader;
GRANT SELECT (collection_id, sequence, file_id, after_size, after_object_key, after_ciphertext)
  ON hosted_provider_file_changes TO mdbn_hosted_legacy_reader;
GRANT SELECT (collection_id, sequence, path, resource_kind)
  ON hosted_provider_resource_changes TO mdbn_hosted_legacy_reader;
GRANT SELECT (id, collection_id, purpose, revoked_at)
  ON hosted_provider_replicas TO mdbn_hosted_legacy_reader;
GRANT SELECT (replica_id, request_id, state, receipt_digest, completed_at, acknowledged_at)
  ON hosted_provider_mutation_journal TO mdbn_hosted_legacy_reader;
GRANT SELECT (replica_id, request_id, terminal_state, receipt_digest, completed_at)
  ON hosted_provider_mutation_tombstones TO mdbn_hosted_legacy_reader;

-- Self-check: no table-level privilege at all, no write privilege on any column, and
-- column SELECT only on the 11 allowlisted tables.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'mdbn_hosted_legacy_reader';
  IF n <> 0 THEN RAISE EXCEPTION 'reader has % table-level privileges', n; END IF;
  SELECT count(*) INTO n FROM information_schema.column_privileges
   WHERE grantee = 'mdbn_hosted_legacy_reader'
     AND (privilege_type <> 'SELECT' OR table_name NOT IN (
       'hosted_provider_backup_holds', 'hosted_provider_collections', 'hosted_provider_resources',
       'hosted_provider_records', 'hosted_provider_files', 'hosted_provider_changes',
       'hosted_provider_file_changes', 'hosted_provider_resource_changes', 'hosted_provider_replicas',
       'hosted_provider_mutation_journal', 'hosted_provider_mutation_tombstones'));
  IF n <> 0 THEN RAISE EXCEPTION 'reader has % privileges outside the allowlist', n; END IF;
  SELECT count(*) INTO n FROM information_schema.column_privileges
   WHERE grantee = 'mdbn_hosted_legacy_reader';
  IF n <> 54 THEN RAISE EXCEPTION 'reader has % column grants, expected 54', n; END IF;
END $$;

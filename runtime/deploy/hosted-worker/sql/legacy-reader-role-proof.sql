-- Refusal proof for legacy-reader-role.sql, run by the provider's owner role (no
-- reader password needed). The owner temporarily takes SET (not INHERIT) membership
-- in the reader, switches to it, tries each forbidden operation in a subtransaction
-- and prints `PROOF REFUSED <sqlstate> <label>` or `PROOF ALLOWED <label>` as a
-- NOTICE, then gives the membership back. Every attempt line must read REFUSED and
-- every POSITIVE line ok. Nothing is written: an attempt that succeeds is rolled
-- back. The attempts run in a read-write transaction, so each refusal comes from
-- the role's privileges, not from read-only mode.
--
--   psql "$PROVIDER_OWNER_URL" --set ON_ERROR_STOP=on -A -t -f legacy-reader-role-proof.sql

GRANT mdbn_hosted_legacy_reader TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
SET ROLE mdbn_hosted_legacy_reader;
SET default_transaction_read_only = off;

DO $$
DECLARE
  t text[];
  res text;
BEGIN
  RAISE NOTICE 'PROOF context current_user=% transaction_read_only=%',
    current_user, current_setting('transaction_read_only');
  FOREACH t SLICE 1 IN ARRAY ARRAY[
    ['insert allowlisted table', 'INSERT INTO hosted_provider_backup_holds (id, expires_at) VALUES (gen_random_uuid(), now())'],
    ['update allowlisted column', 'UPDATE hosted_provider_collections SET head = head WHERE false'],
    ['update granted-select column', 'UPDATE hosted_provider_collections SET state = state'],
    ['delete allowlisted table', 'DELETE FROM hosted_provider_records WHERE false'],
    ['truncate allowlisted table', 'TRUNCATE hosted_provider_changes'],
    ['insert outside allowlist', 'INSERT INTO _sqlx_migrations DEFAULT VALUES'],
    ['ddl create table', 'CREATE TABLE public.mdbn_reader_probe (x int)'],
    ['ddl create temp table', 'CREATE TEMP TABLE mdbn_reader_probe_tmp (x int)'],
    ['ddl create schema', 'CREATE SCHEMA mdbn_reader_probe'],
    ['ddl create function', 'CREATE FUNCTION public.mdbn_reader_probe() RETURNS int LANGUAGE sql AS ''SELECT 1'''],
    ['ddl alter table', 'ALTER TABLE hosted_provider_collections ADD COLUMN mdbn_reader_probe int'],
    ['ddl drop table', 'DROP TABLE hosted_provider_backup_holds'],
    ['ddl create index', 'CREATE INDEX mdbn_reader_probe ON hosted_provider_records (sequence)'],
    ['read column outside allowlist', 'SELECT token_hash FROM hosted_provider_replicas LIMIT 1'],
    ['read star with ungranted columns', 'SELECT * FROM hosted_provider_collections LIMIT 1'],
    ['read table outside allowlist (migrations)', 'SELECT 1 FROM _sqlx_migrations LIMIT 1'],
    ['read table outside allowlist (runtime timers)', 'SELECT 1 FROM mdbase_runtime_timers LIMIT 1'],
    ['read table outside allowlist (archived receipts)', 'SELECT 1 FROM archived_hosted_mutation_receipts LIMIT 1'],
    ['lock allowlisted table', 'LOCK TABLE hosted_provider_collections IN SHARE MODE'],
    ['copy to program', 'COPY (SELECT 1) TO PROGRAM ''true'''],
    ['read server file', 'SELECT pg_read_file(''postgresql.conf'')'],
    ['create role', 'CREATE ROLE mdbn_reader_probe'],
    ['grant to self', 'GRANT INSERT ON hosted_provider_backup_holds TO mdbn_hosted_legacy_reader']
  ] LOOP
    BEGIN
      EXECUTE t[2];
      RAISE EXCEPTION 'mdbn_rollback';
    EXCEPTION WHEN OTHERS THEN
      res := CASE WHEN SQLERRM = 'mdbn_rollback' THEN 'ALLOWED' ELSE 'REFUSED ' || SQLSTATE END;
    END;
    RAISE NOTICE 'PROOF % %', res, t[1];
  END LOOP;

  BEGIN
    PERFORM count(*) FROM hosted_provider_collections;
    PERFORM id, state, head, max_document_bytes, length(wrapped_data_key) FROM hosted_provider_collections LIMIT 1;
    PERFORM expires_at FROM hosted_provider_backup_holds LIMIT 1;
    PERFORM id, purpose FROM hosted_provider_replicas WHERE revoked_at IS NULL LIMIT 1;
    RAISE NOTICE 'PROOF POSITIVE ok allowlisted columns readable';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PROOF POSITIVE FAILED % allowlisted columns readable', SQLSTATE;
  END;
  BEGIN
    SELECT 'superuser=' || r.rolsuper || ' tables=' ||
      (SELECT count(*) FROM pg_tables p WHERE p.tablename LIKE 'hosted\_provider\_%'
         AND p.schemaname = ANY (current_schemas(false))) || ' writable=' ||
      (SELECT count(*) FROM pg_tables p WHERE p.tablename LIKE 'hosted\_provider\_%'
         AND p.schemaname = ANY (current_schemas(false))
         AND has_table_privilege(current_user, quote_ident(p.schemaname) || '.' || quote_ident(p.tablename),
               'INSERT,UPDATE,DELETE,TRUNCATE'))
      INTO res FROM pg_roles r WHERE r.rolname = current_user;
    RAISE NOTICE 'PROOF POSITIVE ok verify_select_only %', res;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PROOF POSITIVE FAILED % verify_select_only', SQLSTATE;
  END;
END $$;

RESET ROLE;
DO $$
BEGIN
  EXECUTE format('REVOKE mdbn_hosted_legacy_reader FROM %I GRANTED BY %I', current_user, current_user);
  RAISE NOTICE 'PROOF cleanup memberships_of_reader=%  owner_set_membership=%',
    (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname = 'mdbn_hosted_legacy_reader'),
    (SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
      WHERE g.rolname = 'mdbn_hosted_legacy_reader' AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        AND m.set_option);
END $$;

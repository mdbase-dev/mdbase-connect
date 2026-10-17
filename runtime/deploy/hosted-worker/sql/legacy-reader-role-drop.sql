-- Undo legacy-reader-role.sql: drop the reader role and give PUBLIC back TEMPORARY on
-- this database (PostgreSQL's default). Run with the provider's owner role. Open
-- sessions of the role are terminated first; Hyperdrive reconnects then fail auth.

SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'mdbn_hosted_legacy_reader';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mdbn_hosted_legacy_reader') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mdbn_hosted_legacy_reader;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM mdbn_hosted_legacy_reader;
    REVOKE USAGE ON SCHEMA public FROM mdbn_hosted_legacy_reader;
    DROP ROLE mdbn_hosted_legacy_reader;
  END IF;
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END $$;

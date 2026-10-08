-- H0: one immutable verified legacy archive acceptance per permanent batch/revision.
-- The control plane trusts the existing dedicated ONE-verifier admin boundary;
-- a database row or checksum alone is not signature/provider qualification.
ALTER TABLE next_migration_cohorts
  ADD COLUMN membership_revision bigint NOT NULL DEFAULT 1 CHECK (membership_revision > 0),
  ADD COLUMN membership_changed_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp());

CREATE TABLE next_migration_archive_acceptances (
  cohort text NOT NULL REFERENCES next_migration_cohorts(name),
  membership_revision bigint NOT NULL CHECK (membership_revision > 0),
  verified_result jsonb NOT NULL CHECK (verified_result->>'schema' = 'mdbase-recovery-set/v4'),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (cohort, membership_revision)
);

-- mdbase:next-migration-archive-triggers:v1
-- Schema-only pg-mem compatibility stops here. Real PostgreSQL qualifies all
-- mutation paths, cascading deletes, bulk SQL and lock/currentness semantics.
CREATE FUNCTION next_migration_membership_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE names text[]; batch text;
BEGIN
  IF TG_OP = 'INSERT' THEN names := ARRAY[NEW.cohort];
  ELSIF TG_OP = 'DELETE' THEN names := ARRAY[OLD.cohort];
  ELSE
    IF OLD.account_id IS NOT DISTINCT FROM NEW.account_id AND OLD.cohort IS NOT DISTINCT FROM NEW.cohort THEN
      RETURN NEW;
    END IF;
    names := ARRAY[OLD.cohort, NEW.cohort];
  END IF;
  FOR batch IN SELECT DISTINCT value FROM unnest(names) AS value ORDER BY value LOOP
    UPDATE next_migration_cohorts
      SET membership_revision = membership_revision + 1,
          membership_changed_at = date_trunc('milliseconds', clock_timestamp())
      WHERE name = batch;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER next_migration_member_coverage_changed
  AFTER INSERT OR DELETE OR UPDATE ON next_migration_cohort_members
  FOR EACH ROW EXECUTE FUNCTION next_migration_membership_changed();

CREATE FUNCTION next_migration_hosted_coverage_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owners uuid[]; batch text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.authority_state = 'transferred' THEN RETURN NEW; END IF;
    owners := ARRAY[NEW.user_id];
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.authority_state = 'transferred' THEN RETURN OLD; END IF;
    owners := ARRAY[OLD.user_id];
  ELSE
    IF OLD.user_id IS NOT DISTINCT FROM NEW.user_id
       AND (OLD.authority_state <> 'transferred') = (NEW.authority_state <> 'transferred') THEN RETURN NEW; END IF;
    owners := ARRAY[
      CASE WHEN OLD.authority_state <> 'transferred' THEN OLD.user_id END,
      CASE WHEN NEW.authority_state <> 'transferred' THEN NEW.user_id END
    ];
  END IF;
  FOR batch IN SELECT DISTINCT cohort FROM next_migration_cohort_members
      WHERE account_id = ANY(owners) ORDER BY cohort LOOP
    UPDATE next_migration_cohorts
      SET membership_revision = membership_revision + 1,
          membership_changed_at = date_trunc('milliseconds', clock_timestamp())
      WHERE name = batch;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER next_migration_hosted_coverage_changed
  AFTER INSERT OR DELETE OR UPDATE OF user_id, authority_state ON hosted_collections
  FOR EACH ROW EXECUTE FUNCTION next_migration_hosted_coverage_changed();

CREATE FUNCTION next_migration_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'migration archive acceptance and permanent batch identity are immutable';
END $$;
CREATE TRIGGER next_migration_archive_immutable
  BEFORE UPDATE OR DELETE ON next_migration_archive_acceptances
  FOR EACH ROW EXECUTE FUNCTION next_migration_archive_immutable();
CREATE TRIGGER next_migration_cohort_permanent
  BEFORE DELETE ON next_migration_cohorts
  FOR EACH ROW EXECUTE FUNCTION next_migration_archive_immutable();
CREATE TRIGGER next_migration_cohort_name_permanent
  BEFORE UPDATE OF name ON next_migration_cohorts
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION next_migration_archive_immutable();

-- An operator re-arm detaches a started account whose managed attempt was
-- verifiably routed back from its old cohort, so it can migrate again through
-- a new cohort, archive, acceptance and start. The old cohort keeps counting
-- the account as recorded here: its revision, membership digest and accepted
-- archive stay current for every other member (migration-rollout.ts).
-- `retired_events` are the attempt's ledger audit events (start, run binding,
-- dispatch intents, phase latch); later attempts never read them
-- (migration-managed-ledger.ts). No FK to users: account erasure must not
-- rewrite the old cohort's history.
CREATE TABLE next_migration_rearms (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  cohort text NOT NULL REFERENCES next_migration_cohorts(name),
  started_at timestamptz NOT NULL,
  collections uuid[] NOT NULL,
  retired_events uuid[] NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, cohort)
);
CREATE INDEX next_migration_rearms_cohort ON next_migration_rearms(cohort, account_id);

-- mdbase:next-migration-archive-triggers:v1
-- 0062's membership trigger, except that the re-arm's own member deletion
-- (its history row already inserted in the same transaction) is not a
-- membership change of the old cohort.
CREATE OR REPLACE FUNCTION next_migration_membership_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE names text[]; batch text;
BEGIN
  IF TG_OP = 'INSERT' THEN names := ARRAY[NEW.cohort];
  ELSIF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM next_migration_rearms r WHERE r.account_id = OLD.account_id AND r.cohort = OLD.cohort) THEN
      RETURN OLD;
    END IF;
    names := ARRAY[OLD.cohort];
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

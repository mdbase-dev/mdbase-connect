-- Staged hosted-collection migration to mdbase-next (decision 3, 2026-10-08):
-- cohorts the operators release, no user opt-in, one global pause, and the
-- guarded account backend flip. It starts paused with no cohorts: nothing moves
-- until an operator creates and releases a cohort and resumes.
CREATE TABLE next_migration_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  paused boolean NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO next_migration_rollout (singleton, paused, reason) VALUES (true, true, 'initial');

CREATE TABLE next_migration_cohorts (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An account is in at most one cohort.
CREATE TABLE next_migration_cohort_members (
  account_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cohort text NOT NULL REFERENCES next_migration_cohorts(name),
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX next_migration_cohort_members_cohort_idx
  ON next_migration_cohort_members (cohort, added_at);

-- Evidence of each flip: the exact hosted collections migrated and a digest of
-- the migration's per-collection evidence (driver checkpoints, barrier F).
CREATE TABLE next_migration_account_flips (
  account_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  collections uuid[] NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  flipped_at timestamptz NOT NULL DEFAULT now()
);

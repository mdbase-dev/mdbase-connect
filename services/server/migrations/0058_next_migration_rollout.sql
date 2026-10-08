-- Staged hosted-collection migration to mdbase-next (decision 3, 2026-10-08):
-- cohorts the operators release, no user opt-in, one global pause, an atomic
-- per-account start claim, per-collection cutover records and the guarded
-- account backend flip. It starts paused with no cohorts: nothing moves until an
-- operator creates and releases a cohort and resumes. Every change is also an
-- audit_events row. (Lengths are checked in code: the unit-test database has no
-- length().)
CREATE TABLE next_migration_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  paused boolean NOT NULL,
  reason text NOT NULL CHECK (reason <> ''),
  changed_by text NOT NULL CHECK (changed_by <> ''),
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO next_migration_rollout (singleton, paused, reason, changed_by)
VALUES (true, true, 'initial', 'migration');

CREATE TABLE next_migration_cohorts (
  name text PRIMARY KEY,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An account is in at most one cohort. started_at is the atomic start claim:
-- set only while released and not paused; an account with it set always runs to
-- its flip, whatever the pause.
CREATE TABLE next_migration_cohort_members (
  account_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cohort text NOT NULL REFERENCES next_migration_cohorts(name),
  added_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz
);
CREATE INDEX next_migration_members_by_cohort
  ON next_migration_cohort_members (cohort, added_at);

-- One row per hosted collection whose cutover completed (H10 routed at barrier F
-- with the final live digest). The flip requires one for every hosted collection
-- of the account and recomputes its evidence digest from these rows.
CREATE TABLE next_migration_collections (
  collection_id uuid PRIMARY KEY REFERENCES hosted_collections(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The drained legacy head the import reflects, the new log's
  -- migration-cutover item (old mirrors' join sync point C) and barrier F.
  s_final bigint NOT NULL CHECK (s_final >= 0),
  cutover_seq bigint NOT NULL CHECK (cutover_seq > 0),
  barrier_f bigint NOT NULL CHECK (barrier_f >= cutover_seq),
  final_digest text NOT NULL,
  cutover_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE next_migration_account_flips (
  account_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  collections uuid[] NOT NULL,
  evidence_digest text NOT NULL,
  flipped_at timestamptz NOT NULL DEFAULT now()
);

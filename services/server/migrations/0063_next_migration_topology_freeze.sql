-- Coordinator-reserved 0063. Topology freeze is distinct from release/pause/backend.
ALTER TABLE next_migration_cohorts ADD COLUMN frozen_at timestamptz;

-- A deletion request is accepted and credentials revoked while its immutable
-- batch topology is retained. The existing account-erasure pipeline consumes
-- this durable queue only after the whole batch's verified flips or unfreeze.
CREATE TABLE next_migration_deferred_account_deletions (
  account_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cohort text NOT NULL REFERENCES next_migration_cohorts(name),
  membership_revision bigint NOT NULL CHECK (membership_revision > 0),
  frozen_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  queue_provider_cleanup boolean NOT NULL,
  -- Eligibility is handed off durably under the cohort lock, BEFORE erasure
  -- cascades change the revision. Restart never has to infer a past unfreeze.
  ready_at timestamptz,
  ready_revision bigint,
  CHECK ((ready_at IS NULL AND ready_revision IS NULL) OR
         (ready_at IS NOT NULL AND ready_revision IS NOT NULL AND ready_revision > 0))
);
CREATE INDEX next_migration_deferred_account_deletions_cohort
  ON next_migration_deferred_account_deletions(cohort, account_id);

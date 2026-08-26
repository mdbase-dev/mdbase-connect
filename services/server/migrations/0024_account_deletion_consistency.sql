ALTER TABLE hosted_collections
  ADD COLUMN quarantined_at timestamptz;

ALTER TABLE hosted_collections
  ADD COLUMN quarantine_reason text;

ALTER TABLE hosted_collections
  ADD CONSTRAINT hosted_collections_quarantine_check
  CHECK (
    (quarantined_at IS NULL AND quarantine_reason IS NULL)
    OR (
      quarantined_at IS NOT NULL
      AND quarantine_reason = 'provider_collection_missing'
    )
  );

CREATE TABLE provider_collection_deletion_jobs (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('account_deletion')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'completed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX provider_collection_deletion_jobs_active_collection_idx
  ON provider_collection_deletion_jobs(collection_id)
  WHERE completed_at IS NULL;

CREATE INDEX provider_collection_deletion_jobs_ready_idx
  ON provider_collection_deletion_jobs(state, available_at)
  WHERE completed_at IS NULL;

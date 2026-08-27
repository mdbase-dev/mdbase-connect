-- mdbase:skip-if-missing-table applications
CREATE TABLE application_reconciliation_jobs (
  application_id uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'completed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  cursor_grant_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  last_error_class text,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_completed_at timestamptz,
  next_scan_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX application_reconciliation_jobs_ready_idx
  ON application_reconciliation_jobs(available_at)
  WHERE state <> 'completed';

CREATE INDEX application_reconciliation_jobs_sweep_idx
  ON application_reconciliation_jobs(next_scan_at)
  WHERE state = 'completed';

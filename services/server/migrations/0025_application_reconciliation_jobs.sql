-- mdbase:skip-if-missing-table applications
CREATE TABLE application_reconciliation_jobs (
  application_id uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'completed')),
  phase text NOT NULL DEFAULT 'scan' CHECK (phase IN ('scan', 'retry')),
  lease_token uuid,
  lease_expires_at timestamptz,
  cursor_grant_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error_class text CHECK (last_error_class IS NULL OR last_error_class IN
    ('timeout', 'provider', 'relay', 'malformed_proof', 'ownership', 'internal')),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_completed_at timestamptz,
  next_scan_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (phase <> 'retry' OR cursor_grant_id IS NULL),
  CHECK (state <> 'completed' OR (phase = 'scan' AND cursor_grant_id IS NULL
    AND next_scan_at IS NOT NULL))
);

-- Bind result ownership to the same exact application as the referenced grant.
ALTER TABLE grants ADD CONSTRAINT grants_application_id_id_unique
  UNIQUE (application_id, id);

-- A result is durable reconciliation state, never independently claimable work.
CREATE TABLE application_reconciliation_results (
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('retryable', 'quarantined')),
  error_class text NOT NULL CHECK (error_class IN
    ('timeout', 'provider', 'relay', 'malformed_proof', 'ownership', 'internal')),
  consecutive_attempts integer NOT NULL CHECK (consecutive_attempts > 0),
  next_retry_at timestamptz,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, grant_id),
  FOREIGN KEY (application_id, grant_id)
    REFERENCES grants(application_id, id) ON DELETE CASCADE,
  -- Quarantined rows retain a distant probe time for quiet self-recovery.
  CHECK (next_retry_at IS NOT NULL)
);

CREATE INDEX application_reconciliation_jobs_ready_idx
  ON application_reconciliation_jobs(available_at, application_id)
  WHERE state IN ('pending', 'leased', 'completed');
CREATE INDEX application_reconciliation_jobs_sweep_idx
  ON application_reconciliation_jobs(next_scan_at)
  WHERE state = 'completed';
CREATE INDEX application_reconciliation_results_retry_idx
  ON application_reconciliation_results(application_id, next_retry_at, grant_id)
  WHERE status = 'retryable';
CREATE INDEX application_reconciliation_results_quarantine_idx
  ON application_reconciliation_results(application_id, next_retry_at, grant_id)
  WHERE status = 'quarantined';
CREATE INDEX grants_active_application_id_idx
  ON grants(application_id, id)
  WHERE revoked_at IS NULL AND activated_at IS NOT NULL;

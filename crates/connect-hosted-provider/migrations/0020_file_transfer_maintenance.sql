ALTER TABLE hosted_provider_file_transfers
  ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS hosted_provider_file_transfers_cleanup_idx
  ON hosted_provider_file_transfers (updated_at, id)
  WHERE direction = 'upload'
    AND state IN ('aborted', 'expired')
    AND cleanup_completed_at IS NULL;

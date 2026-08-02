CREATE TABLE IF NOT EXISTS hosted_provider_backup_holds (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT hosted_provider_backup_holds_expiry_check CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '6 hours'
  )
);

CREATE INDEX IF NOT EXISTS hosted_provider_backup_holds_expiry_idx
  ON hosted_provider_backup_holds (expires_at);

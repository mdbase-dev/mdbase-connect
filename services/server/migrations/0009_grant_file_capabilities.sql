ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS file_capability jsonb;

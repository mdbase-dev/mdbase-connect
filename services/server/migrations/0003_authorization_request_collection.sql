-- Restore the optional collection selector used by both browser and device
-- authorization. Some pre-ledger databases were baselined without receiving
-- this column, so this migration must remain additive and idempotent.
ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS collection_id uuid;

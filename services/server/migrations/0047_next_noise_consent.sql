-- Explicit local grant mode and approval-time device/Noise tuple. No backfill,
-- FK/cascade or reconstruction from a replacement device registration: deleting
-- registration never converts a retained Noise grant into legacy authorization.
ALTER TABLE grants ADD COLUMN next_noise jsonb;
ALTER TABLE grants ADD CONSTRAINT grants_next_noise_local_only CHECK (
  next_noise IS NULL OR
  (jsonb_typeof(next_noise) = 'object' AND encryption IS NULL AND
   collection_id IS NOT NULL AND hosted_collection_id IS NULL)
);

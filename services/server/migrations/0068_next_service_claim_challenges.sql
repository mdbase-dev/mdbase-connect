-- Authentication housekeeping only: extend the existing one-use challenge
-- store with a real service subject. No connector is fabricated for a service.
-- Historical connector rows retain their existing expiry/consumption behavior.
ALTER TABLE next_device_challenges ALTER COLUMN connector_id DROP NOT NULL;
ALTER TABLE next_device_challenges
  ADD COLUMN service_collection_id uuid REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  ADD COLUMN service_device_id uuid REFERENCES next_service_devices(device_id) ON DELETE CASCADE,
  ADD COLUMN service_purpose text,
  ADD COLUMN service_audience text,
  ADD COLUMN service_subject_hash bytea;

ALTER TABLE next_device_challenges ADD CONSTRAINT next_device_challenges_subject_check CHECK (
  (connector_id IS NOT NULL AND service_collection_id IS NULL AND service_device_id IS NULL
    AND service_purpose IS NULL AND service_audience IS NULL AND service_subject_hash IS NULL)
  OR
  (connector_id IS NULL AND service_collection_id IS NOT NULL AND service_device_id IS NOT NULL
    AND service_purpose IS NOT NULL AND service_purpose = 'migration-claim-read/v1'
    AND service_audience IS NOT NULL AND service_audience <> '' AND service_subject_hash IS NOT NULL)
);

-- Expired unused rows are removed only by bounded authentication cleanup before
-- issuance. An unexpired unused row must never be overwritten or renewed.
CREATE UNIQUE INDEX next_service_claim_challenge_outstanding_idx
  ON next_device_challenges(service_device_id, service_purpose, service_audience)
  WHERE connector_id IS NULL AND used_at IS NULL;

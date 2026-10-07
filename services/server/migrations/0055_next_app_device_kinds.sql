-- First-party per-installation device registration uses the EXISTING policy
-- tags mobile=1 / app-runtime=2, not a daemon disguise. Keep all proofs, immutable
-- keys, one-device-per-connector uniqueness and authorization unchanged.
ALTER TABLE next_devices DROP CONSTRAINT next_devices_kind_check;
ALTER TABLE next_devices ADD CONSTRAINT next_devices_kind_check
  CHECK (kind IN ('desktop', 'mobile', 'app-runtime', 'cli'));

-- Existing and newly committed cloud-copy service records require a durable wake.
ALTER TABLE next_service_devices
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activation_next_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN activation_attempts integer NOT NULL DEFAULT 0 CHECK (activation_attempts BETWEEN 0 AND 9);
CREATE INDEX next_service_activation_pending ON next_service_devices(activation_next_at)
  WHERE activated_at IS NULL;

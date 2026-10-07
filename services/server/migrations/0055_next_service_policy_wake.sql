-- Replace one-time genesis activation with generation-scoped policy wakes.
-- Batch IDs remain monotonic even when a lost log position is reused.
ALTER TABLE next_service_devices
  ADD COLUMN activation_batch_id bigint NOT NULL DEFAULT 0 CHECK (activation_batch_id >= 0),
  ADD COLUMN activation_attempt_batch_id bigint NOT NULL DEFAULT 0 CHECK (activation_attempt_batch_id >= 0);
-- Legacy one-time ACKs cover no captured batch: each current service gets one
-- bounded catch-up wake after upgrade, through the ordinary idempotent endpoint.
DROP INDEX next_service_activation_pending;
CREATE INDEX next_service_activation_due ON next_service_devices(activation_next_at, collection_id, kind);

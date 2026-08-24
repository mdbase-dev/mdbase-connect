-- Sanitize collaboration awareness names to the generic non-PII identity.
--
-- Migration 0044 is already part of the immutable migration ledger and allowed
-- bounded server-authoritative profile names. The private experiment now uses
-- only `Participant`; process-local room ordinals distinguish visible sessions.
-- This follow-up removes any previously stored profile name before tightening
-- the database invariant.
--
-- Rollout note: apply only with collaboration admission fenced and after the
-- control plane emits generic identities. Binaries that predate awareness still
-- remain insert-compatible through the defaults introduced by migration 0044.
UPDATE hosted_provider_replicas
SET awareness_name = 'Participant'
WHERE awareness_name IS DISTINCT FROM 'Participant';

ALTER TABLE hosted_provider_replicas
  DROP CONSTRAINT hosted_provider_replicas_awareness_name_check,
  ADD CONSTRAINT hosted_provider_replicas_awareness_name_check
  CHECK (awareness_name IS NULL OR awareness_name = 'Participant');

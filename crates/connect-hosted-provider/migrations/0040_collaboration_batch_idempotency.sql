-- Phase 3C: collaboration mutation ids are scoped to the contributing replica.
-- Digest uniqueness is intentionally not enforced: CRDT duplicate updates under
-- distinct client ids are valid and converge at the document layer.
ALTER TABLE hosted_provider_collaboration_updates
  DROP CONSTRAINT IF EXISTS hosted_provider_collaboration_updates_collection_id_record_id_collaboration_epoch_profile_client_mutation_id_key,
  DROP CONSTRAINT IF EXISTS hosted_provider_collaboration_updates_collection_id_record_id_collaboration_epoch_profile_update_digest_key;
ALTER TABLE hosted_provider_collaboration_updates
  ADD CONSTRAINT hosted_provider_collaboration_updates_replica_mutation_key
  UNIQUE (collection_id, record_id, collaboration_epoch, profile, replica_id, client_mutation_id);

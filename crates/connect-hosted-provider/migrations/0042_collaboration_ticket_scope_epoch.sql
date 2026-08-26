-- Ticket scope epochs are copied from active replicas, whose epochs are
-- strictly positive. Tighten the storage invariant before transport exists.
ALTER TABLE hosted_provider_collaboration_tickets
  DROP CONSTRAINT hosted_provider_collaboration_tickets_scope_epoch_check;
ALTER TABLE hosted_provider_collaboration_tickets
  ADD CONSTRAINT hosted_provider_collaboration_tickets_scope_epoch_positive
  CHECK (scope_epoch > 0);

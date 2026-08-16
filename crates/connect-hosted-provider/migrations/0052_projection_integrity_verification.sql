-- A complete generation and every ordinary Candidate B write prove projection
-- completeness transactionally. Persist the epoch carrying that proof so a
-- page request does not repeat a collection-wide stale/absent scan. Direct SQL
-- tampering still advances integrity_epoch through the 0045 triggers without
-- advancing this value, forcing the next query to scan and fail closed.
ALTER TABLE hosted_provider_projection_generations
  ADD COLUMN integrity_verified_epoch bigint NOT NULL DEFAULT 0
    CHECK (integrity_verified_epoch >= 0)
    CHECK (integrity_verified_epoch <= integrity_epoch);


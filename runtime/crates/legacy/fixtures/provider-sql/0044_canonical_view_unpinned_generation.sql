-- Canonical views compile to the same closed query plan as direct queries and,
-- like them, run without a pinned semantic generation while the projection is
-- being rebuilt (see validate_generation_binding). Every request kind now
-- permits an unpinned generation, so the constraint no longer restricts
-- anything.
ALTER TABLE hosted_provider_query_cursors
  DROP CONSTRAINT hosted_provider_query_cursors_check3;

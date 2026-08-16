-- Background maintenance sweeps receipts by expiry across every collection.
-- Keep the collection-local index from 0042 for scoped diagnostics and add the
-- global ordering used by the bounded maintenance worker.
-- This release applies 0042 and 0043 in the same quiescent migration job before
-- the provider can write receipts. Bound lock and build time so an unexpected
-- pre-populated table fails the rollout instead of blocking live traffic.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX hosted_provider_query_page_receipts_global_expiry_idx
  ON hosted_provider_query_page_receipts (
    expires_at,
    collection_id,
    replica_id,
    request_id
  );

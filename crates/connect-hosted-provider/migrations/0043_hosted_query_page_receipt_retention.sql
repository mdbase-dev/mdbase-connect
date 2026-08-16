-- Background maintenance sweeps receipts by expiry across every collection.
-- Keep the collection-local index from 0042 for scoped diagnostics and add the
-- global ordering used by the bounded maintenance worker.
CREATE INDEX hosted_provider_query_page_receipts_global_expiry_idx
  ON hosted_provider_query_page_receipts (
    expires_at,
    collection_id,
    replica_id,
    request_id
  );

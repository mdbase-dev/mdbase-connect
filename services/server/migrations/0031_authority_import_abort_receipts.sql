-- mdbase:skip-if-missing-table authority_transfers
-- Cancelling a first-time import deletes its unused hosted collection, which
-- cascades to authority_transfers. Retain the exact connector-scoped proof that
-- the provider cannot activate it, so a lost response cannot strand a local fence.
-- These receipts deliberately do not reference the disposable transfer/collection.
CREATE TABLE authority_import_abort_receipts (
  transfer_id uuid PRIMARY KEY,
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authority_import_abort_receipts_connector_idx
  ON authority_import_abort_receipts(connector_id);

-- Existing cancelled imports were already remotely confirmed. Do not infer
-- confirmation from missing records or historical expiry alone.
INSERT INTO authority_import_abort_receipts (transfer_id, connector_id)
SELECT transfer.id, source.connector_id
FROM authority_transfers transfer
JOIN collections source ON source.id = transfer.local_collection_id
WHERE transfer.direction = 'to_hosted' AND transfer.state = 'cancelled';

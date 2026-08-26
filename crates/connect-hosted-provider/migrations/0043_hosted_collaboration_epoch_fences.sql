-- Phase 5: conventional writers reconcile collaboration epochs through a
-- durable per-record fence. Epochs are deliberately shared by every future
-- profile for the stable record so one conventional write fences them all.
-- The fence survives record deletion because it references only the
-- collection, so delete-and-recreate of a record id can never resurrect a
-- retired room epoch, and the database itself rejects
-- stale-epoch documents.
CREATE TABLE hosted_provider_collaboration_epoch_fences (
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  current_epoch bigint NOT NULL CHECK (current_epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, record_id),
  UNIQUE (collection_id, record_id, current_epoch)
);

-- Backfill one fence per record that already owns a room, at that record's
-- maximum existing epoch.
INSERT INTO hosted_provider_collaboration_epoch_fences
  (collection_id, record_id, current_epoch)
SELECT d.collection_id, d.record_id, max(d.collaboration_epoch)
FROM hosted_provider_collaboration_documents d
GROUP BY d.collection_id, d.record_id;

-- Rooms below their record's fence epoch can no longer satisfy the composite
-- foreign key below; retire superseded documents now. Their updates, receipts,
-- and tickets cascade with them.
DELETE FROM hosted_provider_collaboration_documents d
USING hosted_provider_collaboration_epoch_fences f
WHERE d.collection_id = f.collection_id
  AND d.record_id = f.record_id
  AND d.collaboration_epoch <> f.current_epoch;

-- Collaboration documents may exist only at the fence's current epoch. The
-- constraint is intentionally NOT DEFERRABLE so a stale-epoch document insert
-- is rejected immediately instead of at commit time.
ALTER TABLE hosted_provider_collaboration_documents
  ADD CONSTRAINT hosted_provider_collaboration_documents_current_epoch_fkey
  FOREIGN KEY (collection_id, record_id, collaboration_epoch)
    REFERENCES hosted_provider_collaboration_epoch_fences
      (collection_id, record_id, current_epoch)
    ON DELETE CASCADE
    NOT DEFERRABLE;

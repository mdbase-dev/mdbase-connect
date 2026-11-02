-- A grant on a native collection (grants.next_collection_id) records the sync mode
-- the user consented to. A Private grant is an offer served by the account's
-- devices after a device-signed approval; a cloud-copy grant is served by the
-- collection's hosted replica. A grant is only usable while the collection is
-- still in the mode it was approved for: a mode change never turns one kind of
-- consent into the other.
ALTER TABLE grants ADD COLUMN next_collection_sync text;

-- Every native grant before this migration was approved (or carried over) for a
-- Private collection: each path that wrote next_collection_id required it.
UPDATE grants SET next_collection_sync = 'private' WHERE next_collection_id IS NOT NULL;

ALTER TABLE grants ADD CONSTRAINT grants_next_collection_sync_target CHECK (
  (next_collection_id IS NULL AND next_collection_sync IS NULL)
  OR (next_collection_id IS NOT NULL AND next_collection_sync IS NOT NULL
      AND next_collection_sync IN ('private', 'cloud_copy'))
);

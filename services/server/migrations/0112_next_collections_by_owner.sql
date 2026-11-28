-- Account quota reads select one owner's native collections. Keep collections
-- that left sync in this index: their logs still count towards file storage.
CREATE INDEX next_collections_owner_collection_idx
  ON next_collections (owner_user_id, collection_id) WHERE runtime = 'next';

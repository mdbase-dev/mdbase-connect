-- mdbase:next-collection-id-owner-trigger:v1
-- A collection ID belongs to one account across every collection table. A native
-- collection may take an ID already in use only when the same account holds it:
-- its own hosted or local collection moving to the native runtime. Creation
-- paths refuse first with the same predicate (refuseCollectionIdOfOther in
-- features/next/bootstrap-common.ts); this trigger holds it for any other insert.
CREATE FUNCTION guard_next_collection_id_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hosted_collections WHERE id = NEW.collection_id AND user_id <> NEW.owner_user_id)
     OR EXISTS (SELECT 1 FROM collection_identities WHERE id = NEW.collection_id AND owner_user_id <> NEW.owner_user_id)
     OR EXISTS (SELECT 1 FROM collections WHERE local_id = NEW.collection_id AND user_id <> NEW.owner_user_id AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'Collection ID belongs to another account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER next_collection_id_owner BEFORE INSERT ON next_collections
FOR EACH ROW EXECUTE FUNCTION guard_next_collection_id_owner();

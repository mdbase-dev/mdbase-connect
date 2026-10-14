-- One UI attempt, two distinct existing authorization mechanisms. No keys/tokens.
CREATE TABLE installation_native_authorizations (
  pairing_id uuid PRIMARY KEY REFERENCES installation_device_pairings(pairing_id) ON DELETE CASCADE,
  authorization_request_id uuid NOT NULL UNIQUE REFERENCES authorization_requests(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES users(id),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  selected_collection_id uuid REFERENCES next_collections(collection_id),
  grant_id uuid UNIQUE REFERENCES grants(id),
  approved_at timestamptz,
  CHECK ((selected_collection_id IS NULL AND grant_id IS NULL AND approved_at IS NULL)
      OR (selected_collection_id IS NOT NULL AND grant_id IS NOT NULL AND approved_at IS NOT NULL))
);
-- mdbase:installation-native-constraints:v1
CREATE FUNCTION preserve_installation_native_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pairing_id,NEW.authorization_request_id,NEW.account_id,NEW.manifest_digest)
     IS DISTINCT FROM (OLD.pairing_id,OLD.authorization_request_id,OLD.account_id,OLD.manifest_digest)
     OR (OLD.approved_at IS NOT NULL AND
       (NEW.selected_collection_id,NEW.grant_id,NEW.approved_at)
       IS DISTINCT FROM (OLD.selected_collection_id,OLD.grant_id,OLD.approved_at))
  THEN RAISE EXCEPTION 'original installation/native association is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_installation_native_authorization
  BEFORE UPDATE ON installation_native_authorizations FOR EACH ROW
  EXECUTE FUNCTION preserve_installation_native_authorization();

-- Keep applied0077 intact. Its Hosted singleton remains exact; the additional
-- zero-content variant is valid ONLY with the committed matching Native grant.
ALTER TABLE installation_device_pairings DROP CONSTRAINT installation_recovery_scope;
ALTER TABLE installation_device_pairings ADD CONSTRAINT installation_recovery_scope CHECK (
  recovery_collection_id IS NULL OR (
    NOT requested_create_collections AND NOT approved_create_collections
    AND file_access_collection_id IS NULL AND created_collection_ids='{}'::uuid[]
    AND (
      (approved_session_epoch IS NULL AND approved_collection_ids='{}'::uuid[] AND selected_collection_id IS NULL)
      OR (approved_session_epoch IS NOT NULL AND approved_collection_ids=ARRAY[recovery_collection_id]
          AND selected_collection_id IS NOT DISTINCT FROM recovery_collection_id)
      OR (approved_session_epoch IS NOT NULL AND approved_collection_ids='{}'::uuid[] AND selected_collection_id IS NULL)
    )
  )
);
CREATE FUNCTION installation_native_recovery_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original_request uuid;
  child installation_device_pairings%ROWTYPE;
  parent pairing_requests%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='pairing_requests' THEN original_request:=NEW.id;
  ELSE original_request:=NEW.pairing_id; END IF;
  -- Same parent->child lock order as applied0077; validate FINAL tx state.
  SELECT * INTO parent FROM pairing_requests WHERE id=original_request FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO child FROM installation_device_pairings WHERE pairing_id=original_request FOR UPDATE;
  IF NOT FOUND OR child.recovery_collection_id IS NULL OR child.approved_session_epoch IS NULL
    OR child.approved_collection_ids<>'{}'::uuid[] THEN RETURN NULL; END IF;
  IF child.selected_collection_id IS NOT NULL OR parent.approved_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM installation_native_authorizations n
      JOIN authorization_requests ar ON ar.id=n.authorization_request_id AND ar.grant_id=n.grant_id
      JOIN grants g ON g.id=n.grant_id
    WHERE n.pairing_id=original_request AND n.approved_at IS NOT NULL
      AND n.selected_collection_id=child.recovery_collection_id
      AND n.account_id=parent.user_id AND ar.user_id=parent.user_id AND g.user_id=parent.user_id
      AND ar.application_id::text=child.app_id AND g.application_id::text=child.app_id
      AND g.next_collection_id=child.recovery_collection_id
  ) THEN RAISE EXCEPTION 'Recovery requires exact Hosted scope or its original committed Native choice'
    USING ERRCODE='23514', CONSTRAINT='installation_recovery_scope'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER installation_native_recovery_child
  AFTER INSERT OR UPDATE ON installation_device_pairings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installation_native_recovery_complete();
CREATE CONSTRAINT TRIGGER installation_native_recovery_parent
  AFTER UPDATE ON pairing_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installation_native_recovery_complete();
CREATE CONSTRAINT TRIGGER installation_native_recovery_choice
  AFTER INSERT OR UPDATE ON installation_native_authorizations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION installation_native_recovery_complete();

-- mdbase:installation-private-device-recovery:v1
-- A recovery sign-in may ask for Private device access again
-- (docs/installation-private-device.md, "Request access again"). Its one
-- approved collection is then the recovered collection as a device scope, with
-- no cloud copy, selection or Native choice. Every other recovery shape is
-- unchanged. Applied migrations 0077, 0080 and 0101 are kept as they are.

-- 0101: an ask is still only for the app's own app-runtime device and never a
-- file-access request; on a recovery it can name nothing but the recovered
-- collection.
ALTER TABLE installation_device_pairings DROP CONSTRAINT installation_private_device_shape;
ALTER TABLE installation_device_pairings
  ADD CONSTRAINT installation_private_device_shape CHECK ((
    array_position(approved_private_device_collection_ids, NULL) IS NULL
    AND NOT (approved_private_device_collection_ids && approved_collection_ids)
    AND CASE WHEN requested_private_device
      THEN kind = 'app-runtime' AND file_access_collection_id IS NULL
        AND (recovery_collection_id IS NULL OR approved_private_device_collection_ids <@ ARRAY[recovery_collection_id])
      ELSE approved_private_device_collection_ids = '{}'::uuid[] END
  ) IS TRUE);

-- 0080: the Hosted singleton and the zero-content Native variant stay exact and
-- carry no device scope; the zero-content variant may instead be the recovered
-- collection as the one device scope.
ALTER TABLE installation_device_pairings DROP CONSTRAINT installation_recovery_scope;
ALTER TABLE installation_device_pairings ADD CONSTRAINT installation_recovery_scope CHECK (
  recovery_collection_id IS NULL OR (
    NOT requested_create_collections AND NOT approved_create_collections
    AND file_access_collection_id IS NULL AND created_collection_ids='{}'::uuid[]
    AND (
      (approved_session_epoch IS NULL AND approved_collection_ids='{}'::uuid[] AND selected_collection_id IS NULL
        AND approved_private_device_collection_ids='{}'::uuid[])
      OR (approved_session_epoch IS NOT NULL AND approved_collection_ids=ARRAY[recovery_collection_id]
          AND selected_collection_id IS NOT DISTINCT FROM recovery_collection_id
          AND approved_private_device_collection_ids='{}'::uuid[])
      OR (approved_session_epoch IS NOT NULL AND approved_collection_ids='{}'::uuid[] AND selected_collection_id IS NULL
          AND (approved_private_device_collection_ids='{}'::uuid[] OR approved_private_device_collection_ids=ARRAY[recovery_collection_id]))
    )
  )
);

-- 0080's deferred check: a zero-content recovery approval needs its committed
-- Native choice, unless it is the recovered collection as the one device scope.
CREATE OR REPLACE FUNCTION installation_native_recovery_complete() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF child.requested_private_device AND child.selected_collection_id IS NULL AND parent.approved_at IS NOT NULL
    AND child.approved_private_device_collection_ids=ARRAY[child.recovery_collection_id] THEN RETURN NULL; END IF;
  IF child.selected_collection_id IS NOT NULL OR parent.approved_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM installation_native_authorizations n
      JOIN authorization_requests ar ON ar.id=n.authorization_request_id AND ar.grant_id=n.grant_id
      JOIN grants g ON g.id=n.grant_id
    WHERE n.pairing_id=original_request AND n.approved_at IS NOT NULL
      AND n.selected_collection_id=child.recovery_collection_id
      AND n.account_id=parent.user_id AND ar.user_id=parent.user_id AND g.user_id=parent.user_id
      AND ar.application_id::text=child.app_id AND g.application_id::text=child.app_id
      AND g.next_collection_id=child.recovery_collection_id
  ) THEN RAISE EXCEPTION 'Recovery requires exact Hosted scope, its original committed Native choice, or its one Private device scope'
    USING ERRCODE='23514', CONSTRAINT='installation_recovery_scope'; END IF;
  RETURN NULL;
END $$;

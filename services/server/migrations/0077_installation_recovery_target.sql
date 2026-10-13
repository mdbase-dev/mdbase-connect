-- Recovery intent constrains an original request; it grants no collection access.
-- No collection FK: START is unauthenticated and must not reveal target existence.
ALTER TABLE installation_device_pairings
  ADD COLUMN recovery_collection_id uuid,
  ADD CONSTRAINT installation_recovery_scope CHECK (
    recovery_collection_id IS NULL OR (
      NOT requested_create_collections AND NOT approved_create_collections
      AND file_access_collection_id IS NULL
      AND created_collection_ids = '{}'::uuid[]
      AND (
        (approved_session_epoch IS NULL AND approved_collection_ids = '{}'::uuid[]
          AND selected_collection_id IS NULL)
        OR (approved_session_epoch IS NOT NULL
          AND approved_collection_ids = ARRAY[recovery_collection_id]
          AND selected_collection_id IS NOT DISTINCT FROM recovery_collection_id)
      )
    )
  );

CREATE FUNCTION installation_recovery_target_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recovery_collection_id IS DISTINCT FROM OLD.recovery_collection_id THEN
    RAISE EXCEPTION 'Original installation recovery target is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'installation_recovery_target_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER installation_recovery_target_immutable
BEFORE UPDATE OF recovery_collection_id ON installation_device_pairings
FOR EACH ROW EXECUTE FUNCTION installation_recovery_target_immutable();

-- Approval lives on the parent. Validate the final transaction state in both
-- directions: the producer writes child scope before parent approval, but neither
-- half may commit alone. Counterpart locks follow the producer's parent->child
-- order. Binary rollback must retain this additive intent and its constraints.
CREATE FUNCTION installation_recovery_approval_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original_request uuid;
  parent_approved boolean;
  target uuid;
  epoch bigint;
BEGIN
  IF TG_TABLE_NAME = 'pairing_requests' THEN
    original_request := NEW.id;
  ELSE
    original_request := NEW.pairing_id;
  END IF;
  SELECT approved_at IS NOT NULL INTO parent_approved
    FROM pairing_requests WHERE id = original_request FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT recovery_collection_id, approved_session_epoch INTO target, epoch
    FROM installation_device_pairings WHERE pairing_id = original_request FOR UPDATE;
  IF FOUND AND target IS NOT NULL AND parent_approved <> (epoch IS NOT NULL) THEN
    RAISE EXCEPTION 'Recovery parent approval and complete target scope must commit together'
      USING ERRCODE = '23514', CONSTRAINT = 'installation_recovery_approval_complete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER installation_recovery_parent_approval
AFTER UPDATE ON pairing_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.approved_at IS NOT NULL OR OLD.approved_at IS NOT NULL)
EXECUTE FUNCTION installation_recovery_approval_complete();

CREATE CONSTRAINT TRIGGER installation_recovery_child_approval
AFTER INSERT OR UPDATE ON installation_device_pairings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.recovery_collection_id IS NOT NULL)
EXECUTE FUNCTION installation_recovery_approval_complete();

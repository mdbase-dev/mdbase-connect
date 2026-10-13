-- Recovery intent constrains an original request; it grants no collection access.
-- No collection FK: START is unauthenticated and must not reveal target existence.
ALTER TABLE installation_device_pairings
  ADD COLUMN recovery_collection_id uuid,
  ADD CONSTRAINT installation_recovery_scope CHECK (
    recovery_collection_id IS NULL OR (
      NOT requested_create_collections AND NOT approved_create_collections
      AND file_access_collection_id IS NULL
      AND created_collection_ids = '{}'::uuid[]
      AND (approved_session_epoch IS NULL OR (
        approved_collection_ids = ARRAY[recovery_collection_id]
        AND selected_collection_id IS NOT DISTINCT FROM recovery_collection_id
      ))
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

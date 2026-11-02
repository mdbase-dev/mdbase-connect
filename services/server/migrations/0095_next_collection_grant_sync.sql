-- A grant on a native collection (grants.next_collection_id) records the sync mode
-- the user consented to. A Private grant is an offer served by the account's
-- devices after a device-signed approval; a cloud-copy grant is served by the
-- collection's hosted replica (and the account's devices). A grant is only
-- usable while the collection is still in the mode it was approved for: a mode
-- change never turns one kind of consent into the other.
ALTER TABLE grants ADD COLUMN next_collection_sync text;

-- Every native grant before this migration was approved (or carried over) for a
-- Private collection: each path that wrote next_collection_id required it.
UPDATE grants SET next_collection_sync = 'private' WHERE next_collection_id IS NOT NULL;

ALTER TABLE grants ADD CONSTRAINT grants_next_collection_sync_target CHECK (
  (next_collection_id IS NULL AND next_collection_sync IS NULL)
  OR (next_collection_id IS NOT NULL AND next_collection_sync IS NOT NULL
      AND next_collection_sync IN ('private', 'cloud_copy'))
);

-- mdbase:next-grant-mode-revoke-trigger:v1
-- When a collection's sync mode changes, its native grants approved for another
-- mode are revoked in the SAME transaction. Revoking a grant queues its log
-- grant-revoke through next_revoke_grant_binding (migration 0057), so the policy
-- outbox carries the revocation to the collection's log and the hosted replica
-- and devices stop admitting it too. A mode switch to a cloud copy changes the
-- mode before it queues the cloud-copy collection state, so the revocation
-- reaches the log first. Already-revoked grants are untouched: rerunning the
-- change, or a retry after a crash, queues nothing twice.
CREATE FUNCTION next_revoke_grants_on_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revoked_grant uuid;
BEGIN
  FOR revoked_grant IN
    UPDATE grants
    SET revoked_at = now(),
        reauthorization_required_at = COALESCE(reauthorization_required_at, now()),
        reauthorization_reason = 'collection_mode_changed'
    WHERE next_collection_id = NEW.collection_id AND revoked_at IS NULL
      AND next_collection_sync IS DISTINCT FROM NEW.sync
    RETURNING id
  LOOP
    UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = revoked_grant;
    UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = revoked_grant;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER next_collection_mode_revokes_grants AFTER UPDATE OF sync ON next_collections
  FOR EACH ROW WHEN (OLD.sync IS DISTINCT FROM NEW.sync)
  EXECUTE FUNCTION next_revoke_grants_on_mode_change();

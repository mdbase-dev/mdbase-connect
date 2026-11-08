-- mdbase:next-grant-revoke-trigger:v1
-- Log-bound revocations confirm when the grant-revoke appends. A native grant
-- without an active binding has nothing to append, so its revocation is complete
-- in this transaction. A grant restored to its legacy target has a retired
-- binding whose log revoke is unrelated to this revocation, so it drops the
-- binding and waits for its connector acknowledgement.
CREATE OR REPLACE FUNCTION next_revoke_grant_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding next_grant_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.revoked_at IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO binding FROM next_grant_bindings WHERE grant_id = OLD.id AND active FOR UPDATE;
  IF FOUND THEN
    INSERT INTO next_policy_outbox(collection_id, ops)
    VALUES(binding.collection_id, jsonb_build_object('version', 1, 'ops', jsonb_build_array(
      jsonb_build_object('op', 'grant-revoke', 'grant', binding.log_grant_id::text))));
    UPDATE next_grant_bindings SET active = false WHERE grant_id = OLD.id;
  ELSIF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL THEN
    IF NEW.next_collection_id IS NOT NULL THEN
      NEW.revocation_confirmed_at := now();
    ELSE
      DELETE FROM next_grant_bindings WHERE grant_id = OLD.id;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Native revocations were reported complete without a confirmation timestamp.
-- Keep the ones whose outcome is already known complete.
UPDATE grants g SET revocation_confirmed_at = p.appended_at
FROM next_grant_bindings b, next_policy_outbox o, next_policy_batches p
WHERE b.grant_id = g.id AND o.collection_id = b.collection_id AND p.id = o.batch_id
  AND p.state = 'appended' AND g.revoked_at IS NOT NULL AND g.revocation_confirmed_at IS NULL
  AND o.ops->'ops' @> jsonb_build_array(jsonb_build_object('op', 'grant-revoke', 'grant', b.log_grant_id::text));

UPDATE grants g SET revocation_confirmed_at = g.revoked_at
WHERE g.next_collection_id IS NOT NULL AND g.revoked_at IS NOT NULL AND g.revocation_confirmed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM next_grant_bindings b WHERE b.grant_id = g.id);
